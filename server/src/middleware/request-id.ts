import type { MiddlewareHandler } from 'hono';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppEnv } from '../types/context.js';
import {
  SERVER_TIMINGS_HEADER,
  createServerTimings,
  formatServerTimings,
  runWithServerTimings,
} from '../utils/timings.js';

/**
 * Request-correlation middleware.
 *
 * Every request gets TWO ids, and they are deliberately different things:
 *
 * - `requestId` — the TRUSTED correlation id. Always generated here with
 *   `crypto.randomUUID()`; a client can never choose it. This is the id logs
 *   are keyed on and the id an audit row carries, so an audit entry and the log
 *   line for the same operation are joined by a value the caller does not
 *   control.
 * - `upstreamRequestId` — the client's `X-Request-Id`, kept ONLY when it is
 *   well-formed, and recorded as a separate, clearly-labelled field (on the
 *   audit row and in `c.get('upstreamRequestId')`). It is never the correlation
 *   key: a client that replays one id across many requests would otherwise
 *   merge unrelated activity into a single apparent chain.
 *
 * Why the trusted id used to be the client's and is not any more: echoing a
 * caller-supplied id is convenient across a gateway, but it makes the id an
 * UNTRUSTED INPUT on the one value the observability stack joins on. The
 * convenience is preserved — a well-formed incoming id is still recorded, and
 * it is still the value echoed on `X-Request-Id`, so an upstream proxy keeps
 * seeing its own id come back — while the audit trail and the logs get an id
 * only this process minted.
 *
 * The correlation pair is exposed two ways, because the consumers are different
 * layers: as context variables for the middleware chain (`c.get(...)`, used by
 * `errorHandler` and the not-found handler), and through an
 * `AsyncLocalStorage` store for the SERVICE layer. Services have no `Context` —
 * threading a parameter through every audited call site to carry an id would
 * touch every service signature in the codebase, which is the same reason
 * `utils/timings.ts` uses a store rather than a parameter. Outside a request
 * (CLI scripts, migrations, unit tests) the store is `undefined` and an audit
 * row simply carries no correlation id, which is the truth: no request caused
 * it.
 *
 * Must be mounted FIRST in the middleware chain so every downstream log line,
 * audit write and error response can be correlated.
 *
 * This is also where the per-request `Server-Timings` accumulator is created and
 * rendered — deliberately the SAME middleware rather than a second one, so there
 * is exactly one place that owns "what every response carries" and the timings
 * cover the whole chain, including everything this middleware wraps. The header
 * is written in a `finally`, so it is present on success responses, on inline
 * responses (404 / 405 / `DB_UNAVAILABLE`) AND on error responses rendered
 * afterwards by `app.onError` — a slow failure is precisely the response whose
 * timings nobody can afford to lose.
 */

const REQUEST_ID_HEADER = 'X-Request-Id';
/** UUID-ish: 8-4-4-4-12 hex digits (any version, case-insensitive). */
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: string | undefined): value is string {
  return value !== undefined && REQUEST_ID_PATTERN.test(value);
}

/**
 * The two ids for one request.
 *
 * `upstreamRequestId` is `null` — not a generated placeholder — when the caller
 * sent nothing or something malformed: "no upstream id" and "an upstream id we
 * made up" must not look alike in an audit row.
 */
export interface RequestCorrelation {
  /** Server-minted id. The only value logs and audit rows are keyed on. */
  readonly requestId: string;
  /** The client's well-formed `X-Request-Id`, or null. Recorded, never trusted. */
  readonly upstreamRequestId: string | null;
}

const correlationStorage = new AsyncLocalStorage<RequestCorrelation>();

/**
 * Run `fn` with `correlation` visible to the service layer. Called once per
 * request by this middleware — the single place a request's ids are created.
 */
export function runWithRequestCorrelation<T>(correlation: RequestCorrelation, fn: () => Promise<T>): Promise<T> {
  return correlationStorage.run(correlation, fn);
}

/**
 * The correlation of the request currently being served, or `undefined` outside
 * a request context (CLI scripts, migrations, unit tests). Callers MUST degrade
 * to "no correlation id" rather than throw.
 */
export function getRequestCorrelation(): RequestCorrelation | undefined {
  return correlationStorage.getStore();
}

/**
 * Build the pair for a request. Exported for tests.
 *
 * The trusted id is ALWAYS freshly generated; the upstream id is passed through
 * only when it is well-formed. A malformed header is dropped rather than
 * sanitized, so a caller cannot influence the stored value by crafting one.
 */
export function resolveRequestCorrelation(incoming: string | undefined): RequestCorrelation {
  return {
    requestId: crypto.randomUUID(),
    upstreamRequestId: isValidRequestId(incoming) ? incoming : null,
  };
}

/** The id echoed on the response: the caller's own when it sent one. */
export function echoedRequestId(correlation: RequestCorrelation): string {
  return correlation.upstreamRequestId ?? correlation.requestId;
}

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const correlation = resolveRequestCorrelation(c.req.header(REQUEST_ID_HEADER));
  const timings = createServerTimings();

  c.set('requestId', correlation.requestId);
  c.set('upstreamRequestId', correlation.upstreamRequestId);
  // Echoed before `next()` so Hono merges it into whatever response the chain
  // produces — including error responses from `app.onError`. The value echoed
  // is the caller's own id when it sent one, so a gateway still sees its id come
  // back; the response envelope and every log line carry the trusted id.
  c.header(REQUEST_ID_HEADER, echoedRequestId(correlation));

  try {
    await runWithServerTimings(timings, () => runWithRequestCorrelation(correlation, next));
  } finally {
    // `c.header()` writes onto the response Hono is currently building, so
    // setting it once the chain has settled still reaches the bytes on the
    // wire — and, in the catch path, the response `app.onError` builds next.
    c.header(SERVER_TIMINGS_HEADER, formatServerTimings(timings));
  }
};
