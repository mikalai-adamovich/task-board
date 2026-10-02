/**
 * Server-side query timeouts (`maxTimeMS`).
 *
 * Before F11 there was no `maxTimeMS` anywhere in the codebase: every one of the
 * 57 repository queries could run unbounded. A Cloudflare Worker has a hard CPU
 * budget, so a single pathological query (the regex `search` scan, a deep
 * `skip`, an unindexed filter) burns the isolate's budget with no way to abort
 * the work server-side — MongoDB keeps going long after the Worker is gone.
 *
 * `maxTimeMS` is the only mechanism that stops the *database* from working, so
 * it is applied to the query paths that can be expensive. The values are
 * deliberately far below the Worker CPU limit (30 s on the paid plan) — a
 * legitimate request that cannot finish inside the budget is not going to finish
 * at all, and aborting it early leaves the isolate (and the connection pool)
 * usable for the next request.
 *
 * | Budget | Applies to | Why this value |
 * | ------ | ---------- | -------------- |
 * | {@link QUERY_MAX_TIME_MS_LIST} (5 s) | task list / search / audit pages + their counts | The heaviest legitimate measured path is the regex search pair: 728–766 ms find + 351 ms count ≈ 1.1 s on a 25k-task project, on a **warm local** Mongo. 5 s is ~4.5× that headroom, so normal traffic never trips it, while still aborting a runaway before the Worker budget is gone. |
 * | {@link QUERY_MAX_TIME_MS_BOARD} (2 s) | board column pages | Keyset pagination with a fixed 50-card page: measured 5–87 ms, bounded by column size and not by scroll depth. 2 s is >20× the worst measured page. |
 * | {@link QUERY_MAX_TIME_MS_COUNTER} (2 s) | the rate-limit counter probe | A single-document `findOneAndUpdate` on `_id`, so the work is bounded by a bounded array (the window, ≤ `ceiling + 1` entries) rather than by the collection. It sits on the UNAUTHENTICATED login path, where a slow probe is also a slow refusal, so it gets the same budget as the board page rather than the list budget. |
 *
 * Both values are exported so tests and the error mapping can assert on them
 * instead of re-declaring magic numbers.
 */

/**
 * Budget for list-shaped queries (task list, free-text search, audit log) and
 * their paired `countDocuments`.
 *
 * Note: `countDocuments` runs a `$group`/`$match` aggregate, so the same budget
 * applies to both halves of the `Promise.all` pair — a slow filter must fail
 * the request, not just the page.
 */
export const QUERY_MAX_TIME_MS_LIST = 5_000;

/**
 * Budget for board column pages (`findBoardPage`) — a fixed-size, keyset-bounded
 * read that is cheap by construction; see the table in the module docblock.
 */
export const QUERY_MAX_TIME_MS_BOARD = 2_000;

/**
 * Budget for the rate-limit counter probe (`RateLimitCounterRepository`).
 *
 * 2 s, and NEVER 0: a `maxTimeMS` of 0 means "no limit" to the server, not
 * "expire immediately", so passing it would silently disable the one mechanism
 * that stops the database working after the Worker is gone. A probe that runs
 * long enough to expire here falls through to the in-process tier, which still
 * refuses a saturated key — the budget bounds latency, it is not the ceiling.
 */
export const QUERY_MAX_TIME_MS_COUNTER = 2_000;

/**
 * MongoDB server error code for `MaxTimeMSExpired` — the error returned when a
 * query exceeds its `maxTimeMS` budget. (`ExceedTimeLimit` on a transaction is
 * the same class of failure but is not produced by these read paths.)
 */
export const MAX_TIME_MS_EXPIRED_CODE = 50;

/**
 * True when `err` is a MongoDB `maxTimeMS` expiry.
 *
 * Driver-agnostic by design: the check reads the `code` / `codeName` fields off
 * the error instead of `instanceof MongoServerError`, so it also works for the
 * Durable-Object transport and for a plain object in tests.
 */
export function isQueryTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const { code, codeName } = err as { code?: unknown; codeName?: unknown };

  return code === MAX_TIME_MS_EXPIRED_CODE || codeName === 'MaxTimeMSExpired';
}
