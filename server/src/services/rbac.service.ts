import { TenantRole, ProjectRole } from '@task-board/shared';
import { ForbiddenError } from '../errors/app-error.js';

// ─── Permission Actions ──────────────────────────────────────────────────────

/**
 * All permission actions in the v5 system.
 * Derived from the spec §2.4 permission matrix.
 */
export type PermissionAction =
  | 'manage_tenant'
  | 'create_project'
  | 'manage_project'
  | 'manage_project_members'
  | 'create_sprint'
  | 'change_sprint_status'
  | 'edit_project_config'
  | 'create_task'
  | 'edit_task'
  | 'delete_task'
  | 'view_task'
  | 'manage_labels'
  | 'manage_statuses'
  | 'manage_boards'
  | 'create_comment'
  | 'edit_comment'
  | 'delete_comment'
  | 'view_comment'
  | 'manage_task_relationships'
  | 'manage_filters'
  | 'view_task_history'
  | 'view_audit_events';

// ─── Permission Matrix ───────────────────────────────────────────────────────

/**
 * Tenant-level-only permission matrix.
 * Maps action → allowed tenant roles.
 *
 * From spec §2.4:
 * - Manage Tenant: Owner, Admin
 * - Create Project: Owner, Admin
 */
const tenantPermissions: Record<string, TenantRole[]> = {
  manage_tenant: [TenantRole.OWNER, TenantRole.ADMIN],
  create_project: [TenantRole.OWNER, TenantRole.ADMIN],
};
/**
 * Project-level permission matrix.
 * Maps action → allowed project roles.
 *
 * Tenant Owner/Admin bypass all project-level restrictions (see can() method).
 *
 * From spec §2.4 permission matrix:
 *
 * | Action                    | Project Admin | Editor | Viewer |
 * |---------------------------|:---:|:---:|:---:|
 * | manage_project            | Yes | No  | No  |
 * | manage_project_members    | Yes | No  | No  |
 * | create_sprint             | Yes | No  | No  |
 * | change_sprint_status      | Yes | No  | No  |
 * | edit_project_config       | Yes | No  | No  |
 * | create_task / edit_task   | Yes | Yes | No  |
 * | delete_task               | Yes | No  | No  |
 * | view_task                 | Yes | Yes | Yes |
 * | manage_labels             | Yes | Limited* | No  |
 * | manage_statuses           | Yes | No  | No  |
 * | manage_boards             | Yes | No  | No  |
 * | create/edit/delete comment| Yes | Yes | No  |
 * | view_comment              | Yes | Yes | Yes |
 * | manage_task_relationships | Yes | Yes | No  |
 * | manage_filters            | Yes | Yes | Yes |
 * | view_task_history         | Yes | Yes | Yes |
 * | view_audit_events         | Yes | No  | No  |
 *
 * *Limited = editors can create labels from task but not bulk-delete (enforced at service level)
 */
const projectPermissions: Record<string, ProjectRole[]> = {
  manage_project: [ProjectRole.PROJECT_ADMIN],
  manage_project_members: [ProjectRole.PROJECT_ADMIN],
  create_sprint: [ProjectRole.PROJECT_ADMIN],
  change_sprint_status: [ProjectRole.PROJECT_ADMIN],
  edit_project_config: [ProjectRole.PROJECT_ADMIN],
  create_task: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  edit_task: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  delete_task: [ProjectRole.PROJECT_ADMIN],
  view_task: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR, ProjectRole.VIEWER],
  manage_labels: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  manage_statuses: [ProjectRole.PROJECT_ADMIN],
  manage_boards: [ProjectRole.PROJECT_ADMIN],
  create_comment: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  edit_comment: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  delete_comment: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  view_comment: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR, ProjectRole.VIEWER],
  manage_task_relationships: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR],
  manage_filters: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR, ProjectRole.VIEWER],
  // Task History is daily-use and visible to all project roles;
  // administrative audit events stay PROJECT_ADMIN-only (+ tenant bypass).
  view_task_history: [ProjectRole.PROJECT_ADMIN, ProjectRole.EDITOR, ProjectRole.VIEWER],
  view_audit_events: [ProjectRole.PROJECT_ADMIN],
};

// ─── RBAC Service ────────────────────────────────────────────────────────────

