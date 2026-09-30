/**
 * THE UNIFORM RULE: on a project-scoped route, the TENANT check
 * runs BEFORE the role gate.
 *
 * ── What was undefined ───────────────────────────────────────────────────────
 * `AGENTS.md` states the rule as "a cross-tenant id yields 404, not 403", and
 * every project-scoped service enforces it — `assertProjectInTenant` throws
 * `NotFoundError` before any role check. But those services run AFTER the
 * route's `requirePermission(...)` middleware, and that middleware throws
 * `ForbiddenError` the moment the caller's role does not permit the action. So
 * on the permission-gated routes the observable answer was 403 whenever the
 * caller's role was insufficient — decided by the caller's ROLE, not by whether
 * the project exists. That is not an information leak today (a role the caller
 * lacks yields 403 whether or not the project is real), but it is exactly the
 * shape that BECOMES a leak the first time a check is made existence-sensitive,
 * and nothing recorded which ordering was intended. The guardrail accepted
 * 401, 403 and 404 alike, so it could not catch the drift in either direction.
 *
 * The owner has now decided: ONE rule, tenant check first.
 *
 * ── What this middleware does ────────────────────────────────────────────────
 * For a request whose path names a project (`/api/projects/:projectId/...`), it
 * resolves that project through the PROJECT SERVICE and lets the service's own
 * `assertProjectInTenant` answer: 404 for a project of another tenant or one
 * that does not exist, identical either way. The role gate has not run yet, so
 * it cannot pre-empt the 404 with a 403.
 *
 * It runs for the whole tenant-scoped sub-app, mounted once, so the rule is a
 * property of the pipeline rather than a property each of thirteen routes
 * remembers. A route added later inherits it and cannot forget it — the same
 * argument that put the rate limiter and the path-parameter validation where
 * they are.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 * • It does not resolve entities addressed by their own id (`/tasks/:taskId`).
 *   Those have no project in the path; the owning project is resolved by the
 *   service, which already asserts the tenant before the role check. Widening
 *   this to them would mean a second lookup of the same entity for no change in
 *   the answer.
 * • It does not exempt tenant admins. A tenant OWNER asking for another
 *   tenant's project gets 404 from here rather than 200-from-the-bypass: the
 *   bypass is a ROLE decision, and the question "does this project belong to
 *   you" is a different one that has to be answered first.
 * • It does not change `/api/projects/by-key/:key`, which is addressed by key,
 *   not by project id, and whose repository query already carries the caller's
 *   tenant — so it can only ever match the caller's own project.
 */
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types/context.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * Matches a project-scoped request path and captures the project id.
 *
 * `by-key` is excluded explicitly: `/api/projects/by-key/:key` shares the
 * prefix but addresses a project by KEY, so the captured segment there is a
 * literal, not an id. Without the exclusion this middleware would look up a
 * project whose id is the string "by-key", find nothing, and 404 a route that
 * works — a failure that would look like a security fix rather than a bug.
 */
const PROJECT_PATH_PATTERN = /^\/api\/projects\/(?!by-key(?:\/|$))([^/]+)(?:\/|$)/;

/**
 * The caller context every project-scoped service method requires
 * (`services/tenant-assert.ts`). Built from the request context, never from a
 * path or body value — the whole point of the seam.
 */
function callerContext(c: { get: (key: 'tenantId' | 'userId' | 'tenantRole') => string }): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

/**
 * The project id a request path names, or `null` when it names none.
 *
 * Exported for the guardrail, which asserts the same rule against the route
 * table rather than only through the running app: a route the pattern stops
 * matching would silently lose the tenant check, and the table is what proves
 * which routes the rule covers.
 */
export function projectIdFromPath(path: string): string | null {
  const match = PROJECT_PATH_PATTERN.exec(path);
  // `noUncheckedIndexedAccess`: the capture is `string | undefined`, and under
  // `exactOptionalPropertyTypes` that must not flow onward as a value. An empty
  // capture cannot happen for a path this middleware is mounted on, but a
  // projectId of `''` would address a real document, so the check stays.
  const projectId = match?.[1];

  return projectId !== undefined && projectId.length > 0 ? projectId : null;
}

/**
 * Resolve the project named in the path and prove it belongs to the caller's
 * tenant — BEFORE any role gate can answer.
 *
 * Mounted on the tenant-scoped sub-app immediately after
 * `tenantContextMiddleware`, which is what guarantees `tenantId` / `userId` /
 * `tenantRole` are set: a request that reached this without a tenant context was
 * already rejected there. The assertion itself lives in the service
 * (`ProjectService.getProject` → `assertProjectInTenant`), so this middleware
 * owns the ORDERING and nothing else — it does not re-implement the tenant
 * check, which is what keeps a second implementation from drifting.
 */
export const projectTenantGuard = createMiddleware<AppEnv>(async (c, next) => {
  const projectId = projectIdFromPath(c.req.path);

  if (projectId !== null) {
    // The return value is deliberately discarded: this call exists for its
    // assertion (404 on a foreign or unknown project). The route's own service
    // method re-reads the project, which is one indexed `findOne` on a field
    // that is already unique — cheaper than a cache whose invalidation rules
    // would be a second source of truth about who may see what.
    await c.get('svc').projects.getProject(projectId, callerContext(c));
  }

  await next();
});
