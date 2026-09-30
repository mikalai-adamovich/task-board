/**
 * `Server-Timings` support.
 *
 * The performance investigation has carried one unexplained finding for a long
 * time: a **Class 2 pre-DB stall of 140–320 ms** before the first MongoDB
 * checkout, plus a rare post-deploy transient hang of 75–90 s
 * (`product-analysis/100-performance-optimizations.md`). Production could not
 * observe it, because a response carried nothing but `X-Request-Id` — no way to
 * tell "the Worker was slow" from "the database was slow" from a single sample.
 * This module adds the missing measurement and nothing else: **no metrics
 * backend, no Analytics Engine, no new binding** — the observability stack is
 * an owner decision (out of scope for F15).
 *
 * ## What is measured
 *
 * | Metric    | Meaning |
 * | --------- | ------- |
 * | `total`   | Wall-clock time of the request inside the request-id middleware. |
 * | `firstdb` | Time from request start to the moment the first MongoDB operation was ISSUED (client acquisition, or the first collection command). Omitted when the request never touched the database. This is the number that pins the pre-DB stall. |
 * | `db`      | Cumulative time spent inside MongoDB operations (client acquisition + every awaited collection/cursor operation). |
 * | `app`     | `total - db` — everything that is not database work (routing, Zod, auth, RBAC, serialization, e-mail). |
 *
 * Measurement points are deliberately coarse: the store is fed by the MongoDB
 * access point (`db/mongo.ts` — client acquisition and `getCollection()`, which
 * returns a timing-wrapped collection), never by an individual repository. One
 * instrumentation site covers all 20 repositories, so a new repository is timed
 * automatically instead of having to remember to opt in.
 *
 * ## What is NOT measured
 *
 * Response body serialization happens after the middleware chain returns, so it
 * is included in neither `total` nor `app` to any useful precision; the numbers
 * are for comparing samples, not for accounting.
 *
 * ## Redaction
 *
 * The header value contains NOTHING but metric names we control and integer
 * millisecond durations — no request id, no route, no user id, no e-mail, no
 * token. That is the invariant `utils/redact.ts` protects for log lines, and it
 * is asserted by a test so a future "helpful" extra metric cannot slip a
 * user-identifying value into a response header.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Name of the response header (standard, see the Server-Timing spec). */
export const SERVER_TIMINGS_HEADER = 'Server-Timings';

/**
 * Per-request timing accumulator.
 *
 * Mutable on purpose: it is a single object shared by the whole request through
 * `AsyncLocalStorage`, exactly like the `Db` handle in `db/mongo.ts`, so the
 * instrumentation does not have to thread a parameter through 20 repositories.
 */
export interface ServerTimings {
  /** `performance.now()` at the moment the request entered the middleware. */
  readonly start: number;
  /** Milliseconds from `start` until the first MongoDB operation was issued. */
  firstDbAt?: number;
  /** Cumulative milliseconds spent inside MongoDB operations. */
  dbMs: number;
  /** Number of tracked MongoDB operations (client acquisition included). */
  dbCount: number;
}

const timingsStorage = new AsyncLocalStorage<ServerTimings>();

/** Monotonic clock — `Date.now()` is wall-clock and can jump backwards. */
function now(): number {
  return performance.now();
}

/** Create an accumulator. Called once per request, by the request-id middleware. */
export function createServerTimings(): ServerTimings {
  return { start: now(), dbMs: 0, dbCount: 0 };
}

/** Run `fn` with `timings` visible to every instrumentation point. */
export function runWithServerTimings<T>(timings: ServerTimings, fn: () => Promise<T>): Promise<T> {
  return timingsStorage.run(timings, fn);
}

/**
 * The accumulator of the request currently being served, or `undefined` outside
 * a `runWithServerTimings` context (CLI scripts, migrations, unit tests).
 * Instrumentation MUST degrade to a no-op in that case — never throw.
 */
export function getServerTimings(): ServerTimings | undefined {
  return timingsStorage.getStore();
}

/**
 * Record that a MongoDB operation was ISSUED at `at`.
 *
 * Only the first call has an effect: the value is the "time to first MongoDB
 * operation" metric, which is exactly the pre-DB stall the investigation could
 * not previously observe.
 */
export function markFirstDbOp(timings: ServerTimings | undefined = getServerTimings(), at: number = now()): void {
  if (!timings || timings.firstDbAt !== undefined) {
    return;
  }

  timings.firstDbAt = Math.max(0, at - timings.start);
}

/**
 * Wrap a MongoDB promise so its wall time is added to `db`.
 *
 * The time is recorded on BOTH fulfilment and rejection: a query that blew the
 * `maxTimeMS` budget still cost the database real time, and hiding it would make
 * the slow-request class invisible in exactly the samples that need it.
 *
 * The returned promise is a NEW promise (the driver's is left untouched), which
 * is safe because every repository `await`s the result.
 */
