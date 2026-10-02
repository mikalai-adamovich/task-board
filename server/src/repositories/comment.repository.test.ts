/**
 * Comment thread pagination — the repository contract and the traversal proof.
 *
 * There is no MongoDB server in this suite (and adding one is not an option for
 * a unit gate), so the reads run against an in-memory collection that models the
 * DRIVER semantics for exactly the operators this query issues: equality, `$or`,
 * `$lt` on a `Date` and on an `ObjectId`, multi-key `sort` and `limit`. That is
 * enough to make the keyset window, the page reversal and the cursor falsifiable
 * — a defect in any of them changes which documents the model returns. What it
 * cannot show is the query PLAN; that is the index's job and it is asserted
 * against the migration list in `db/migrations.test.ts`.
 *
 * The traversal tests are the point of the change: they walk a whole thread
 * newest-to-oldest and assert that every comment appears exactly once.
 */
import { describe, it, expect } from 'vitest';
import { ObjectId, type Filter, type Sort } from 'mongodb';
import { COMMENT_PAGE_SIZE, type CommentPageCursor } from '@task-board/shared';
import { CommentRepository, type CommentDocument } from './comment.repository.js';

// ─── A collection that models the operators the query uses ────────────────────

type Doc = CommentDocument & { _id: ObjectId };
type Page = Awaited<ReturnType<CommentRepository['findPageByTask']>>;

/** The only query operator the thread read issues. */
function isLessThan(value: unknown): value is { $lt: unknown } {
  return typeof value === 'object' && value !== null && '$lt' in value;
}

/** `$lt` on a Date (epoch ms) and on an ObjectId (byte order == hex order). */
function lessThan(actual: unknown, bound: unknown): boolean {
  if (actual instanceof Date && bound instanceof Date) return actual.getTime() < bound.getTime();
  if (actual instanceof ObjectId && bound instanceof ObjectId) return actual.toHexString() < bound.toHexString();

  throw new Error(`The fake collection was asked to compare ${typeof actual} with ${typeof bound}`);
}

function matchesClause(doc: Doc, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([field, expected]) => {
    if (field === '$or') return (expected as Record<string, unknown>[]).some((entry) => matchesClause(doc, entry));
    if (field === '_id' && expected instanceof ObjectId) return doc._id.equals(expected);
    if (expected instanceof Date) return doc.createdAt.getTime() === expected.getTime();
    if (isLessThan(expected)) return lessThan(doc[field as keyof Doc], expected.$lt);

    return doc[field as keyof Doc] === expected;
  });
}

function sortDocs(docs: Doc[], spec: Sort): Doc[] {
  const entries = Object.entries(spec) as [string, 1 | -1][];

  return [...docs].sort((a, b) => {
    for (const [field, direction] of entries) {
      const left = a[field as keyof Doc];
      const right = b[field as keyof Doc];
      const order =
        left instanceof Date && right instanceof Date
          ? Math.sign(left.getTime() - right.getTime())
          : String(left).localeCompare(String(right));

      if (order !== 0) return order * direction;
    }

    return 0;
  });
}

interface RecordedQuery {
  filter: Filter<CommentDocument>;
  sort?: Sort | undefined;
  limit?: number | undefined;
  options?: unknown;
}

