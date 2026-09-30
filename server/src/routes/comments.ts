import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { CreateCommentSchema, UpdateCommentSchema } from '../schemas/comment.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It is taken from the request context set by the auth /
 * tenant-context middleware — never from the path or the body — and the
 * service treats it as required (missing → 401, foreign tenant → 404).
 *
 * The audit context (`{ tenantId, projectId }`) that the route used to
 * assemble by hand is now derived INSIDE the service from the tenant-asserted
 * task, so a route can no longer supply a mismatched project.
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createCommentRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * Bare task ids are tenant-asserted inside the service, and
   * authorization (create_comment / edit_comment / delete_comment) is enforced
   * there after the task's project is resolved — the route paths carry no
   * projectId.
   */
  router.get('/tasks/:taskId/comments', async (c) => {
    const taskId = param(c, 'taskId');
    const comments = await c.get('svc').comments.getCommentsByTask(taskId, callerContext(c));

    return c.json({ data: comments });
  });

  router.post('/tasks/:taskId/comments', validateBody(CreateCommentSchema), async (c) => {
    const taskId = param(c, 'taskId');
    const body = c.req.valid('json');
    const comment = await c.get('svc').comments.createComment(taskId, body, callerContext(c));

    return c.json({ data: comment }, 201);
  });

  router.patch('/comments/:commentId', validateBody(UpdateCommentSchema), async (c) => {
    const commentId = param(c, 'commentId');
    const body = c.req.valid('json');
    const comment = await c.get('svc').comments.updateComment(commentId, body, callerContext(c));

    return c.json({ data: comment });
  });

  router.delete('/comments/:commentId', async (c) => {
    const commentId = param(c, 'commentId');

    await c.get('svc').comments.deleteComment(commentId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
