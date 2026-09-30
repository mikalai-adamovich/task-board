import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

// Re-export error classes from the dedicated errors module.
// All existing imports from './error-handler.js' continue to work.
export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../errors/app-error.js';

import { AppError } from '../errors/app-error.js';
import { isQueryTimeoutError } from '../db/query-timeout.js';

// ─── Error Handler ────────────────────────────────────────────────────────────

/**
 * Global error handler for Hono apps.
 *
 * Returns structured JSON responses in the v5 format:
 * ```json
 * { "error": { "code": "...", "message": "...", "details": ... } }
 * ```
 *
 * Known error types:
 * - `AppError` (and subclasses) → mapped to their statusCode + code
 * - `ZodError` → 400 VALIDATION_ERROR with field-level details
 * - `HTTPException` (Hono built-in) → mapped to its status
 * - Unknown errors → 500 INTERNAL_ERROR (no stack leak)
 *
 * When the request-id middleware is mounted, the correlation id is
 * included as `error.requestId` — at error level, NOT top-level, so the top
 * level stays reserved for the `{ data }` success envelope. Omitted when no
 * request id is on the context (e.g. apps that don't mount the middleware).
 *
 * A MongoDB `maxTimeMS` expiry (`QueryAborted` / code 50) is translated to
 * a 503 `QUERY_TIMEOUT` in the SAME envelope as every other error. Without this
 * mapping it fell through to the unknown-error branch and became a 500
 * `INTERNAL_ERROR` — wrong status, and the raw driver message ("operation
 * exceeded time limit") was the only clue an operator had. The client message
 * is intentionally generic: it names no collection, no index, no filter and no
 * driver string, so the envelope cannot be used to probe query shapes.
 *
 * Use with `app.onError(errorHandler)` in the Hono app bootstrap.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get('requestId') as string | undefined;
  const withRequestId = requestId === undefined ? {} : { requestId };

  // ── Known application errors ──────────────────────────────────────────────
  if (err instanceof AppError) {
    // Headers an error requires (e.g. `Retry-After` + `RateLimit-*` on a 429)
    // must be set BEFORE the body is written — Hono applies them to the
    // response being built.
    for (const [name, value] of Object.entries(err.headers ?? {})) {
      c.header(name, value);
    }

    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
          ...withRequestId,
        },
      },
      err.statusCode as 400,
    );
  }

  // ── Zod validation errors ─────────────────────────────────────────────────
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));

    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
          ...withRequestId,
        },
      },
      400,
    );
  }

  // ── MongoDB maxTimeMS expiry → 503 QUERY_TIMEOUT ─────────────────────────
  // Checked BEFORE the HTTPException branch: a driver error is not an
  // HTTPException, but ordering it here keeps the "known cause" mappings
  // together and makes the mapping independent of Hono's error shapes.
  if (isQueryTimeoutError(err)) {
    console.error('Query aborted by maxTimeMS', err);

    return c.json(
      {
        error: {
          code: 'QUERY_TIMEOUT',
          message: 'The query took too long to complete. Narrow your filters and try again.',
          ...withRequestId,
        },
      },
      503,
    );
  }

  // ── Malformed JSON body → keep the VALIDATION_ERROR contract ─────────────
  // Hono's built-in validator throws an HTTPException before @hono/zod-validator
  // can run its hook, so we normalize it here.
  if (err instanceof HTTPException && err.status === 400 && err.message.includes('Malformed JSON')) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid JSON in request body',
          ...withRequestId,
        },
      },
      400,
    );
  }

  // ── Hono built-in HTTPException (404, method not allowed, etc.) ───────────
  if ('status' in err && typeof err.status === 'number') {
    return c.json(
      {
        error: {
          code: 'HTTP_ERROR',
          message: err.message,
          ...withRequestId,
        },
      },
      err.status as 400,
    );
  }

  // ── Unknown errors — do not leak internals ────────────────────────────────
  console.error('Unhandled error:', err);

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        ...withRequestId,
      },
    },
    500,
  );
};