function fakeCollection(docs: Doc[]) {
  const calls: RecordedQuery[] = [];
  const collection = {
    find(filter: Filter<CommentDocument>, options?: unknown) {
      const call: RecordedQuery = { filter, options };
      const cursor = {
        sort(spec: Sort) {
          call.sort = spec;

          return cursor;
        },
        limit(n: number) {
          call.limit = n;

          return cursor;
        },
        async toArray() {
          calls.push(call);

          const matched = docs.filter((doc) => matchesClause(doc, filter as Record<string, unknown>));
          const sorted = call.sort ? sortDocs(matched, call.sort) : matched;

          return call.limit === undefined ? sorted : sorted.slice(0, call.limit);
        },
      };

      return cursor;
    },
  };

  return { collection: collection as never, calls };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TASK_ID = 'task-1';
const OTHER_TASK_ID = 'task-2';
const BASE_MS = 1_781_234_567_890;

function makeDoc(index: number, createdAt: Date, taskId = TASK_ID): Doc {
  return {
    // A 12-byte ObjectId whose hex is the zero-padded index, so the tiebreaker
    // order in a test is readable and stable.
    _id: new ObjectId(index.toString(16).padStart(24, '0')),
    id: `comment-${index}`,
    taskId,
    authorId: 'user-1',
    authorSnapshot: { displayName: 'Alice' },
    body: `body ${index}`,
    createdAt,
    updatedAt: createdAt,
  };
}

/** `count` comments of one task, oldest first, one millisecond apart. */
function makeThread(count: number, startMs = BASE_MS, taskId = TASK_ID, from = 0): Doc[] {
  return Array.from({ length: count }, (_, i) => makeDoc(from + i, new Date(startMs + i), taskId));
}

function repo(docs: Doc[]) {
  const { collection, calls } = fakeCollection(docs);

  return { repository: new CommentRepository(collection), calls, docs };
}

/**
 * Walk a whole thread the way a client does: request a page, resume from its
 * `nextCursor` until `hasMore` is false, and record what came back.
 */
async function traverse(repository: CommentRepository, limit: number, taskId = TASK_ID) {
  const pagesFetched: string[][] = [];
  let cursor: CommentPageCursor | undefined;

  for (;;) {
    const page: Page = await repository.findPageByTask(taskId, { limit, cursor });

    pagesFetched.push(page.comments.map((c) => c.id));

    if (!page.hasMore) break;
    if (!page.nextCursor) throw new Error(`page ${pagesFetched.length}: hasMore was true but no cursor came back`);
    cursor = page.nextCursor;
  }

  // The thread a client assembles: each older page is placed ABOVE what it
  // already holds, so the last page fetched ends up at the top of the list.
  return { thread: [...pagesFetched].reverse().flat(), pages: pagesFetched.length, pagesFetched };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CommentRepository.findPageByTask (cursor pagination)', () => {
  it('queries the newest window, newest-first, and returns the page oldest-first', async () => {
    const { repository, calls } = repo(makeThread(100));
    const page = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });

    // The first page is the NEWEST 30 — the part a reader opened the task for.
    expect(page.comments).toHaveLength(COMMENT_PAGE_SIZE);
    expect(page.comments[0]?.id).toBe('comment-70');
    expect(page.comments[29]?.id).toBe('comment-99');
    // …and it still reads top-to-bottom in chronological order on screen.
    expect(page.comments.map((c) => c.id)).toEqual(
      Array.from({ length: COMMENT_PAGE_SIZE }, (_, i) => `comment-${70 + i}`),
    );
    expect(calls[0]?.sort).toEqual({ createdAt: -1, _id: -1 });
    expect(calls[0]?.limit).toBe(COMMENT_PAGE_SIZE + 1);
    // No keyset predicate on the first page: the window is the whole thread.
    expect(calls[0]?.filter).toEqual({ taskId: TASK_ID });
  });

  it('resumes BELOW the oldest comment of the previous page', async () => {
    const { repository, calls } = repo(makeThread(100));
    const first = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });
    const second = await repository.findPageByTask(TASK_ID, {
      limit: COMMENT_PAGE_SIZE,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.comments[0]?.id).toBe('comment-40');
    expect(second.comments[29]?.id).toBe('comment-69');

    const filter = calls[1]?.filter as { taskId: string; $or: Record<string, unknown>[] };

    expect(filter.taskId).toBe(TASK_ID);
    // Strictly older: a keyset predicate, not a skip.
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toEqual({ createdAt: { $lt: new Date(BASE_MS + 70) } });
    expect(calls[1]?.filter).not.toHaveProperty('createdAt.$gt');
  });

  it('returns every comment exactly once across a full traversal of 1000 comments', async () => {
    // The end-to-end proof: 1000 comments is 34 pages at the default page size,
    // and a client that follows `nextCursor` until `hasMore` is false must see
    // every comment — no duplicate, no gap.
    const { repository } = repo(makeThread(1000));
    const { thread, pages } = await traverse(repository, COMMENT_PAGE_SIZE);

    expect(pages).toBe(34);
    expect(thread).toHaveLength(1000);
    expect(new Set(thread).size).toBe(1000);
    expect(thread).toEqual(Array.from({ length: 1000 }, (_, i) => `comment-${i}`));
  });

  it('crosses page boundaries inside a run of comments sharing one createdAt', async () => {
    // Every comment written in the same millisecond sorts equally, so a page
    // boundary landing inside the run is the case that loses or repeats
    // comments when `createdAt` is the only sort key.
    const docs = Array.from({ length: 95 }, (_, i) => makeDoc(i, new Date(BASE_MS)));
    const { repository } = repo(docs);
    const { thread, pages } = await traverse(repository, COMMENT_PAGE_SIZE);

    expect(pages).toBe(4);
    expect(thread).toEqual(Array.from({ length: 95 }, (_, i) => `comment-${i}`));
    expect(new Set(thread).size).toBe(95);
  });

  it('never duplicates or drops a comment whatever the page size', async () => {
    // Sizes that do and do not divide a tied run evenly, plus a size larger
    // than the thread, so the boundary lands in a different place each time.
    const docs = Array.from({ length: 40 }, (_, i) => makeDoc(i, new Date(BASE_MS)));
    const { repository } = repo(docs);
    const expected = Array.from({ length: 40 }, (_, i) => `comment-${i}`);

    for (const limit of [1, 7, 8, 13, 39, 40, 41]) {
      const { thread } = await traverse(repository, limit);

      expect(thread, `limit ${limit}`).toEqual(expected);
    }
  });

  it('reports hasMore=false and a null cursor on the final short page', async () => {
    const { repository } = repo(makeThread(30));
    const page = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });

    expect(page.comments).toHaveLength(30);
    // 30 comments and no probe row: the thread is exhausted.
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps hasMore true on an exactly-full page only when a probe row follows', async () => {
    const exact = repo(makeThread(30));
    const overflow = repo(makeThread(31));

    expect((await exact.repository.findPageByTask(TASK_ID, { limit: 30 })).hasMore).toBe(false);

    const withOneMore = await overflow.repository.findPageByTask(TASK_ID, { limit: 30 });

    expect(withOneMore.hasMore).toBe(true);
    expect(withOneMore.comments).toHaveLength(30);
    expect(withOneMore.nextCursor).not.toBeNull();
  });

  it('returns an empty page for a task with no comments', async () => {
    const { repository } = repo(makeThread(5));
    const page = await repository.findPageByTask('task-without-comments', { limit: COMMENT_PAGE_SIZE });

    expect(page).toEqual({ comments: [], hasMore: false, nextCursor: null });
  });

  it("never returns another task's comments, on any page of a traversal", async () => {
    const docs = [...makeThread(40), ...makeThread(40, BASE_MS, OTHER_TASK_ID, 500)];
    const { repository } = repo(docs);
    const { thread, pages } = await traverse(repository, COMMENT_PAGE_SIZE);

    expect(pages).toBe(2);
    expect(thread).toHaveLength(40);
    expect(thread.every((id: string) => Number(id.slice('comment-'.length)) < 40)).toBe(true);
  });

  /**
   * A comment posted BETWEEN two page requests. Documented semantics: it belongs
   * to the newest page, which the client already holds, so it appears in no page
   * of a traversal that is already under way — and it can neither duplicate nor
   * displace anything, because the window is anchored to a document rather than
   * to an offset. A later full re-read of the thread shows it.
   */
  it('does not duplicate or drop anything when a comment arrives between pages', async () => {
    const { repository, calls, docs } = repo(makeThread(100));
    const first = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });

    // The insert lands after the first page was read — newer than its window.
    docs.push(makeDoc(1000, new Date(BASE_MS + 10_000)));
    calls.length = 0;

    const second = await repository.findPageByTask(TASK_ID, {
      limit: COMMENT_PAGE_SIZE,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.comments.map((c) => c.id)).not.toContain('comment-1000');
    expect(second.comments.map((c) => c.id)).toEqual(
      Array.from({ length: COMMENT_PAGE_SIZE }, (_, i) => `comment-${40 + i}`),
    );
    // The insert cannot enter a window that only moves backwards.
    expect(calls[0]?.filter).not.toEqual({ taskId: TASK_ID });
  });

  it('resumes on the same page when the same cursor is requested twice', async () => {
    // The cursor is the whole resume state, so a retried request cannot land on
    // a different page — which is what makes a retry after a timeout safe.
    const { repository } = repo(makeThread(100));
    const first = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });
    const cursor = first.nextCursor ?? undefined;
    const a = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE, cursor });
    const b = await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE, cursor });

    expect(a.comments.map((c) => c.id)).toEqual(b.comments.map((c) => c.id));
  });

  it('bounds the read in time as well as in rows', async () => {
    const { repository, calls } = repo(makeThread(5));

    await repository.findPageByTask(TASK_ID, { limit: COMMENT_PAGE_SIZE });

    expect(calls[0]?.options).toEqual({ maxTimeMS: expect.any(Number) });
  });

  it('answers an empty page for a cursor older than the whole thread', async () => {
    // Paging past the beginning is an empty page, not an error and not a
    // re-read of the first page: the window only ever moves backwards, so a
    // cursor below the oldest comment matches nothing.
    const { repository } = repo(makeThread(40));
    const page = await repository.findPageByTask(TASK_ID, {
      limit: 10,
      cursor: { createdAtMs: BASE_MS - 1_000, objectId: '0'.repeat(24) },
    });

    expect(page).toEqual({ comments: [], hasMore: false, nextCursor: null });
  });
});
