import { HttpInterceptorFn, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { AuthStore } from '@stores/auth-store';
import type { ErrorCode, ErrorResponse } from '@task-board/shared';

/**
 * Map of error codes (see `ErrorCode` in @task-board/shared) to message keys.
 *
 * Typed `Record<ErrorCode, string>`, not `Record<string, string>`: the type is
 * the guardrail. A code added to the shared list and not mapped here is a
 * COMPILE error in this file, so "four codes were missing and nothing said so"
 * cannot recur. `shared-contract.spec.ts` asserts the second half — that every
 * key here is actually translated in every locale.
 */
const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'errors.validation',
  // A 413 is not a shape problem: the payload is legal, it is only too big, so
  // the message says "send less" instead of "check your input". Present in all
  // eleven locales — `shared-contract.spec.ts` fails the build otherwise.
  PAYLOAD_TOO_LARGE: 'errors.payloadTooLarge',
  NOT_FOUND: 'errors.notFound',
  // V1-8: a failed login must show neutral invalid-credentials copy, not the
  // session-expired message mapped from the bare 401 status below.
  INVALID_CREDENTIALS: 'errors.invalidCredentials',
  TASK_VERSION_CONFLICT: 'errors.taskVersionConflict',
  UNAUTHORIZED: 'errors.unauthorized',
  FORBIDDEN: 'errors.forbidden',
  CONFLICT: 'errors.conflict',
  INTERNAL_ERROR: 'errors.serverError',
  DUPLICATE_PROJECT_KEY: 'errors.duplicateProjectKey',
  DUPLICATE_LABEL: 'errors.duplicateLabel',
  DUPLICATE_STATUS: 'errors.duplicateStatus',
  INVALID_STATUS_REPLACEMENT: 'errors.invalidStatusReplacement',
  INVALID_SPRINT_DATES: 'errors.invalidSprintDates',
  INVALID_RESET_TOKEN: 'errors.invalidResetToken',
  RATE_LIMITED: 'errors.rateLimited',
  QUERY_TIMEOUT: 'errors.queryTimeout',
  TASK_NUMBER_UNAVAILABLE: 'errors.taskNumberUnavailable',
  INVITATION_EXPIRED: 'errors.invitationExpired',
  INVITATION_REVOKED: 'errors.invitationRevoked',
  INVITATION_ALREADY_ACCEPTED: 'errors.invitationAlreadyAccepted',
  PROJECT_ARCHIVED: 'errors.projectArchived',
  TENANT_ARCHIVED: 'errors.tenantArchived',
  PROJECT_KEY_IMMUTABLE: 'errors.projectKeyImmutable',
  TASK_TYPE_IN_USE: 'errors.taskTypeInUse',
  STATUS_IN_USE: 'errors.statusInUse',
  SLUG_TAKEN: 'errors.slugTaken',
};

/**
 * Extract a user-facing message from a structured error response.
 *
 * Every branch returns TRANSLATABLE TEXT: either a transloco key, or — where the
 * text depends on a value the server sent (`Retry-After`) — the translated
 * string itself. `getErrorMessage()` hands this to `notify.error()`, which
 * translates; a value already translated is passed through unchanged, and a key
 * that is missing from a locale degrades to the key rather than to English.
 */
function extractErrorMessage(error: HttpErrorResponse, transloco: TranslocoService): string {
  return applyRetryAfter(error, transloco, resolveMessageKey(error));
}

/**
 * A 429 tells the user WHEN to come back, and the `Retry-After` header the
 * rate limiter already sends is the only place that says so. Reading it here
 * rather than in the status switch matters: a throttled response usually carries
 * a structured `RATE_LIMITED` body, so the code branch resolves first and a
 * switch-only reader never sees the header at all.
 */
function applyRetryAfter(error: HttpErrorResponse, transloco: TranslocoService, key: string): string {
  if (key !== 'errors.rateLimited' && key !== 'errors.tooManyRequests') return key;

  const seconds = readRetryAfterSeconds(error.headers);

  return seconds === null ? key : transloco.translate('errors.tooManyRequestsAfter', { seconds });
}

