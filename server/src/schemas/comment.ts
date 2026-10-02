import * as z from 'zod';
import { COMMENT_CURSOR_MAX_LENGTH, COMMENT_PAGE_SIZE } from '@task-board/shared';
import { nonEmptyString } from '../validators/common.js';

export const CreateCommentSchema = z.object({
  body: nonEmptyString(5000, 'Comment body'),
});

export const UpdateCommentSchema = z.object({
  body: nonEmptyString(5000, 'Comment body'),
});

/**
 * Query for one page of a task's comment thread.
 *
 * `limit` is a PAGE size and is rejected above `COMMENT_PAGE_SIZE` rather than
 * silently clamped, for the same reason `TaskQuerySchema.limit` is: a silently
 * capped response disagrees with the request that asked for it, and a client
 * cannot tell a capped page from a genuinely short one — it would keep paging
 * as though rows were missing. A 400 naming the maximum tells it exactly what
 * to change. The route decodes `cursor` (a malformed one is also a 400, with the
 * same `VALIDATION_ERROR` envelope), so Zod bounds only what it can judge:
 * presence and length.
 */
export const CommentPageQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COMMENT_PAGE_SIZE, `limit must be <= ${COMMENT_PAGE_SIZE}`)
    .optional()
    .default(COMMENT_PAGE_SIZE),
  cursor: z.string().min(1).max(COMMENT_CURSOR_MAX_LENGTH).optional(),
});
