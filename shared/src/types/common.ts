import type { DateFormatPreference, TimeFormatPreference } from '../constants/date-format.js';

/** Theme mode: 'auto' follows the browser's prefers-color-scheme. */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** Describes a single theme entry in the generated manifest. */
export interface ThemeManifestItem {
  /** Unique theme identifier derived from the CSS filename (e.g., "light", "dark", "light1"). */
  id: string;
  /** Human-readable display name (e.g., "Light", "Dark", "Light1"). */
  name: string;
  /** Whether the theme is a light or dark variant. */
  mode: 'light' | 'dark';
  /** CSS filename relative to the themes directory (e.g., "light-theme.css"). */
  css: string;
  /** Preview colors extracted from the theme's CSS custom properties. */
  preview: {
    primary: string;
    muted: string;
    foreground: string;
    card: string;
    border: string;
  };
}

/** User preferences type */
export interface UserPreferences {
  userId: string;
  zoom: number;
  /** Theme identifier string (e.g., "light", "dark"). Legacy single-theme field kept for backward compatibility. */
  theme: string;
  /** Theme mode (default 'auto'): 'auto' follows the browser's prefers-color-scheme. */
  themeMode: ThemeMode;
  /** Theme applied when mode is 'light' (or in 'auto' with a light system scheme). Null = default 'light'. */
  lightTheme: string | null;
  /** Theme applied when mode is 'dark' (or in 'auto' with a dark system scheme). Null = default 'dark'. */
  darkTheme: string | null;
  language: string;
  /** Default page size for paginated tables. */
  pageSize: number;
  /** Preferred date display format. Null = not set. */
  dateFormat: DateFormatPreference | null;
  /** Preferred time display format. Null = not set. */
  timeFormat: TimeFormatPreference | null;
  updatedAt: string;
}

/** Update user preferences request body type */
export interface UpdateUserPreferences {
  zoom?: number;
  /** Theme identifier string (e.g., "light", "dark"). Legacy single-theme field kept for backward compatibility. */
  theme?: string;
  /** Theme mode: 'auto' follows the browser's prefers-color-scheme. */
  themeMode?: ThemeMode;
  /** Theme applied when mode is 'light' (or in 'auto' with a light system scheme). */
  lightTheme?: string | null;
  /** Theme applied when mode is 'dark' (or in 'auto' with a dark system scheme). */
  darkTheme?: string | null;
  language?: string;
  /** Default page size for paginated tables. */
  pageSize?: number;
  /** Preferred date display format. */
  dateFormat?: DateFormatPreference | null;
  /** Preferred time display format. */
  timeFormat?: TimeFormatPreference | null;
}

/** Paginated response wrapper */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Pagination query parameters */
export interface PaginationParams {
  /** 1-based page number */
  page: number;
  /** Number of items per page (1-100) */
  limit: number;
  /** Sort field and direction (e.g., "createdAt:desc") */
  sort: string;
}

/**
 * Every error code the API can return — technical specification §14.3 plus the
 * additive server-side conditions.
 *
 * This is the single list, and `ErrorCode` is DERIVED from it. A type-only
 * union could only be consumed by the type system: a client that wanted to
 * render a message per code had to hand-copy the members and hope the two
 * agreed (four codes were missing and nothing said so). With a
 * runtime list, a `Record<ErrorCode, string>` on the client is exhaustive by
 * construction: delete a member here and the client build fails.
 */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  /**
   * The request-body cap (5 MB) refused the body: a 413. Distinct from
   * `VALIDATION_ERROR` because the action is different — the shape is legal,
   * the SIZE is not, so the client says "send less" rather than "check your
   * input". Adding the member here makes the client's exhaustive
   * `Record<ErrorCode, string>` map fail to compile until it has a message,
   * which is how the code and the message are kept in step.
   */
  'PAYLOAD_TOO_LARGE',
  'CONFLICT',
  'TASK_VERSION_CONFLICT',
  'DUPLICATE_PROJECT_KEY',
  'DUPLICATE_LABEL',
  'DUPLICATE_STATUS',
  'INVALID_STATUS_REPLACEMENT',
  'INVALID_SPRINT_DATES',
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
  'INVITATION_ALREADY_ACCEPTED',
  'PROJECT_ARCHIVED',
  'TENANT_ARCHIVED',
  'PROJECT_KEY_IMMUTABLE',
  'TASK_TYPE_IN_USE',
  'STATUS_IN_USE',
  'SLUG_TAKEN',
  'INVALID_RESET_TOKEN',
  'RATE_LIMITED',
  /** A database query exceeded its `maxTimeMS` budget and was aborted server-side. */
  'QUERY_TIMEOUT',
  /**
   * A task number could not be allocated within the bounded retry of the
   * `tasks {projectId, number}` uniqueness race — a transient, retryable server
   * condition (503), NOT a client conflict. Additive to the §14.3 list, exactly
   * as F11 did for `QUERY_TIMEOUT`; the driver error never reaches the client.
   */
  'TASK_NUMBER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

/** All error codes from the technical specification §14.3 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Standard error response returned by API endpoints on failure */
export interface ErrorResponse {
  error: {
    /** Machine-readable error code (e.g., "VALIDATION_ERROR", "NOT_FOUND") */
    code: ErrorCode | string;
    /** Human-readable error message */
    message: string;
    /** Optional additional error details (field-level validation errors, etc.) */
    details?: Record<string, unknown>;
  };
}

/** Support request body type */
export interface SupportRequest {
  name: string;
  email: string;
  message: string;
}
