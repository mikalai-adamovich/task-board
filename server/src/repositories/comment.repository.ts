import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import { ObjectId, type Filter } from 'mongodb';
import type { Comment, CommentPageCursor, IdentitySnapshot } from '@task-board/shared';
import { QUERY_MAX_TIME_MS_LIST } from '../db/query-timeout.js';

export interface CommentDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  taskId: string;
  authorId: string;
  authorSnapshot: IdentitySnapshot;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Keyset window of one page: where to start and how many rows to take. */
export interface CommentPageQuery {
  /** Rows to return; the probe makes the query ask for one more than this. */
  limit: number;
  /** Omit for the newest page; supply to continue below the previous page. */
  cursor?: CommentPageCursor | undefined;
}

/**
 * One page of a thread, in reverse-traversal terms: `comments` is already
 * flipped back to reading order, `nextCursor` is the key of its OLDEST comment.
 */
export interface CommentPageResult {
  comments: Comment[];
  hasMore: boolean;
  nextCursor: CommentPageCursor | null;
}

/**
 * The keyset predicate for "everything older than the cursor comment".
 *
 * `_id` is in the key next to `createdAt` because `createdAt` is not unique: two
 * comments written in the same millisecond compare equal, and a page boundary
 * between them would otherwise make one of the two unreachable. The second
 * clause is what makes the first one exclusive rather than overlapping.
 */
function olderThan(cursor: CommentPageCursor): Filter<CommentDocument>[] {
  const createdAt = new Date(cursor.createdAtMs);

  return [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: new ObjectId(cursor.objectId) } }];
}

function toDomain(doc: CommentDocument): Comment {
  return {
    id: doc.id,
    taskId: doc.taskId,
    authorId: doc.authorId,
    authorSnapshot: doc.authorSnapshot,
    body: doc.body,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class CommentRepository extends BaseRepository<CommentDocument, Comment> {
  protected toDomain(doc: CommentDocument): Comment {
    return toDomain(doc);
  }

  /**
   * One page of a task's comments, cursor-paginated, oldest-first within the page.
   *
   * The window is queried NEWEST-FIRST (`{ createdAt: -1, _id: -1 }`) so that the
   * first page is the newest part of the thread — the part a reader opens the
   * task for — and every later page reaches further back, with no upper limit on
   * how many comments the thread may hold. The selected page is then reversed
   * before it is returned, so a client renders a page top-to-bottom in reading
   * order exactly as the previous ascending query produced it.
   *
   * `hasMore` is derived from a `limit + 1` probe row rather than from the length
   * of the page: the extra row is the only thing that can say whether older
   * comments exist, and dropping it would turn the last page into a silent
   * "there is nothing more" claim. The same probe is why this read no longer
   * needs a row bound in `db/read-bounds.ts` — `limit` is a caller-supplied PAGE
   * size, and the service hands down at most `COMMENT_PAGE_SIZE`.
   *
   * `maxTimeMS` because the list-shaped budget is what a thread read is: a page
   * is index-bounded, so a legitimate request finishes in milliseconds, and a
   * run that cannot is one worth aborting before the Worker's budget is gone.
   */
  async findPageByTask(taskId: string, query: CommentPageQuery): Promise<CommentPageResult> {
    const { cursor } = query;
    const filter: Filter<CommentDocument> = cursor ? { taskId, $or: olderThan(cursor) } : { taskId };
    const docs = await this.collection
      .find(filter, { maxTimeMS: QUERY_MAX_TIME_MS_LIST })
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const hasMore = docs.length > query.limit;
    const page = hasMore ? docs.slice(0, query.limit) : docs;
    // The resume point is the oldest comment of the SELECTED page, which is the
    // last row of the descending window — not of the probe row.
    const oldest = page[page.length - 1];

    return {
      comments: [...page].reverse().map(toDomain),
      hasMore,
      // No cursor without a successor: a page that reached the beginning of the
      // thread has nothing to resume from, and handing one back would invite a
      // client to keep asking for pages that do not exist.
      nextCursor:
        hasMore && oldest?._id instanceof ObjectId
          ? { createdAtMs: oldest.createdAt.getTime(), objectId: oldest._id.toHexString() }
          : null,
    };
  }

  async create(input: {
    taskId: string;
    authorId: string;
    authorSnapshot: IdentitySnapshot;
    body: string;
  }): Promise<Comment> {
    const now = new Date();
    const doc: CommentDocument = {
      id: randomUUID(),
      taskId: input.taskId,
      authorId: input.authorId,
      authorSnapshot: input.authorSnapshot,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async update(id: string, input: { body: string }): Promise<Comment | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { body: input.body, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.collection.deleteMany({ taskId });
  }

  /**
   * Delete all comments belonging to a set of tasks. Used for cascade delete.
   *
   * Comments are linked to tasks via `taskId` and have no `projectId` field —
   * a `{ projectId }` filter never matched anything. The project cascade
   * collects task ids first (see ProjectService.permanentDelete) and deletes
   * comments through them BEFORE the tasks themselves are removed.
   */
  async deleteByTaskIds(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;

    await this.collection.deleteMany({ taskId: { $in: taskIds } });
  }
}
