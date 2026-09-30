import type { TenantRole, TenantStatus, MemberStatus, InvitationStatus } from '../constants/roles.js';

/** Identity snapshot — denormalized display name at time of action */
export interface IdentitySnapshot {
  displayName: string;
}

/** Tenant (organization) entity type */
export interface Tenant {
  /** Unique tenant identifier (UUID v4) */
  id: string;
  /** Tenant display name */
  name: string;
  /** Globally unique URL slug, auto-generated from the name */
  slug: string;
  /** Optional description of the tenant */
  description: string | null;
  /** Tenant lifecycle status */
  status: TenantStatus;
  /** Scheduled deletion timestamp (ISO 8601, null if not scheduled) */
  deletionScheduledAt: string | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * Create tenant request body type.
 *
 * `| undefined` on every optional field — these interfaces model Zod parse
 * output and `exactOptionalPropertyTypes` distinguishes "key absent" from
 * "key present with value undefined". See `CreateProject` for the rationale.
 */
export interface CreateTenant {
  name: string;
  /** Optional URL slug; auto-generated from the name when omitted */
  slug?: string | undefined;
  description?: string | undefined;
}

/** Update tenant request body type — see {@link CreateTenant} */
export interface UpdateTenant {
  name?: string | undefined;
  description?: string | undefined;
}

/** Invitation embedded in a TenantMember */
export interface Invitation {
  /** Current invitation status */
  status: InvitationStatus;
  /** Hashed invitation token */
  tokenHash: string;
  /** User ID of the person who sent the invitation */
  invitedBy: string;
  /** Timestamp when the invitation was sent (ISO 8601) */
  invitedOn: string;
}

/** Tenant member type */
export interface TenantMember {
  /** Unique member identifier (UUID v4) */
  id: string;
  /** Tenant ID */
  tenantId: string;
  /** User ID of the member */
  userId: string;
  /** Role of the user within the tenant */
  role: TenantRole;
  /** Member status */
  status: MemberStatus;
  /**
   * Membership expiration timestamp (ISO 8601, null = no expiration).
   * On/after this date the member is treated as ACCESS_REVOKED
   * (lazy evaluation at access time) — the membership record, projects and
   * roles are kept so access can be restored anytime.
   */
  expiresAt: string | null;
  /** Embedded invitation data (null for direct members) */
  invitation: Invitation | null;
  /** Resolved user display name (null if user deleted/not found) */
  displayName: string | null;
  /** Resolved user email (null if user deleted/not found) */
  email: string | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * Pending invitation for the authenticated user, enriched with the tenant name (GET /invitations/my)
 *
 * Source of truth: `MyInvitationSchema` in `server/src/schemas/tenant.ts` — shared/ is
 * runtime-library-free, so the Zod schema lives server-side and this interface mirrors it.
 * Parity is enforced by a compile-time equality test in `server/src/schemas/tenant.test.ts`.
 */
export interface MyInvitation extends TenantMember {
  /** Display name of the tenant the invitation belongs to */
  tenantName: string;
}
