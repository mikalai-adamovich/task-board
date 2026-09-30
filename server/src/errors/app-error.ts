import type { ErrorCode } from '@task-board/shared';

/**
 * Structured application error classes for the v5 error model.
 *
 * All errors produce `{ error: { code, message, details } }` JSON responses.
 * Error codes and HTTP status codes match the technical specification §7.3.
 */

/** All v5 error codes — single source of truth in `@task-board/shared`. */
export type { ErrorCode };

// ─── Base Error ─────────────────────────────────────────────────────────────

/**
 * Base application error. Use subclasses for common HTTP errors.
 * For domain-specific errors, construct directly with the appropriate ErrorCode.
 *
 * @example
 * ```ts
 * throw new AppError(409, 'TASK_VERSION_CONFLICT', 'Task was modified concurrently');
 * ```
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  /**
   * Extra response headers this error requires (e.g. `Retry-After` +
   * `RateLimit-*` on a 429). Applied by the global error handler BEFORE the JSON
   * body is written, so the headers survive the envelope rendering.
   */
  // The `| undefined` is required under `exactOptionalPropertyTypes` — the
  // constructor forwards an optional `headers?: Record<string, string>` argument
  // that is `undefined` for every error that sets no extra headers.
  public readonly headers?: Record<string, string> | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.headers = headers;
  }
}

// ─── Subclasses ─────────────────────────────────────────────────────────────

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'Resource conflict',
    code: Extract<
      ErrorCode,
      | 'CONFLICT'
      | 'TASK_VERSION_CONFLICT'
      | 'DUPLICATE_PROJECT_KEY'
      | 'DUPLICATE_LABEL'
      | 'DUPLICATE_STATUS'
      | 'INVITATION_ALREADY_ACCEPTED'
      | 'TASK_TYPE_IN_USE'
      | 'STATUS_IN_USE'
      | 'SLUG_TAKEN'
    > = 'CONFLICT',
  ) {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends AppError {
  constructor(
    message = 'Bad request',
    code: Extract<
      ErrorCode,
      | 'INVALID_STATUS_REPLACEMENT'
      | 'INVALID_SPRINT_DATES'
      | 'PROJECT_KEY_IMMUTABLE'
      | 'INVALID_RESET_TOKEN'
      | 'VALIDATION_ERROR'
    > = 'VALIDATION_ERROR',
  ) {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}

export class GoneError extends AppError {
  constructor(
    message = 'Resource gone',
    code: Extract<ErrorCode, 'INVITATION_EXPIRED' | 'INVITATION_REVOKED'> = 'INVITATION_EXPIRED',
  ) {
    super(410, code, message);
    this.name = 'GoneError';
  }
}
