import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateQuery } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { NotFoundError } from '../errors/app-error.js';
import { AuditQuerySchema } from '../schemas/audit.js';
import type { AuditQueryOptions } from '../repositories/audit-event.repository.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * The caller context is derived from the request (auth + tenant-context
 * middleware) — never from the `:tenantId` path parameter.
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createAuditRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/audit — List audit events for a project.
   * Events are enriched with human-readable labels (entityLabel +
   * per-change oldLabel/newLabel) so the UI never renders raw UUIDs.
   *
   * The tenant is no longer taken from the URL. The project is resolved
   * through `ProjectService.getProject(id, context)`, which tenant-asserts it
   * and answers 404 for a project of another tenant, and the `view_audit_events`
   * permission — defined in the RBAC matrix but, until now, enforced nowhere —
   * is applied by the route-level `requirePermission` gate.
   *
   * Reading of the matrix: `view_audit_events` is PROJECT_ADMIN-only at project
   * level, with a tenant OWNER/ADMIN bypass.
   *
   * `tenantContextMiddleware` now resolves `projectRole` on GET as well, so
   * a tenant MEMBER who is a PROJECT_ADMIN of THIS project is allowed to read
   * its audit log, and a tenant MEMBER who is not a project member is still
   * denied 403. Before that fix the project-level permission was evaluated with
   * `projectRole === null` on every read, i.e. "tenant OWNER/ADMIN only".
   */
  // validateQuery throws ValidationError → the standard
  // `{ error: { code, message } }` envelope (raw zValidator returned a plain 400).
  router.get(
    '/projects/:projectId/audit',
    requirePermission('view_audit_events', true),
    validateQuery(AuditQuerySchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const query = c.req.valid('query');

      // Tenant assertion (404 for a foreign/unknown project) before any read.
      await c.get('svc').projects.getProject(projectId, callerContext(c));

      const options: AuditQueryOptions = {
        page: query.page,
        limit: query.limit,
        entityType: query.entityType,
        entityId: query.entityId,
        action: query.action,
        actorId: query.actorId,
        sort: query.sort,
      };
      const result = await c.get('svc').audit.queryByProject(projectId, options);

      return c.json({ data: result.data, pagination: result.pagination });
    },
  );

  /**
   * GET /tenants/:tenantId/audit — List audit events for a tenant.
   *
   * `:tenantId` used to be trusted verbatim, so any authenticated member
   * of ANY tenant could read the activity log of an arbitrary tenant
   * (production proof: unrelated tenant MEMBER → 200). The tenant is now taken
   * from the request context; a path tenant that does not match is answered
   * with 404 (not 403) so it stays indistinguishable from an unknown tenant.
   *
   * `view_audit_events` is enforced through the RBAC matrix: at tenant scope
   * there is no project role, so only tenant OWNER/ADMIN pass.
   */
  router.get(
    '/tenants/:tenantId/audit',
    requirePermission('view_audit_events'),
    validateQuery(AuditQuerySchema),
    async (c) => {
      const context = callerContext(c);
      const requestedTenantId = param(c, 'tenantId');

      if (requestedTenantId !== context.tenantId) {
        throw new NotFoundError('Tenant not found');
      }

      const query = c.req.valid('query');
      const options: AuditQueryOptions = {
        page: query.page,
        limit: query.limit,
        entityType: query.entityType,
        entityId: query.entityId,
        action: query.action,
        actorId: query.actorId,
        sort: query.sort,
      };
      // The tenant argument is the CONTEXT tenant, never the path one.
      const result = await c.get('svc').audit.queryByTenant(context.tenantId, options);

      return c.json({ data: result.data, pagination: result.pagination });
    },
  );

  return router;
}
