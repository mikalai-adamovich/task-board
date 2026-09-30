import { valuesOf } from '../utils/values-of.js';

/**
 * Type-safe enum-like constants.
 * Each constant provides the value object, the union type, and a values tuple.
 * All values are UPPERCASE per v5 spec.
 */

// ─── TenantRole ──────────────────────────────────────────────────────────────
export const TenantRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
} as const;

export type TenantRole = (typeof TenantRole)[keyof typeof TenantRole];
export const TenantRoleValues = valuesOf(TenantRole);

// ─── ProjectRole ─────────────────────────────────────────────────────────────
export const ProjectRole = {
  PROJECT_ADMIN: 'PROJECT_ADMIN',
  EDITOR: 'EDITOR',
  VIEWER: 'VIEWER',
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];
export const ProjectRoleValues = valuesOf(ProjectRole);

// TaskPriority was replaced by TASK_PRIORITY_CONFIG (numeric priorityLevel) —
// see constants/priority.ts.

// ─── SprintStatus ────────────────────────────────────────────────────────────
export const SprintStatus = {
  FUTURE: 'FUTURE',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
} as const;

export type SprintStatus = (typeof SprintStatus)[keyof typeof SprintStatus];
export const SprintStatusValues = valuesOf(SprintStatus);

// ─── MemberStatus ────────────────────────────────────────────────────────────
export const MemberStatus = {
  ACTIVE: 'ACTIVE',
  ACCESS_REVOKED: 'ACCESS_REVOKED',
} as const;

export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];
export const MemberStatusValues = valuesOf(MemberStatus);

// ─── InvitationStatus ────────────────────────────────────────────────────────
export const InvitationStatus = {
  PENDING: 'PENDING',
  EXPIRED: 'EXPIRED',
  DECLINED: 'DECLINED',
  REVOKED: 'REVOKED',
} as const;

export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];
export const InvitationStatusValues = valuesOf(InvitationStatus);

// ─── TaskRelationshipType ────────────────────────────────────────────────────
export const TaskRelationshipType = {
  BLOCKS: 'BLOCKS',
  RELATES_TO: 'RELATES_TO',
  DUPLICATES: 'DUPLICATES',
} as const;

export type TaskRelationshipType = (typeof TaskRelationshipType)[keyof typeof TaskRelationshipType];
export const TaskRelationshipTypeValues = valuesOf(TaskRelationshipType);

// ─── TenantStatus ────────────────────────────────────────────────────────────
export const TenantStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
  DELETION_PENDING: 'DELETION_PENDING',
} as const;

export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];
export const TenantStatusValues = valuesOf(TenantStatus);

// ─── ProjectStatus ───────────────────────────────────────────────────────────
export const ProjectStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
  DELETION_PENDING: 'DELETION_PENDING',
} as const;

export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];
export const ProjectStatusValues = valuesOf(ProjectStatus);

// ─── ArchiveReason ───────────────────────────────────────────────────────────
export const ArchiveReason = {
  TENANT_ARCHIVE: 'TENANT_ARCHIVE',
  PROJECT_ARCHIVE: 'PROJECT_ARCHIVE',
} as const;

export type ArchiveReason = (typeof ArchiveReason)[keyof typeof ArchiveReason];
export const ArchiveReasonValues = valuesOf(ArchiveReason);

// ─── AuditAction ─────────────────────────────────────────────────────────────
export const AuditAction = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  DELETED: 'DELETED',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
export const AuditActionValues = valuesOf(AuditAction);

// ─── AuditEntityType ─────────────────────────────────────────────────────────
export const AuditEntityType = {
  TASK: 'TASK',
  PROJECT: 'PROJECT',
  /**
   * The workspace itself. A tenant creation used to be logged as `PROJECT`,
   * which put a tenant id into the project-labelled column of the audit log
   * The enrichment service already resolved a `TENANT` label, nothing
   * could produce one.
   */
  TENANT: 'TENANT',
  /**
   * A workspace membership — the dataset whose purpose is "who may see what".
   * Every grant, revoke, expiry and role change writes one event of this type
   * The enrichment service already resolves a membership to its user's
   * display name; without this member nothing could produce one.
   */
  MEMBERSHIP: 'MEMBERSHIP',
  SPRINT: 'SPRINT',
  STATUS: 'STATUS',
  BOARD: 'BOARD',
  LABEL: 'LABEL',
  TASK_TYPE: 'TASK_TYPE',
  COMMENT: 'COMMENT',
  TASK_RELATIONSHIP: 'TASK_RELATIONSHIP',
} as const;

export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];
export const AuditEntityTypeValues = valuesOf(AuditEntityType);
