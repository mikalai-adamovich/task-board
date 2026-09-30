import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { CreateTaskRelationshipSchema } from '../schemas/task-relationship.js';
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

export function createTaskRelationshipRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * The task is addressed by a bare id, so the service resolves it and
   * tenant-asserts its owning project before reading any relationship.
   */
  router.get('/tasks/:taskId/relationships', async (c) => {
    const taskId = param(c, 'taskId');
    const relationships = await c.get('svc').relationships.getRelationshipsByTask(taskId, callerContext(c));

    return c.json({ data: relationships });
  });

  /**
   * Authorization (manage_task_relationships) is enforced inside the service
   * after the source task's project is resolved — the route path carries no
   * projectId.
   */
  router.post('/tasks/:taskId/relationships', validateBody(CreateTaskRelationshipSchema), async (c) => {
    const taskId = param(c, 'taskId');
    const body = c.req.valid('json');
    const relationship = await c.get('svc').relationships.createRelationship(taskId, body, callerContext(c));

    return c.json({ data: relationship }, 201);
  });

  /**
   * Authorization (manage_task_relationships) is enforced inside the service.
   */
  router.delete('/task-relationships/:relationshipId', async (c) => {
    const relationshipId = param(c, 'relationshipId');

    await c.get('svc').relationships.deleteRelationship(relationshipId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
