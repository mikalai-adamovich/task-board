/**
 * Duplicate-key (`E11000`) detection and mapping.
 *
 * F11 added the unique indexes that make the check-then-insert races real:
 * `task_relationships {projectId,sourceTaskId,targetTaskId}`,
 * `task_relationships {id}` and `filters {userId,projectId,name}`. A race that
 * the pre-check loses is no longer silently harmless — the server rejects the
 * insert and the driver error surfaced as a raw `MongoServerError`, i.e. a 500
 * `INTERNAL_ERROR` for what is a perfectly ordinary domain conflict ("this
 * relationship already exists").
 *
 * The check-then-insert pattern stays where it is: it is still the right thing
 * to do (it produces the good, specific error message in the 99.9% case), and
 * removing it in favour of catching the driver error would mean every conflict
 * costs an extra round trip. The index is the lock; this module is the
 * translation of "the lock was contended" into the same answer the check would
 * have given.
 *
 * ## Why the mapping lives in the service layer, not in `errorHandler`
 *
 * `E11000` names a constraint (`E11000 duplicate key error collection: …
 * index: …_1 dup key: { … }`), and no two indexes want the same answer: a
 * duplicate `filters.name` is a 409 the user can act on, a duplicate
 * `tasks.number` is a counter race that should be retried, and a duplicate
 * `users.email` is a 409 that must not reveal the account. The service that
 * issued the insert knows which of those it was, so it supplies the error;
 * this module only recognises the driver failure and never lets the driver's
 * own text escape.
 */
import type { AppError } from '../errors/app-error.js';

/** MongoDB server error code for a unique-index violation. */
export const DUPLICATE_KEY_CODE = 11_000;

/**
 * True when `err` is a MongoDB unique-index violation.
 *
 * Driver-agnostic by design (same reasoning as `isQueryTimeoutError`): the
 * check reads `code` / `codeName` instead of using `instanceof MongoServerError`,
 * so it also works for the Durable-Object transport and for a plain object
 * thrown by a repository double in a unit test.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const { code, codeName } = err as { code?: unknown; codeName?: unknown };

  return code === DUPLICATE_KEY_CODE || codeName === 'DuplicateKey';
}

/**
 * The key pattern of the numbering index (`CORE_INDEXES` entry
 * `tasks {projectId: 1, number: -1}`, unique) as the driver reports it on
 * `MongoServerError.keyPattern`.
 */
const TASK_NUMBER_KEY_PATTERN: Record<string, unknown> = { projectId: 1, number: -1 };

/**
 * True ONLY for a lost `tasks {projectId, number}` uniqueness race.
 *
 * Task numbers are allocated by an atomic counter (`findOneAndUpdate` `$inc` +
 * upsert), so two concurrent creates normally receive different numbers and
 * never meet this index. The index is the backstop for the case the counter
 * cannot cover: the counter document is behind the highest `number` actually
 * stored in `tasks` (a restored backup, a hand-written/migrated row, a
 * `counters` wipe) and a freshly allocated number already exists. That is a
 * numbering race, not a user mistake — the caller re-allocates and retries
 * (`TaskService.createTask`).
 *
 * ## Why the check is narrow
 *
 * Retrying is only correct for THIS index. Every other `E11000` (duplicate
 * `tasks.id`, a duplicate project slug, a duplicate member pair) is a genuine
 * conflict that `withConflictOnDuplicate` must keep translating into a domain
 * 409 — silently retrying those would turn a real error into a mystery timeout
 * and, worse, would let a request hammer a constraint it can never satisfy.
 * So the predicate requires positive identification of the numbering index and
 * answers `false` whenever it cannot prove which index fired:
 *
 * - `keyPattern` (what the driver actually sets) is matched field-by-field;
 * - a `MongoServerError` that exposes NO `keyPattern` cannot be identified, so
 *   it is not retried — the safe direction;
 * - a non-driver carrier of `keyPattern` (a repository double in a unit test)
 *   is matched identically, so the rule is transport-independent.
 */
export function isTaskNumberConflict(err: unknown): boolean {
  if (!isDuplicateKeyError(err)) return false;

  const { keyPattern } = err as { keyPattern?: unknown };

  if (typeof keyPattern !== 'object' || keyPattern === null) return false;

  const pattern = keyPattern as Record<string, unknown>;
  const keys = Object.keys(TASK_NUMBER_KEY_PATTERN);

  return (
    keys.length === Object.keys(pattern).length && keys.every((key) => pattern[key] === TASK_NUMBER_KEY_PATTERN[key])
  );
}

/**
 * Run an insert and translate a lost uniqueness race into a domain conflict.
 *
 * Only `E11000` is translated — every other driver error (a `maxTimeMS`
 * expiry, an exhausted pool, a write-concern timeout) is re-thrown untouched,
 * because it is NOT a client mistake and must keep reaching the mappings that
 * already exist for it (`QUERY_TIMEOUT` → 503, everything else → 500).
 *
 * @param operation the write whose uniqueness is being enforced by an index
 * @param conflict  the domain error to throw instead; a thunk so the message
 *   and code are only built when the race is actually lost
 */
export async function withConflictOnDuplicate<T>(operation: () => Promise<T>, conflict: () => AppError): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict();
    }

    throw err;
  }
}
