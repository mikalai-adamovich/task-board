import { Hono } from 'hono';
import type { Context } from 'hono';
import { decodeCommentCursor, InvalidCommentCursorError, type CommentPageCursor } from '@task-board/shared';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody, validateQuery } from '../middleware/validation.js';
import { CreateCommentSchema, CommentPageQuerySchema, UpdateCommentSchema } from '../schemas/comment.js';
import { ValidationError } from '../errors/app-error.js';
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
   * The `:taskId` is resolved through the ONE shared resolver before it reaches
   * the comment service, because the parameter schema accepts both a UUID and
   * `KEY-NUMBER` — a comment route that only understood the UUID form 404'd on
   * a form the API had already declared legal.
   *
   * Authorization (create_comment / edit_comment / delete_comment) is enforced
   * inside the service after the task's project is resolved — the route paths
   * carry no projectId, and a resolved task id is tenant-asserted there.
   */
  /**
   * GET /tasks/:taskId/comments — one page of the thread, newest window first.
   *
   * The envelope is the `{ data, pagination }` pair the task and audit lists
   * already use, with cursor semantics instead of page numbers: `limit` (default
   * and maximum `COMMENT_PAGE_SIZE`), `hasMore` and the opaque `nextCursor` to
   * pass back as `?cursor=`. There is no `total`: counting a thread is itself
   * an unbounded read of a collection that is open-ended by design, and the
   * board made the same call for the same reason.
   *
   * A malformed cursor is a 400 in the standard `VALIDATION_ERROR` envelope —
   * decoded here, next to the query validation, rather than inside the service
   * so a bad query parameter can never surface as a 500.
   */
  router.get('/tasks/:taskId/comments', validateQuery(CommentPageQuerySchema), async (c) => {
    const taskId = await c.get('svc').tasks.resolveTaskId(param(c, 'taskId'), callerContext(c));
    const q = c.req.valid('query');
    let cursor: CommentPageCursor | undefined;

    if (q.cursor !== undefined) {
      try {
        cursor = decodeCommentCursor(q.cursor);
      } catch (err) {
        if (err instanceof InvalidCommentCursorError) {
          throw new ValidationError('Invalid comment cursor');
        }

        throw err;
      }
    }

    const page = await c.get('svc').comments.getCommentsByTask(taskId, { limit: q.limit, cursor }, callerContext(c));

    return c.json({
      data: page.comments,
      pagination: { limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
    });
  });

  router.post('/tasks/:taskId/comments', validateBody(CreateCommentSchema), async (c) => {
    const taskId = await c.get('svc').tasks.resolveTaskId(param(c, 'taskId'), callerContext(c));
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
