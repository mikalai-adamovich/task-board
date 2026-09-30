import * as z from 'zod';
import { TenantRole } from '@task-board/shared';
import {
  TenantRoleValues,
  MemberStatusValues,
  TenantStatusValues,
  InvitationStatusValues,
  TENANT_SLUG_MAX_LENGTH,
  TENANT_SLUG_PATTERN,
  // The client mirrors these bounds in its forms, so they live in the
  // shared package and BOTH sides derive from them.
  TENANT_NAME_MAX_LENGTH,
  TENANT_DESCRIPTION_MAX_LENGTH,
} from '@task-board/shared';
import {
  uuid,
  nonEmptyString,
  optionalString,
  nullableOptionalString,
  email,
  isoDateTime,
  nullableIsoDateTime,
} from '../validators/common.js';

/**
 * Tenant slug validator: lowercase `[a-z0-9-]`, no leading/trailing
 * hyphen, max 48 characters.
 */
export const tenantSlug = () =>
  z
    .string()
    .max(TENANT_SLUG_MAX_LENGTH, `Slug must be at most ${TENANT_SLUG_MAX_LENGTH} characters`)
    .regex(
      TENANT_SLUG_PATTERN,
      'Slug must contain only lowercase letters, numbers, and hyphens, and must start/end with an alphanumeric character',
    );

/**
 * Tenant (organization) entity schema.
 */
export const TenantSchema = z.object({
  id: uuid(),
  name: nonEmptyString(TENANT_NAME_MAX_LENGTH, 'Tenant name'),
  slug: tenantSlug(),
  description: nullableOptionalString(TENANT_DESCRIPTION_MAX_LENGTH),
  status: z.enum(TenantStatusValues),
  deletionScheduledAt: nullableIsoDateTime(),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
});

/**
 * Schema for creating a new tenant. The slug is optional — it is generated
 * from the name when omitted.
 */
export const CreateTenantSchema = z.object({
  name: nonEmptyString(TENANT_NAME_MAX_LENGTH, 'Tenant name'),
  slug: tenantSlug().optional(),
  description: optionalString(TENANT_DESCRIPTION_MAX_LENGTH),
});

/**
 * Query schema for GET /tenants/slug-available.
 */
export const SlugAvailableQuerySchema = z.object({
  slug: z.string().min(1),
});

/**
 * Schema for updating an existing tenant.
 */
export const UpdateTenantSchema = z.object({
  name: nonEmptyString(TENANT_NAME_MAX_LENGTH, 'Tenant name').optional(),
  description: optionalString(TENANT_DESCRIPTION_MAX_LENGTH),
});

// `TenantMemberSchema` was removed as dead code (unwired response schema —
// it validated nothing; the membership contract is the shared `TenantMember`
// interface).

/**
 * Roles a tenant member can be invited/updated TO — ADMIN or MEMBER, never
 * OWNER (ownership transfer is a separate, explicit operation).
 *
 * This replaces the positional slice `TenantRoleValues[1..2] as
 * [string, ...string[]]`. That cast WIDENED the inferred field type back to
 * `string`, so `InviteMemberSchema.shape.role` was typed `string` even though it
 * only accepted two values at runtime — the schema and the shared union
 * disagreed in the type system, and `schemas/shared-parity.test.ts` (compile-time
 * gate) fails on it. Naming the two members from the shared constant also stops
 * the slice from silently changing meaning if `TenantRole` is ever reordered.
 */
const INVITEABLE_ROLES = [TenantRole.ADMIN, TenantRole.MEMBER] as const;

/**
 * Schema for inviting a new member to a tenant.
 * Role must be ADMIN or MEMBER (not OWNER).
 */
export const InviteMemberSchema = z.object({
  email: email(),
  role: z.enum(INVITEABLE_ROLES),
});

// `UpdateMemberRoleSchema` was removed as dead code — superseded by
// `UpdateMemberSchema` (the DEC-055 full member PATCH), which the
// PATCH /:tenantId/members/:memberUserId route actually validates.

/**
 * Full member update — role, expiration date and the underlying
 * user's profile (display name / email). All fields optional; the service
 * applies only the provided ones.
 */
export const UpdateMemberSchema = z.object({
  role: z.enum(INVITEABLE_ROLES).optional(),
  /** ISO 8601 datetime or null (null clears the expiration) */
  expiresAt: nullableIsoDateTime().optional(),
  /** Updates the underlying USER record's display name */
  name: nonEmptyString(200, 'Member name').optional(),
  /** Updates the underlying USER record's email (uniqueness enforced in the service) */
  email: email().optional(),
});

/**
 * Invitation embedded in a TenantMember (mirrors `shared/src/types/tenant.ts` `Invitation`).
 */
export const InvitationSchema = z.object({
  status: z.enum(InvitationStatusValues),
  tokenHash: z.string(),
  invitedBy: z.string(),
  invitedOn: isoDateTime(),
});

/**
 * Pending invitation for the authenticated user, enriched with the tenant name
 * (GET /invitations/my). Single source of truth for the shared `MyInvitation`
 * type — parity is enforced by a compile-time equality test in
 * `schemas/tenant.test.ts` (shared/ is runtime-library-free, so the Zod schema
 * lives server-side and the shared interface mirrors it).
 *
 * This is a read-boundary mapping schema, not a request validator: id fields are
 * plain strings (exactly like the shared type) and only the enum fields that the
 * former `as` casts papered over are validated. `tenantName` deliberately allows
 * `''` (the service falls back to it when the tenant lookup misses).
 */
export const MyInvitationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  role: z.enum(TenantRoleValues),
  status: z.enum(MemberStatusValues),
  /** Membership expiration (null = never expires) */
  expiresAt: nullableIsoDateTime(),
  invitation: InvitationSchema.nullable(),
  /** Resolved user display name (null if user deleted/not found) */
  displayName: z.string().nullable(),
  /** Resolved user email (null if user deleted/not found) */
  email: z.string().nullable(),
  /** Display name of the tenant the invitation belongs to */
  tenantName: z.string(),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
});

// `TenantWithRoleSchema` was removed as dead code (unwired response schema);
// the tenant-with-role shape is the shared `MyInvitation`/`TenantMember`
// projections the routes actually return.
