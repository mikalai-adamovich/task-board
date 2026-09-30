import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { CreateStatusSchema, UpdateStatusSchema, DeleteStatusSchema, ReorderStatusSchema } from '../schemas/status.js';
import type { CallerContext } from '../services/tenant-assert.js';

// ─── Status Routes ───────────────────────────────────────────────────────────

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It comes from the request context set by the auth / tenant-context
 * middleware — never from the path or the body — and the service treats it as
 * required (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createStatusRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/statuses — List statuses for a project.
   */
  router.get('/projects/:projectId/statuses', async (c) => {
    const projectId = param(c, 'projectId');
    const statuses = await c.get('svc').statuses.getStatusesByProject(projectId, callerContext(c));

    return c.json({ data: statuses });
  });

  /**
   * POST /projects/:projectId/statuses — Create a status.
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.post(
    '/projects/:projectId/statuses',
    requirePermission('manage_statuses', true),
    validateBody(CreateStatusSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const status = await c.get('svc').statuses.createStatus(projectId, body, callerContext(c));

      return c.json({ data: status }, 201);
    },
  );

  /**
   * PATCH /projects/:projectId/statuses/reorder — Reorder statuses in one bulk pass.
   */
  router.patch(
    '/projects/:projectId/statuses/reorder',
    requirePermission('manage_statuses', true),
    validateBody(ReorderStatusSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const statuses = await c.get('svc').statuses.reorder(projectId, body.items, callerContext(c));

      return c.json({ data: statuses });
    },
  );

  /**
   * PATCH /statuses/:statusId — Update a status.
   */
  // Authorization (manage_statuses) is enforced inside the service after the
  // status's project is resolved — the route path carries no projectId.
  router.patch('/statuses/:statusId', validateBody(UpdateStatusSchema), async (c) => {
    const statusId = param(c, 'statusId');
    const body = c.req.valid('json');
    const status = await c.get('svc').statuses.updateStatus(statusId, body, callerContext(c));

    return c.json({ data: status });
  });

  /**
   * DELETE /statuses/:statusId — Delete a status (with optional replacement via body).
   */
  router.delete('/statuses/:statusId', validateBody(DeleteStatusSchema), async (c) => {
    const statusId = param(c, 'statusId');
    const body = c.req.valid('json');

    await c.get('svc').statuses.deleteStatus(statusId, body.replacementStatusId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