/** The transloco key for a response, with no value-dependent text. */
function resolveMessageKey(error: HttpErrorResponse): string {
  // Network errors (no response received) — e.g. "Failed to fetch"
  if (error.status === 0) {
    return 'errors.networkError';
  }

  const body = error.error as ErrorResponse | undefined;

  if (body?.error?.code) {
    // An UNKNOWN code gets a transloco key like every other case. It must never
    // fall back to `body.error.message`: that is the server's English prose, and
    // it was being handed to a translation pipeline, so the user saw untranslated
    // English on exactly the conditions (two of them 5xx) an operator most wants
    // read. The raw message is still available on the error object itself.
    return ERROR_CODE_MESSAGES[body.error.code as ErrorCode] ?? 'errors.unknown';
  }

  if (body?.error?.message) {
    return body.error.message;
  }

  if (typeof error.error === 'string') {
    return error.error;
  }

  // Map common HTTP status codes to user-friendly messages
  switch (error.status) {
    case 400:
      return 'errors.badRequest';

    case 401:
      return 'errors.unauthorized';

    case 403:
      return 'errors.forbidden';

    case 404:
      return 'errors.notFound';

    case 409:
      return 'errors.conflict';

    case 422:
      return 'errors.validation';

    case 429:
      // The `Retry-After` overlay is applied by `applyRetryAfter` above.
      return 'errors.tooManyRequests';

    case 500:
      return 'errors.serverError';

    case 502:
      return 'errors.serverError';

    case 503:
      return 'errors.serverError';

    default:
      return 'errors.unexpected';
  }
}

/**
 * Seconds to wait, from the `Retry-After` header the rate limiter sends.
 *
 * A missing, unparsable, negative or non-finite value yields null and the caller
 * falls back to the plain message — a header is never rendered as text.
 */
function readRetryAfterSeconds(headers: HttpHeaders | null | undefined): number | null {
  const raw = headers?.get('Retry-After')?.trim();

  if (!raw) return null;

  const seconds = Number(raw);

  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.ceil(seconds);
}

/**
 * Functional HTTP interceptor that handles error responses:
 * - 401 → clear auth state and redirect to /auth/login
 * - 403 → permission denied
 * - 409 → conflict (e.g. TASK_VERSION_CONFLICT)
 * - 422 → validation errors
 * - Other → generic error
 *
 * All errors are re-thrown with a normalized `userMessage` property
 * attached to the HttpErrorResponse for downstream consumers.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authStore = inject(AuthStore);
  const transloco = inject(TranslocoService);

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      const userMessage = extractErrorMessage(error, transloco);

      // Attach the user-friendly message for downstream error handlers
      (error as HttpErrorResponse & { userMessage?: string }).userMessage = userMessage;

      // Surface unexpected errors (network failures / server errors) as toasts.
      // Expected client errors (4xx) are handled inline by the calling component.
      // Brn-sonner is loaded via dynamic import — a static
      // import here would pin the whole ~49 kB module into the initial bundle
      // (the deferred <hlm-toaster> shares the same module file).
      if (error.status === 0 || error.status >= 500) {
        void import('@spartan-ng/brain/sonner').then(({ toast }) => toast.error(transloco.translate(userMessage)));
      }

      // Auto-logout on 401 — but NOT for auth endpoints themselves:
      // a failed login attempt returns 401 INVALID_CREDENTIALS and must not
      // wipe the session or trigger a redundant navigation.
      const isAuthRequest = req.url.includes('/auth/');

      switch (error.status) {
        case 401:
          if (!isAuthRequest) {
            authStore.logout();
          }
          break;

        // 403/409/422 are EXPECTED client errors — the calling component handles
        // them inline (toast/inline message) after the re-throw below; logging
        // them here was console-only noise with no user-facing value.
      }

      return throwError(() => error);
    }),
  );
};
