import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { connectMongo } from '../db/mongo.js';
import { inspectConfiguration } from '../config/runtime-config.js';
import type { ConfigurationVerdict } from '../config/runtime-config.js';
import type { AppEnv } from '../types/context.js';
import { describeRateLimitScope, resolveRateLimitScope } from '../utils/rate-limit-scope.js';
import { LOGIN_RATE_LIMIT_MAX_REQUESTS } from '../services/auth.service.js';

/**
 * Readiness probe: `GET /api/readyz`.
 *
 * Unlike `/api/health` (liveness), this verifies the database is actually
 * reachable: it opens a **fresh** connection (Workers kill sockets between
 * requests, so a stale cached client would lie), pings it with a short
 * timeout, and closes the client. That fresh-connection behaviour is kept —
 * what changed is how OFTEN it happens (see below).
 *
 * The route is mounted BEFORE the DB middleware on purpose — readiness must
 * not depend on migrations having succeeded, and it manages its own
 * short-lived client instead of the request-scoped Db context.
 *
 * Responses follow the standard envelope:
 * - 200 `{ status: 'ok', configuration }`
 * - 503 `{ error: { code: 'DB_UNAVAILABLE', message } }` (empty URI, connect
 *   failure, ping failure or timeout)
 *
 * The response also carries the CONFIGURATION verdict — which of
 * `MONGODB_URI` / `JWT_SECRET` are absent — so a deployment that boots without a
 * signing secret is visible on the one endpoint a deploy probe already reads.
 * The verdict is reported alongside the database verdict and NEVER replaces it.
 * The verdict carries variable NAMES only.
 *
 * The Worker now REFUSES TO START when a required variable is missing
 * (`assertRequiredConfiguration`, called in `index.ts` and in the Durable
 * Object). This reporting half is kept anyway, and the reason is that a probe
 * which cannot run is a probe which cannot say why: the route is reachable in
 * local and test deployments, it documents the contract the boot gate enforces,
 * and the configuration verdict is recomputed on every hit rather than served
 * from the cache, so it always describes the environment actually in front of
 * the probe.
 */

/** Upper bound for the ping — must be well under typical probe timeouts. */
export const READY_PING_TIMEOUT_MS = 2_000;

/**
 * How long a computed DATABASE verdict is reused before the probe opens
 * another connection.
 *
 * FIVE SECONDS, and why that is safe: the verdict answers "can this deployment
 * serve traffic", not "is this millisecond healthy". Every consumer of a
 * readiness signal — an orchestrator, an uptime monitor, a rolling-deploy gate —
 * polls on a scale of seconds to tens of seconds, so a verdict at most 5 s old
 * is indistinguishable from a fresh one for the decision the probe exists to
 * inform. A database that dies at second 4 is reported at second 5; a
 * deployment that recovers is reported within 5 s of recovery. Neither delay
 * is one a caller could act on differently, and both are far inside the
 * {@link READY_PING_TIMEOUT_MS} budget a caller already tolerates.
 *
 * WHY A CACHE AND NOT THE POOLED CLIENT (the shared-client option was rejected):
 * reusing the request-scoped / Durable-Object pool would couple the probe to
 * the production topology, and the probe must keep working in EVERY deployment
 * mode — `per-request`, `durable` and the local `singleton` experiment each own
 * the pool differently. A short TTL is mode-independent by construction: it
 * removes the per-hit handshake without the probe learning anything about who
 * owns the pool.
 */
export const READY_VERDICT_TTL_MS = 5_000;

/**
 * The database half of the answer, decoupled from HTTP so a cached entry is a
 * plain value with no `Response` and no Hono context that a later layer could
 * mutate or reuse.
 */
export type DatabaseVerdict = { ok: true } | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The cached database verdict: the value, the instant it stops being usable,
 * and the environment it was computed for.
 *
 * `envKey` is what makes the cache safe to share. The `MONGODB_URI` VALUE is
 * deliberately not part of the key — retaining a connection string in a
 * module-level variable for the isolate's lifetime is exactly the kind of thing
 * that ends up in a heap dump. Instead the key is the CONFIGUREDNESS of the
 * URI: a hit is only reused for an environment that is configured the same way.
 * A Worker has exactly one binding, so this never produces a false miss in
 * production; in tests, where one module instance can be driven with two
 * environments, it prevents one deployment's verdict from answering another's
 * probe.
 */
interface CacheEntry {
  verdict: DatabaseVerdict;
  expiresAt: number;
  envKey: string;
}

/**
 * MODULE SCOPED, and the reason matters: the cache must be shared by every
 * request that reaches the route, and in every deployment mode the Hono app is
 * a single module instance per isolate (in `durable` mode the Durable Object
 * holds it; otherwise the Worker isolate does). A cache captured in the closure
 * of `createReadyzRoutes()` would be per-app, which is correct for the real app
 * (it calls the factory once) but is a trap for any second caller that builds
 * its own app and silently gets a permanently cold cache.
 *
 * The scope is per-isolate by nature, which is the correct scope: the probe must
 * never report another isolate's verdict, and the runtime offers no shared store
 * to put it in. A probe fanned out across several isolates may see several
 * caches, each holding a verdict at most {@link READY_VERDICT_TTL_MS} old — still
 * correct, and not something a monitor normally does.
 */
