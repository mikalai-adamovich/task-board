import { Hono } from 'hono';
import { HttpMethod } from '@task-board/shared';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/context.js';
import { getMongoClient, isIoContextError, resetSharedClient, runWithDb } from './db/mongo.js';
import { scrubLogLine } from './utils/redact.js';
import { createLogger } from './utils/logger.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { requestBodyLimit } from './middleware/body-limit.js';
import { errorHandler } from './middleware/error-handler.js';
import { createNotFoundHandler } from './middleware/not-found.js';
import { createReadyzRoutes } from './routes/readyz.js';
import { authMiddleware } from './middleware/auth.js';
import { authRateLimit } from './middleware/rate-limit.js';
import { tenantContextMiddleware } from './middleware/tenant-context.js';
// The "tenant check before role gate" middleware.
import { projectTenantGuard } from './middleware/project-tenant-guard.js';
import { provideServices } from './middleware/services.js';
import { routeRegistry } from './routes/index.js';
import { createCrossTenantTaskRoutes } from './routes/tasks.js';
import { createInvitationRoutes } from './routes/invitations.js';
import { createProjectPreferencesRoutes, createUserPreferencesRoutes } from './routes/user-preferences.js';

// ─── Hono App Bootstrap ──────────────────────────────────────────────────────

const app = new Hono<AppEnv>();

// ── Global middleware (order matters) ──────────────────────────────────────────
// Request ids come FIRST so every log line and error envelope can be
// correlated. The correlation id is ALWAYS minted here, never taken from the
// caller: an id the observability stack and the audit log join on must not be a
// value the caller chooses, or one replayed id would merge unrelated activity
// into a single apparent chain. A well-formed incoming X-Request-Id is still
// RECORDED, as a separate `upstreamRequestId`, and it is what gets echoed back
// on the response header — so a gateway keeps seeing its own id come back while
// the logs and the audit trail use one this process minted. See
// `middleware/request-id.ts`.
app.use('*', requestIdMiddleware);

// The compensating security headers, on EVERY response of this tier
// (success, error and not-found alike). Mounted immediately after the request
// id — and before everything else — so a rejection raised by any later layer
// still carries them. The static tier's half is `ui/public/_headers`; the
// Content-Security-Policy is report-only on both, with the enforcing switch's
// prerequisites recorded in `middleware/security-headers.ts`.
app.use('*', securityHeaders());

// Decision 20: the application-owned request-body cap (5 MB — see
// `middleware/body-limit.ts` for why that value). Mounted on /api/* BEFORE the
// DB middleware, the service graph, auth and the zod body validators, so an
// over-sized body costs a header check and nothing else: no connection, no
// service graph, no parse. An over-sized body answers 413 in the standard
// `{ error: { code, message } }` envelope, not a bare platform error.
app.use('/api/*', requestBodyLimit());

// Scrub credentials from every log line. hono/logger's argument
// is a print function (void return), so scrub then forward to console.log.
// The scrubber masks Bearer headers AND capability tokens (the invitation
// token in `/invitations/<token>` and any `?token=` parameter), which the
// original Bearer-only rule let through in cleartext on every lookup.

app.use(
  '*',
  // eslint-disable-next-line no-console -- request logging intentionally uses stdout (hono/logger's default sink)
  logger((str) => console.log(scrubLogLine(str))),
);

// CORS middleware memoized per config value: `c.env` only exists per request,
// but ALLOWED_ORIGINS is immutable for a deployment, so we rebuild the
// middleware only when the configured value actually changes.
// Default is the local dev UI origin — NEVER `*`: production must configure
// ALLOWED_ORIGINS explicitly (a wildcard default would let any origin call
// the authenticated API).
let corsConfigCache: string | null = null;
let corsMiddleware: ReturnType<typeof cors> | null = null;
let corsWildcardWarned = false;
const corsLog = createLogger({ scope: 'cors' });

