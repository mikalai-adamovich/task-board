import * as z from 'zod';

/**
 * Validates that a string is a valid identifier.
 * Accepts either UUID v4 format or MongoDB ObjectId format (24-char hex).
 *
 * This covers both auto-generated UUIDs and MongoDB's native _id format.
 */
export const uuid = () =>
  z
    .string()
    .refine(
      (val) =>
        /^[0-9a-fA-F]{24}$/.test(val) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(val),
      'Invalid ID format — must be a UUID or 24-character hex string',
    );

/**
 * Validates that a string is a URL-friendly slug.
 * Rules: lowercase letters, numbers, and hyphens only.
 * Must start and end with an alphanumeric character.
 * Minimum 2 characters, maximum 80.
 */
export const slug = () =>
  z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(80, 'Slug must be at most 80 characters')
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      'Slug must contain only lowercase letters, numbers, and hyphens, and must start/end with an alphanumeric character',
    );

/**
 * Validates a non-empty string with a maximum length.
 */
export const nonEmptyString = (maxLength: number, fieldName = 'Field') =>
  z
    .string()
    .min(1, `${fieldName} cannot be empty`)
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`);

/**
 * Validates an optional string with a maximum length.
 */
export const optionalString = (maxLength: number) => z.string().max(maxLength).optional();

/**
 * Validates a nullable optional string with a maximum length.
 */
export const nullableOptionalString = (maxLength: number) => z.string().max(maxLength).nullable().optional();

/**
 * Validates an email address with normalization (toLowerCase + trim).
 * The transform ensures the stored value is always normalized.
 */
export const email = () =>
  z
    .string()
    .email({ message: 'Invalid email address', pattern: z.regexes.html5Email })
    .transform((val) => val.toLowerCase().trim());

/**
 * Validates an ISO 8601 datetime string.
 */
export const isoDateTime = () => z.iso.datetime();

/**
 * Validates a nullable ISO 8601 datetime string.
 */
export const nullableIsoDateTime = () => z.iso.datetime().nullable();
