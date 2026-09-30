import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  CreateTaskTypeSchema,
  UpdateTaskTypeSchema,
  DeleteTaskTypeSchema,
  ReorderTaskTypeSchema,
} from '../schemas/task-type.js';
import type { CallerContext } from '../services/tenant-assert.js';

// ─── TaskType Routes ─────────────────────────────────────────────────────────

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It comes from the request context set by the auth / tenant-context
 * middleware — never from the path or the body — and the service treats it as
 * required (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createTaskTypeRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/task-types — List task types for a project.
   */
  router.get('/projects/:projectId/task-types', async (c) => {
    const projectId = param(c, 'projectId');
    const taskTypes = await c.get('svc').taskTypes.getTaskTypesByProject(projectId, callerContext(c));

    return c.json({ data: taskTypes });
  });

  /**
   * POST /projects/:projectId/task-types — Create a task type.
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.post(
    '/projects/:projectId/task-types',
    requirePermission('edit_project_config', true),
    validateBody(CreateTaskTypeSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const taskType = await c.get('svc').taskTypes.createTaskType(projectId, body, callerContext(c));

      return c.json({ data: taskType }, 201);
    },
  );

  /**
   * PATCH /projects/:projectId/task-types/reorder — Reorder task types in one bulk pass.
   * Coarse gate at the route, fine-grained re-check inside the service.
   */
  router.patch(
    '/projects/:projectId/task-types/reorder',
    requirePermission('edit_project_config', true),
    validateBody(ReorderTaskTypeSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const taskTypes = await c.get('svc').taskTypes.reorder(projectId, body.items, callerContext(c));

      return c.json({ data: taskTypes });
    },
  );

  /**
   * PATCH /task-types/:taskTypeId — Update a task type.
   * Authorization (edit_project_config) is enforced inside the service after
   * the task type's project is resolved — the route path carries no projectId.
   */
  router.patch('/task-types/:taskTypeId', validateBody(UpdateTaskTypeSchema), async (c) => {
    const taskTypeId = param(c, 'taskTypeId');
    const body = c.req.valid('json');
    const taskType = await c.get('svc').taskTypes.updateTaskType(taskTypeId, body, callerContext(c));

    return c.json({ data: taskType });
  });

  /**
   * DELETE /task-types/:taskTypeId — Delete a task type (with optional replacement via body).
   * Authorization (edit_project_config) is enforced inside the service.
   */
  router.delete('/task-types/:taskTypeId', validateBody(DeleteTaskTypeSchema), async (c) => {
    const taskTypeId = param(c, 'taskTypeId');
    const body = c.req.valid('json');

    await c.get('svc').taskTypes.deleteTaskType(taskTypeId, body.replacementTypeId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
