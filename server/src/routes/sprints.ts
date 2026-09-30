import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { CreateSprintSchema, UpdateSprintSchema } from '../schemas/sprint.js';
import type { CallerContext } from '../services/tenant-assert.js';

// ─── Sprint Routes ───────────────────────────────────────────────────────────

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It comes from the request context set by the auth / tenant-context
 * middleware — never from the path or the body — and the service treats it as
 * required (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createSprintRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/sprints — List sprints for a project.
   */
  router.get('/projects/:projectId/sprints', async (c) => {
    const projectId = param(c, 'projectId');
    const sprints = await c.get('svc').sprints.getSprintsByProject(projectId, callerContext(c));

    return c.json({ data: sprints });
  });

  /**
   * POST /projects/:projectId/sprints — Create a sprint.
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.post(
    '/projects/:projectId/sprints',
    requirePermission('create_sprint', true),
    validateBody(CreateSprintSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const sprint = await c.get('svc').sprints.createSprint(projectId, body, callerContext(c));

      return c.json({ data: sprint }, 201);
    },
  );

  /**
   * GET /sprints/:sprintId — Get sprint details.
   */
  router.get('/sprints/:sprintId', async (c) => {
    const sprintId = param(c, 'sprintId');
    // Bare sprint ids are tenant-asserted inside the service
    const sprint = await c.get('svc').sprints.getSprint(sprintId, callerContext(c));

    return c.json({ data: sprint });
  });

  /**
   * PATCH /sprints/:sprintId — Update sprint (name, dates, status).
   */
  // Authorization (change_sprint_status) is enforced inside the service after
  // the sprint's project is resolved — the route path carries no projectId.
  router.patch('/sprints/:sprintId', validateBody(UpdateSprintSchema), async (c) => {
    const sprintId = param(c, 'sprintId');
    const body = c.req.valid('json');
    const sprint = await c.get('svc').sprints.updateSprint(sprintId, body, callerContext(c));

    return c.json({ data: sprint });
  });

  /**
   * DELETE /sprints/:sprintId — Delete sprint (tasks → backlog).
   */
  router.delete('/sprints/:sprintId', async (c) => {
    const sprintId = param(c, 'sprintId');

    await c.get('svc').sprints.deleteSprint(sprintId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