let cacheEntry: CacheEntry | null = null;

/**
 * Drop the cached verdict. Exported so a test (or an operator forcing a
 * re-probe) can start from a known state instead of inheriting one.
 */
export function resetReadinessCache(): void {
  cacheEntry = null;
}

/** Cache key for an environment: whether a URI is configured, never its value. */
function environmentKey(uri: string | undefined): string {
  return uri === undefined || uri.trim().length === 0 ? 'unconfigured' : 'configured';
}

/**
 * The cached database verdict for `envKey`, or `null` when absent, expired, or
 * computed for a different environment.
 *
 * `expiresAt <= now` (not `<`) so an entry is never served at exactly its
 * expiry instant — the boundary belongs to the miss.
 */
export function readCachedVerdict(envKey: string, now: number = Date.now()): DatabaseVerdict | null {
  if (cacheEntry === null || cacheEntry.envKey !== envKey || cacheEntry.expiresAt <= now) {
    return null;
  }

  return cacheEntry.verdict;
}

/** Store a database verdict for `ttlMs` under `envKey`. */
export function writeCachedVerdict(envKey: string, verdict: DatabaseVerdict, now: number = Date.now()): void {
  cacheEntry = { verdict, expiresAt: now + READY_VERDICT_TTL_MS, envKey };
}

/** Ping the database, rejecting if it does not answer within `timeoutMs`. */
export async function pingDatabase(db: Db, timeoutMs: number = READY_PING_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Database ping timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Probe the database: connect fresh, ping with a bounded timeout, close.
 *
 * Split out from the route so the cache can wrap exactly this step — the
 * connection handshake is what the TTL exists to avoid, and nothing else in the
 * route is expensive.
 */
export async function probeDatabase(uri: string): Promise<DatabaseVerdict> {
  try {
    const { client, db } = await connectMongo(uri);

    try {
      await pingDatabase(db);
    } finally {
      client.close().catch(() => {
        /* swallow — socket may already be dead */
      });
    }

    return { ok: true };
  } catch {
    return { ok: false, code: 'DB_UNAVAILABLE', message: 'Database is not reachable' };
  }
}

export function createReadyzRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/readyz', async (c) => {
    const uri = c.env.MONGODB_URI;
    // The configuration verdict is computed from the LIVE environment on every
    // hit, never served from the cache: it is two presence checks, and a cached
    // configuration verdict would be the one thing on this endpoint that could
    // describe a deployment other than the one being probed.
    const configuration: ConfigurationVerdict = inspectConfiguration(c.env as unknown as Record<string, unknown>);
    /**
     * The deployment's instance budget, made OBSERVABLE.
     *
     * The scope below says how many instances this deployment runs the in-process
     * limiter across. It is NOT a ceiling anything enforces: the authority counts
     * one document per bucket/scope, so the enforced ceiling is the constant
     * below in every mode, and a store that cannot answer refuses the request
     * rather than falling back to a per-instance number. `authoritativeTier` says
     * which tier enforces it. Without both fields this block would read as "this
     * deployment allows 2 logins per account per 15 minutes", which is a number no
     * request is ever held to.
     */
    const loginScope = resolveRateLimitScope(
      c.env.DB_CLIENT_MODE,
      c.env.RATE_LIMIT_INSTANCE_BUDGET,
      LOGIN_RATE_LIMIT_MAX_REQUESTS,
    );
    const rateLimit = {
      loginAttempts: describeRateLimitScope(loginScope, LOGIN_RATE_LIMIT_MAX_REQUESTS),
      mode: c.env.DB_CLIENT_MODE ?? 'per-request',
      instanceBudgetDeclared: loginScope.declared,
      // The ENFORCED ceiling, counted in MongoDB, is the constant in every mode:
      // it is one document per bucket/scope, so it cannot multiply by instances,
      // and a store that cannot decide refuses rather than enforcing a divided
      // one. `loginAttempts` above describes the instance count, not a ceiling.
      authoritativeTier: 'mongodb',
      authoritativeLoginMax: LOGIN_RATE_LIMIT_MAX_REQUESTS,
    } as const;
    const body = { status: 'ok', configuration, rateLimit } as const;

    if (!uri) {
      return c.json(
        { error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured (MONGODB_URI is empty)' } },
        503,
      );
    }

    const envKey = environmentKey(uri);
    const cached = readCachedVerdict(envKey);

    if (cached !== null) {
      return cached.ok ? c.json(body) : c.json({ error: cached }, 503);
    }

    const verdict = await probeDatabase(uri);

    writeCachedVerdict(envKey, verdict);

    return verdict.ok ? c.json(body) : c.json({ error: verdict }, 503);
  });

  return app;
}
