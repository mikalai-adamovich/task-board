import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/context.js';
import {
  SERVER_TIMINGS_HEADER,
  createServerTimings,
  formatServerTimings,
  runWithServerTimings,
} from '../utils/timings.js';

/**
 * Request-ID middleware.
 *
 * Assigns every request a correlation id:
 * - A well-formed incoming `X-Request-Id` header is trusted (lets callers /
 *   gateways propagate their own ids).
 * - Anything malformed — or no header — gets a fresh `crypto.randomUUID()`.
 *
 * The id is stored as `c.get('requestId')` (surfaced in the error envelope by
 * `errorHandler`) and echoed back on the response as `X-Request-Id`.
 *
 * Must be mounted FIRST in the middleware chain so every downstream log line
 * and error response can be correlated.
 *
 * This is also where the per-request `Server-Timings` accumulator is
 * created and rendered — deliberately the SAME middleware rather than a second
 * one, so there is exactly one place that owns "what every response carries"
 * and the timings cover the whole chain, including everything this middleware
 * wraps. The header is written in a `finally`, so it is present on success
 * responses, on inline responses (404 / 405 / `DB_UNAVAILABLE`) AND on error
 * responses rendered afterwards by `app.onError` — a slow failure is precisely
 * the response whose timings nobody can afford to lose.
 */

const REQUEST_ID_HEADER = 'X-Request-Id';
/** UUID-ish: 8-4-4-4-12 hex digits (any version, case-insensitive). */
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: string | undefined): value is string {
  return value !== undefined && REQUEST_ID_PATTERN.test(value);
}

/** Trust a valid incoming id, otherwise generate one. Exported for tests. */
export function resolveRequestId(incoming: string | undefined): string {
  return isValidRequestId(incoming) ? incoming : crypto.randomUUID();
}

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  const timings = createServerTimings();

  c.set('requestId', requestId);
  // Set before `next()` so Hono merges it into whatever response the chain
  // produces — including error responses from `app.onError`.
  c.header(REQUEST_ID_HEADER, requestId);

  try {
    await runWithServerTimings(timings, next);
  } finally {
    // `c.header()` writes onto the response Hono is currently building, so
    // setting it once the chain has settled still reaches the bytes on the
    // wire — and, in the catch path, the response `app.onError` builds next.
    c.header(SERVER_TIMINGS_HEADER, formatServerTimings(timings));
  }
};