export function trackDbPromise<T>(
  operation: Promise<T>,
  timings: ServerTimings | undefined = getServerTimings(),
): Promise<T> {
  if (!timings) {
    return operation;
  }

  const started = now();

  return operation.then(
    (value) => {
      timings.dbMs += now() - started;
      timings.dbCount += 1;

      return value;
    },
    (err: unknown) => {
      timings.dbMs += now() - started;
      timings.dbCount += 1;

      throw err;
    },
  );
}

/**
 * Track a value returned by an instrumented MongoDB call.
 *
 * `insertOne` / `findOne` / `countDocuments` return a promise (timed directly);
 * `find` / `aggregate` return a lazy cursor whose cost materializes later, in
 * `toArray()` / `next()` — so cursors are returned wrapped and timed when they
 * are consumed. Anything else is passed through untouched.
 */
export function trackDbValue<T>(invoke: () => T, timings: ServerTimings | undefined = getServerTimings()): T {
  if (!timings) {
    return invoke();
  }

  markFirstDbOp(timings);

  const result = invoke();

  if (isThenable(result)) {
    return trackDbPromise(result, timings) as T;
  }

  if (isCursorLike(result)) {
    return timedCursor(result, timings) as T;
  }

  return result;
}

/**
 * Time a MongoDB operation end-to-end, including the synchronous part.
 *
 * Used for `getMongoClient()`, where the expensive await happens inside the
 * function: the clock must start before the call, not after the promise exists.
 */
export function trackDbCall<T>(
  operation: () => Promise<T>,
  timings: ServerTimings | undefined = getServerTimings(),
): Promise<T> {
  if (!timings) {
    return operation();
  }

  markFirstDbOp(timings);

  return trackDbPromise(operation(), timings);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * Duck-typed cursor detection: the driver cursors (`FindCursor`,
 * `AggregationCursor`, `ChangeStream`) all expose a consuming `toArray` and an
 * incremental `next`. Deliberately structural — the concrete classes are
 * internal to the driver and must not be imported.
 */
function isCursorLike(value: unknown): boolean {
  const candidate = value as { toArray?: unknown; next?: unknown } | null | undefined;

  return typeof candidate?.toArray === 'function' && typeof candidate?.next === 'function';
}

/**
 * Wrap a cursor so the round trip that actually materializes the result
 * (`toArray` / `next` / `hasNext` / `forEach` / `close`) is timed.
 *
 * Driver methods are invoked with the RAW cursor as `this`, so the driver's own
 * internal property access never re-enters the proxy and can never observe it.
 */
function timedCursor<T>(cursor: T, timings: ServerTimings): T {
  return new Proxy(cursor as object, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);

      // Symbols carry driver internals (BSON version markers, iterator protocol
      // keys). Only real methods are wrapped — everything else is passed as-is.
      if (typeof prop === 'symbol' || typeof value !== 'function') {
        return value;
      }

      const method = value as (...args: unknown[]) => unknown;

      return (...args: unknown[]) => {
        const started = now();
        const result = method.apply(target, args);

        if (!isThenable(result)) {
          return result;
        }

        const tracked = trackDbPromise(result, timings);

        // The cursor's first consumption is also its first database operation.
        markFirstDbOp(timings, started);

        return tracked;
      };
    },
  }) as T;
}

/** Durations are integers: sub-millisecond precision is noise, and an integer
 * `dur` is unambiguously valid for every parser (devtools, `curl -w`, wrangler). */
function duration(value: number): string {
  return String(Math.max(0, Math.round(value)));
}

/**
 * Render the `Server-Timings` header value.
 *
 * Standard syntax (`metric;dur=<ms>;desc="…"`, comma-separated) so Chrome
 * devtools renders it in the Network panel and `curl -w '%{header_json}'` can
 * parse it. `firstdb` is omitted when the request never reached the database —
 * a zero there would be a lie, and its absence is itself the signal (a pure
 * auth/routing request).
 */
export function formatServerTimings(timings: ServerTimings, at: number = now()): string {
  const total = Math.max(0, at - timings.start);
  const db = Math.max(0, timings.dbMs);
  // `app` must never go negative: a clock skew between two `performance.now()`
  // reads (or a `dbMs` measured across an await boundary) would otherwise
  // produce a header a strict parser rejects.
  const app = Math.max(0, total - db);
  const parts = [`total;dur=${duration(total)}`];

  if (timings.firstDbAt !== undefined) {
    parts.push(`firstdb;dur=${duration(timings.firstDbAt)};desc="time to first MongoDB operation"`);
  }

  parts.push(`db;dur=${duration(db)};desc="MongoDB"`);
  parts.push(`app;dur=${duration(app)};desc="non-DB"`);

  return parts.join(', ');
}
