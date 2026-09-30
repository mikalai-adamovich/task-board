import * as z from 'zod';

/**
 * Standard error response schema per v5 spec §7.3.
 * All API errors return this shape wrapped in `{ error: { ... } }`.
 */
export const ErrorResponseSchema = z.object({
  /** Machine-readable error code (e.g., "VALIDATION_ERROR", "NOT_FOUND") */
  code: z.string(),
  /** Human-readable error message */
  message: z.string(),
  /** Optional additional error details (field-level validation errors, etc.) */
  details: z.unknown().optional(),
});

/**
 * Pagination metadata included in paginated responses.
 */
export const PaginationMetaSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

// NOTE: `WrappedErrorResponseSchema`, the two free-form sort query schemas
// (see `sort-field.guardrail.test.ts`) and the generic paginated-response factory
// were removed as dead code.
//
// The two sort schemas were additionally a latent NoSQL/DoS vector: their `sort`
// accepted ANY field name, so wiring either one up would have let a client sort
// on an arbitrary, unindexed, dotted field — a guaranteed COLLSCAN. They were
// never wired up (`TaskQuerySchema` uses a closed 11-field allow-list; the audit
// list hard-codes `createdAt`), but "unreachable today" is not a property a
// schema should rely on. `schemas/sort-field.guardrail.test.ts` now asserts
// behaviourally that no arbitrary-field sort regex can come back, and sweeps
// `schemas/` + `validators/` for the pattern so a permissive sort cannot be
// reintroduced unwired.
//
// The response wrapper is likewise gone: no response was ever validated with it,
// which is why it could sit here claiming to be the envelope contract.
