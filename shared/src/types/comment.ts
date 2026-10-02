import type { IdentitySnapshot } from './tenant.js';

/** Comment entity type */
export interface Comment {
  /** Unique comment identifier (UUID v4) */
  id: string;
  /** Parent task ID */
  taskId: string;
  /** User ID of the comment author (null if user was deleted) */
  authorId: string | null;
  /** Denormalized author identity at time of comment creation */
  authorSnapshot: IdentitySnapshot;
  /** Comment body (markdown) */
  body: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * One page of a task's comment thread (`GET /api/tasks/:taskId/comments`).
 *
 * The thread is walked from the NEWEST comment backwards, but each page is
 * returned OLDEST-FIRST inside itself, so a client renders a page in the order
 * it arrives and appends the next (older) page above what it already has.
 * `nextCursor` is the opaque resume key for that next page; it is `null` exactly
 * when `hasMore` is false.
 */
export interface CommentPage {
  /** The page's comments, oldest first, at most `COMMENT_PAGE_SIZE`. */
  comments: Comment[];
  /** Whether older comments exist beyond this page (server state, from the probe row). */
  hasMore: boolean;
  /** Opaque cursor for the next (older) page — pass it back verbatim as `?cursor=`. */
  nextCursor: string | null;
  /** The page size this response was produced with. */
  limit: number;
}

/** Create comment request body type */
export interface CreateComment {
  body: string;
}

/** Update comment request body type */
export interface UpdateComment {
  body: string;
}
