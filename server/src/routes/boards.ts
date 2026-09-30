import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { UpdateBoardColumnsSchema } from '../schemas/board.js';
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

// ─── Board Routes (single-board model — doc 102) ─────────────────────────────
// A project owns exactly one board identified by its projectId. There is no
// board CRUD: the board is created with the project (seed) and deleted with it
// (cascade). The only mutations are reads and column/workflow edits.

export function createBoardRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/board — the project's single board.
   *
   * The project is tenant-asserted inside the service (404 on a
   * foreign project), so no coarse route gate is needed here.
   */
  router.get('/projects/:projectId/board', async (c) => {
    const projectId = param(c, 'projectId');
    const board = await c.get('svc').boards.getBoardByProject(projectId, callerContext(c));

    return c.json({ data: board });
  });

  /**
   * PATCH /projects/:projectId/board — update the board's columns (workflow).
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.patch(
    '/projects/:projectId/board',
    requirePermission('manage_boards', true),
    validateBody(UpdateBoardColumnsSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const board = await c.get('svc').boards.updateColumns(projectId, body, callerContext(c));

      return c.json({ data: board });
    },
  );

  return router;
}
