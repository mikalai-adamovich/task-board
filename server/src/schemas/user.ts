import * as z from 'zod';

/**
 * User entity schema.
 * Represents a user in the system. Note: passwordHash is intentionally
 * excluded from the shared package — it is server-only.
 */
export const UserSchema = z.object({
  /** Unique user identifier (UUID v4) */
  id: z.uuid(),
  /** User's email address */
  email: z.email({ pattern: z.regexes.html5Email }),
  /** User's display name */
  displayName: z.string().min(1).max(100),
  /** URL to the user's avatar image (null if not set) */
  avatarUrl: z.string().nullable(),
  /** Account creation timestamp (ISO 8601) */
  createdAt: z.iso.datetime(),
  /** Last update timestamp (ISO 8601) */
  updatedAt: z.iso.datetime(),
  /** Soft-deletion timestamp (ISO 8601, null if active) */
  deletedAt: z.iso.datetime().nullable(),
});

// `CreateUserSchema` was removed as dead code. Registration is served by
// `RegisterSchema` in this same file (which also applies the tenant-slug rules);
// this one had no caller and, being a second definition of the same body, could
// only drift from the endpoint that actually validates it.