/**
 * Evaluates permission based on tenant role and optional project role.
 *
 * Rules (from spec §2.4):
 * - Tenant Owner and Admin bypass all project-level restrictions.
 * - Viewers are strictly read-only for Tasks and related actions.
 * - Editors can manage Labels within product-defined limits (enforced at service level).
 * - All authorization is enforced server-side.
 */
export class RbacService {
  // `getEffectiveRole(tenantRole, projectRole)` was removed as dead code.
  // It had no caller: authorization goes through `can()` / `ensurePermission()`,
  // which encode the same "tenant Owner/Admin supersedes the project role" rule
  // directly in the RBAC matrix — the authoritative copy. A descriptive helper
  // that nothing reads is a second copy of a security rule, i.e. drift waiting to
  // happen; the rule and its tests stay in `can()`.

  /**
   * Check if the given role combination permits the specified action.
   *
   * @param tenantRole - The user's role within the tenant
   * @param projectRole - The user's role within the project (null if not a project member)
   * @param action - The permission action to check
   * @returns true if the action is permitted, false otherwise
   */
  can(
    tenantRole: TenantRole | string,
    projectRole: ProjectRole | string | null | undefined,
    action: PermissionAction,
  ): boolean {
    // ── Tenant-level-only actions ──────────────────────────────────────────
    if (action in tenantPermissions) {
      return this.checkTenantAction(tenantRole, action);
    }

    // ── Project-level actions ──────────────────────────────────────────────
    // Tenant owners bypass all project-level restrictions
    if (tenantRole === TenantRole.OWNER) {
      return true;
    }

    // Tenant admins bypass project-level restrictions
    if (tenantRole === TenantRole.ADMIN) {
      return true;
    }

    // No project membership → no access to project-level actions
    if (!projectRole) {
      return false;
    }

    // Check project-level permission
    return this.checkProjectAction(projectRole, action);
  }

  /**
   * Check if a tenant-level role is allowed for a tenant-level action.
   */
  private checkTenantAction(tenantRole: string, action: string): boolean {
    const allowedRoles = tenantPermissions[action];

    if (!allowedRoles) {
      return false;
    }

    return allowedRoles.includes(tenantRole as TenantRole);
  }

  /**
   * Check if a project-level role is allowed for a project-level action.
   */
  private checkProjectAction(projectRole: string, action: string): boolean {
    const allowedRoles = projectPermissions[action];

    if (!allowedRoles) {
      return false;
    }

    return allowedRoles.includes(projectRole as ProjectRole);
  }
}

// ─── Imperative Guard (for domain services) ──────────────────────────────────

/**
 * Require the given action or throw {@link ForbiddenError}.
 *
 * Single source of truth for fine-grained checks inside domain services —
 * use this instead of hand-rolled role comparisons.
 */
export function ensurePermission(
  action: PermissionAction,
  tenantRole: TenantRole | string,
  projectRole?: ProjectRole | string | null,
): void {
  if (!new RbacService().can(tenantRole, projectRole, action)) {
    throw new ForbiddenError(`Insufficient permissions. Requires '${action}'.`);
  }
}

// guardrail:no-module-level-service 2026-09-29 — `RbacService` holds no state
// and no database handle: `can()` is a pure read of the RBAC matrix, and
// `ensurePermission()` deliberately constructs its own throwaway instance rather
// than depending on this binding. A module-level instance therefore captures
// nothing request-scoped, which is what P-02 forbids. See
// `rules/guardrails.guardrail.test.ts`.
/** Singleton RBAC service instance */
export const rbacService = new RbacService();

/**
 * "may this tenant role administer the workspace itself?" — the
 * `manage_tenant` row of the matrix, named.
 *
 * Twelve request-path guards used to answer this with a hand-written
 * `role !== TenantRole.OWNER && role !== TenantRole.ADMIN` (tenant.service,
 * tenant-member.service, project.service). Each was a second copy of a rule the
 * matrix already owns, and the copies could only ever drift apart. This predicate
 * keeps ONE allow-list — the matrix's — while leaving each caller's own 403
 * message intact, which is why the guards keep throwing their domain errors
 * rather than routing through `ensurePermission`.
 */
export function isTenantAdmin(tenantRole: TenantRole | string): boolean {
  return rbacService.can(tenantRole, null, 'manage_tenant');
}
