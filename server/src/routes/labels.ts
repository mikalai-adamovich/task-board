import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { CreateLabelSchema, UpdateLabelSchema } from '../schemas/label.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It is taken from the request context set by the auth /
 * tenant-context middleware — never from the path or the body — and the
 * service treats it as required (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createLabelRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  router.get('/projects/:projectId/labels', async (c) => {
    const projectId = param(c, 'projectId');
    const labels = await c.get('svc').labels.getLabelsByProject(projectId, callerContext(c));

    return c.json({ data: labels });
  });

  /**
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.post(
    '/projects/:projectId/labels',
    requirePermission('manage_labels', true),
    validateBody(CreateLabelSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const label = await c.get('svc').labels.createLabel(projectId, body, callerContext(c));

      return c.json({ data: label }, 201);
    },
  );

  /**
   * Authorization (manage_labels) is enforced inside the service after the
   * label's project is resolved — the route path carries no projectId.
   */
  router.patch('/labels/:labelId', validateBody(UpdateLabelSchema), async (c) => {
    const labelId = param(c, 'labelId');
    const body = c.req.valid('json');
    const label = await c.get('svc').labels.updateLabel(labelId, body, callerContext(c));

    return c.json({ data: label });
  });

  /**
   * Authorization (manage_labels) is enforced inside the service.
   */
  router.delete('/labels/:labelId', async (c) => {
    const labelId = param(c, 'labelId');

    await c.get('svc').labels.deleteLabel(labelId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