app.use('*', async (c, next) => {
  const allowedOrigins = c.env?.ALLOWED_ORIGINS ?? 'http://localhost:4200';
  const environment = c.env?.ENVIRONMENT ?? 'development';

  if (!corsMiddleware || corsConfigCache !== allowedOrigins) {
    // An explicitly configured wildcard must never reach production
    // silently. Workers have no boot phase, so the check runs when the CORS
    // config is first materialized for the deployment.
    if (allowedOrigins === '*') {
      if (environment === 'production') {
        throw new Error(
          'CORS misconfiguration: ALLOWED_ORIGINS="*" is not allowed in production — set an explicit origin list.',
        );
      }

      if (!corsWildcardWarned) {
        corsWildcardWarned = true;
        corsLog.warn(
          'ALLOWED_ORIGINS="*" — any origin can call the authenticated API. ' +
            'Set an explicit origin list before deploying to production.',
        );
      }
    }

    corsConfigCache = allowedOrigins;
    corsMiddleware = cors({
      origin: allowedOrigins === '*' ? '*' : allowedOrigins.split(',').map((o: string) => o.trim()),
      allowMethods: [...(Object.values(HttpMethod) as string[]), 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id'],
      maxAge: 86400,
    });
  }

  return corsMiddleware(c, next);
});

// ── Liveness + no-DB baselines (mounted BEFORE the DB middleware on purpose) ──
// `/api/health` is liveness: it must answer even when the database is down or
// unconfigured, so it must not sit behind the DB middleware. `/api/ping` is a
// TEMPORARY twin used by the perf experiment as the true no-DB baseline.
app.get('/api/ping', (c) => c.json({ status: 'ok' }));
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Readiness probe ───────────────────────────────────────────────────────────
// Also mounted before the DB middleware: readiness verifies that a *fresh*
// Mongo connection works. It manages its own short-lived client and never
// touches the request-scoped Db context.
app.route('/api', createReadyzRoutes());

// MongoDB client acquisition.
//
// - `DB_CLIENT_MODE=per-request` (production rollback path): a fresh client
//   per request, closed after the response.
// - `DB_CLIENT_MODE=durable`: this whole app runs INSIDE the Durable Object
//   (see do/mongo-do.ts). The DO owns its I/O context — unlike a plain
//   Worker isolate — so a module-cached client with a persistent pool is
//   safe there and is the entire point of the mode.
// - Anything else ('singleton') is the plain-Worker experiment: known broken
//   (workerd#2721, error 1101), kept only as an explicit fallback value.
//
// Migrations are NOT run here — they live in server/scripts/migrate.ts and
// are executed by CD before the deploy.
app.use('/api/*', async (c, next) => {
  const uri = c.env.MONGODB_URI;

  if (!uri) {
    // Fail fast with the standard error envelope instead of letting the
    // request proceed and fail later with confusing driver errors.
    return c.json(
      { error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured (MONGODB_URI is empty)' } },
      503,
    );
  }

  const rawMode = c.env.DB_CLIENT_MODE ?? 'per-request';
  const clientMode = rawMode === 'per-request' ? 'per-request' : 'singleton';
  const client = await getMongoClient(uri, clientMode);

  try {
    await runWithDb(client.db(), () => next());
  } catch (err) {
    // workerd binds sockets to the request context that created them; when a
    // request surfaces an I/O-context error the cached client is dead — drop
    // it so the next request builds a fresh one. Narrow check: ordinary
    // MongoDB/network errors must not churn the pool.
    if (isIoContextError(err)) {
      resetSharedClient();
    }
    throw err;
  } finally {
    // Rollback mode keeps the old semantics exactly: a fresh client per
    // request, closed after the response. Singleton/durable modes NEVER close
    // here — the pool must survive across requests.
    if (clientMode === 'per-request') {
      client.close().catch(() => {
        /* swallow — socket may already be dead */
      });
    }
  }

  // noImplicitReturns: the early DB_UNAVAILABLE path returns a Response; this
  // path falls through to the router, so it ends with an explicit bare return.
  return;
});

// Error handler
app.onError(errorHandler);

// Request-scoped service graph (must run after the DB middleware above,
// so getCollection() resolves within the request's AsyncLocalStorage context)
app.use('/api/*', provideServices);

// ── Auth routes (no tenant context or RBAC required) ──────────────────────────
app.route('/api/auth', routeRegistry.auth);

// ── Protected routes — auth required ──────────────────────────────────────────
app.use('/api/*', authMiddleware);

// ── Per-user rate limiting for every authenticated route ──────────────────────
// Mounted ONCE, immediately after authMiddleware, so the ceiling is the default:
// a route added later inherits it and cannot forget it. The key is the
// token-verified `userId` authMiddleware just set — never anything the client
// can choose. `/api/health`, `/api/ping` and `/api/readyz` are exempt (and in
// fact mounted before this point anyway), as are CORS preflights.
app.use('/api/*', authRateLimit());

// ── Tenant routes (auth only — no tenant context needed) ──────────────────────
app.route('/api/tenants', routeRegistry.tenants);

// ── Invitation routes (auth only — cross-tenant, no tenant context) ───────────
app.route('/api/invitations', createInvitationRoutes());

// ── User preferences routes (auth only — no tenant context needed) ────────────
// Only the GLOBAL preferences live here. The project-scoped ones moved
// into the tenant-scoped sub-app below — they used to run with no tenant
// context, so `:projectId` could address a project of any tenant.
app.route('/api', createUserPreferencesRoutes());

// ── Cross-tenant "My Tasks" route (auth only — no tenant context needed) ──────
app.route('/api', createCrossTenantTaskRoutes());

// ── Tenant-scoped routes (auth + tenant context required) ─────────────────────
// Use a sub-app so tenantContextMiddleware ONLY applies to these routes,
// not to preferences / invitations / tenant-management above.
const tenantScoped = new Hono<AppEnv>();

// THE UNIFORM RULE — the tenant check runs BEFORE the role gate on
// every project-scoped route. Mounted here, once, immediately after the tenant
// context and before any route's `requirePermission(...)`, so a project of
// another tenant yields 404 rather than a 403 decided by the caller's role.
// One mount, so a route added later inherits the ordering and cannot forget it.
tenantScoped.use('*', tenantContextMiddleware);
tenantScoped.use('*', projectTenantGuard);

// All route modules define full resource paths (e.g. /tasks/:taskId, /projects/:projectId/tasks)
// so they must be mounted at / — NOT at /<resource> — to avoid double-nesting.
tenantScoped.route('/projects', routeRegistry.projects);
tenantScoped.route('/', routeRegistry.boards);
tenantScoped.route('/', routeRegistry.tasks);
tenantScoped.route('/', routeRegistry.sprints);
tenantScoped.route('/', routeRegistry.statuses);
tenantScoped.route('/', routeRegistry.taskTypes);
tenantScoped.route('/', routeRegistry.labels);
tenantScoped.route('/', routeRegistry.comments);
tenantScoped.route('/', routeRegistry.taskRelationships);
tenantScoped.route('/', routeRegistry.filters);
tenantScoped.route('/', routeRegistry.audit);
// Project-scoped preferences now run behind tenantContextMiddleware and
// assert project ownership (404 for a foreign project).
tenantScoped.route('/', createProjectPreferencesRoutes());

app.route('/api', tenantScoped);

// Hono's default notFound returns a bare text/plain "404 Not Found",
// and a request whose method matches no registered route falls through to that
// same handler — so unmatched paths AND unmatched methods were the only
// responses in the API that escaped the `{ error: { code, message, requestId } }`
// envelope. Register the handler so every response uses the standard shape, and
// so a known path + wrong method answers 405 (with `Allow`) instead of a
// misleading 404. Routes are read lazily, after the whole table is registered.
app.notFound(createNotFoundHandler(() => app.routes));

export { app };

/**
 * Routing decision for the Worker entrypoint: in `durable` mode everything
 * except the no-DB liveness endpoints is proxied into the Durable Object.
 * `/api/ping` and `/api/health` must stay on the Worker so true liveness
 * never depends on the DO (or on MongoDB) being up.
 */
export function shouldProxyToDurable(mode: string | undefined, pathname: string): boolean {
  if (mode !== 'durable') {
    return false;
  }
  return pathname !== '/api/ping' && pathname !== '/api/health';
}
