import { describe, it, expect, beforeEach } from 'vitest';
import { TenantRole } from '@task-board/shared';
import { RbacService, isTenantAdmin } from './rbac.service.js';

/**
 * F24, TASK 2 — `isTenantAdmin` replaced twelve hand-written
 * `role !== OWNER && role !== ADMIN` guards. The whole point of the swap is that
 * the allow-list is no longer a second copy of the rule, so these specs assert
 * that the predicate is exactly the matrix row and nothing else: the twelve call
 * sites kept their own 403 messages, and the set of admitted roles must not have
 * moved by even one member.
 */
describe('isTenantAdmin (F24)', () => {
  it('admits exactly the manage_tenant allow-list of the matrix', () => {
    expect(isTenantAdmin(TenantRole.OWNER)).toBe(true);
    expect(isTenantAdmin(TenantRole.ADMIN)).toBe(true);
  });

  it('refuses every non-admin tenant role, including the project roles', () => {
    for (const role of ['MEMBER', 'VIEWER', 'EDITOR', 'PROJECT_ADMIN', 'GUEST', '', 'owner', 'ADMIN ']) {
      expect(isTenantAdmin(role)).toBe(false);
    }
  });

  it('agrees with the matrix on every tenant role, by construction', () => {
    const service = new RbacService();

    for (const role of Object.values(TenantRole)) {
      expect(isTenantAdmin(role)).toBe(service.can(role, null, 'manage_tenant'));
    }
  });

  it('ignores the project role — a project PROJECT_ADMIN is not a tenant admin', () => {
    // This is the load-bearing property of the project.service guard: it is
    // called with `projectRole: null`, so a project seat can never satisfy it.
    const service = new RbacService();

    expect(service.can('MEMBER', 'PROJECT_ADMIN', 'manage_project')).toBe(true);
    expect(isTenantAdmin('MEMBER')).toBe(false);
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RbacService', () => {
  let service: RbacService;

  beforeEach(() => {
    service = new RbacService();
  });

  // ── Tenant-level actions ─────────────────────────────────────────────────

  describe('tenant-level actions', () => {
    it('allows OWNER to manage_tenant', () => {
      expect(service.can('OWNER', null, 'manage_tenant')).toBe(true);
    });

    it('allows ADMIN to manage_tenant', () => {
      expect(service.can('ADMIN', null, 'manage_tenant')).toBe(true);
    });

    it('denies MEMBER from manage_tenant', () => {
      expect(service.can('MEMBER', null, 'manage_tenant')).toBe(false);
    });

    it('allows OWNER to create_project', () => {
      expect(service.can('OWNER', null, 'create_project')).toBe(true);
    });

    it('allows ADMIN to create_project', () => {
      expect(service.can('ADMIN', null, 'create_project')).toBe(true);
    });

    it('denies MEMBER from create_project', () => {
      expect(service.can('MEMBER', null, 'create_project')).toBe(false);
    });
  });

  // ── Project-level actions with owner bypass ──────────────────────────────

  describe('project-level actions — owner bypass', () => {
    it('allows OWNER to create_task without project role', () => {
      expect(service.can('OWNER', null, 'create_task')).toBe(true);
    });

    it('allows OWNER to delete_task without project role', () => {
      expect(service.can('OWNER', null, 'delete_task')).toBe(true);
    });

    it('allows OWNER to manage_project_members without project role', () => {
      expect(service.can('OWNER', null, 'manage_project_members')).toBe(true);
    });

    it('allows OWNER to view_audit_events without project role', () => {
      expect(service.can('OWNER', null, 'view_audit_events')).toBe(true);
    });
  });

  // ── Project-level actions with admin bypass ──────────────────────────────

  describe('project-level actions — admin bypass', () => {
    it('allows ADMIN to create_task without project role', () => {
      expect(service.can('ADMIN', null, 'create_task')).toBe(true);
    });

    it('allows ADMIN to delete_task without project role', () => {
      expect(service.can('ADMIN', null, 'delete_task')).toBe(true);
    });

    it('allows ADMIN to manage_project without project role', () => {
      expect(service.can('ADMIN', null, 'manage_project')).toBe(true);
    });
  });

  // ── Project-level actions with project roles ─────────────────────────────

  describe('project-level actions — project roles', () => {
    it('allows PROJECT_ADMIN to create_task', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'create_task')).toBe(true);
    });

    it('allows EDITOR to create_task', () => {
      expect(service.can('MEMBER', 'EDITOR', 'create_task')).toBe(true);
    });

    it('denies VIEWER from create_task', () => {
      expect(service.can('MEMBER', 'VIEWER', 'create_task')).toBe(false);
    });

    it('allows EDITOR to edit_task', () => {
      expect(service.can('MEMBER', 'EDITOR', 'edit_task')).toBe(true);
    });

    it('denies VIEWER from edit_task', () => {
      expect(service.can('MEMBER', 'VIEWER', 'edit_task')).toBe(false);
    });

    it('allows PROJECT_ADMIN to delete_task', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'delete_task')).toBe(true);
    });

    it('denies EDITOR from delete_task', () => {
      expect(service.can('MEMBER', 'EDITOR', 'delete_task')).toBe(false);
    });

    it('allows VIEWER to view_task', () => {
      expect(service.can('MEMBER', 'VIEWER', 'view_task')).toBe(true);
    });

    it('allows EDITOR to view_task', () => {
      expect(service.can('MEMBER', 'EDITOR', 'view_task')).toBe(true);
    });

    it('allows PROJECT_ADMIN to manage_project_members', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'manage_project_members')).toBe(true);
    });

    it('denies EDITOR from manage_project_members', () => {
      expect(service.can('MEMBER', 'EDITOR', 'manage_project_members')).toBe(false);
    });

    it('denies VIEWER from manage_project_members', () => {
      expect(service.can('MEMBER', 'VIEWER', 'manage_project_members')).toBe(false);
    });

    it('allows PROJECT_ADMIN to manage_project', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'manage_project')).toBe(true);
    });

    it('denies EDITOR from manage_project', () => {
      expect(service.can('MEMBER', 'EDITOR', 'manage_project')).toBe(false);
    });

    it('allows PROJECT_ADMIN to create_sprint', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'create_sprint')).toBe(true);
    });

    it('denies EDITOR from create_sprint', () => {
      expect(service.can('MEMBER', 'EDITOR', 'create_sprint')).toBe(false);
    });

    it('allows PROJECT_ADMIN to manage_boards', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'manage_boards')).toBe(true);
    });

    it('denies EDITOR from manage_boards', () => {
      expect(service.can('MEMBER', 'EDITOR', 'manage_boards')).toBe(false);
    });

    it('allows EDITOR to create_comment', () => {
      expect(service.can('MEMBER', 'EDITOR', 'create_comment')).toBe(true);
    });

    it('denies VIEWER from create_comment', () => {
      expect(service.can('MEMBER', 'VIEWER', 'create_comment')).toBe(false);
    });

    it('allows VIEWER to view_comment', () => {
      expect(service.can('MEMBER', 'VIEWER', 'view_comment')).toBe(true);
    });

    it('allows EDITOR to manage_task_relationships', () => {
      expect(service.can('MEMBER', 'EDITOR', 'manage_task_relationships')).toBe(true);
    });

    it('denies VIEWER from manage_task_relationships', () => {
      expect(service.can('MEMBER', 'VIEWER', 'manage_task_relationships')).toBe(false);
    });

    it('allows VIEWER to manage_filters', () => {
      expect(service.can('MEMBER', 'VIEWER', 'manage_filters')).toBe(true);
    });

    it('allows all project roles to view_task_history (DEC-021)', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'view_task_history')).toBe(true);
      expect(service.can('MEMBER', 'EDITOR', 'view_task_history')).toBe(true);
      expect(service.can('MEMBER', 'VIEWER', 'view_task_history')).toBe(true);
    });

    it('denies view_task_history without a project role (tenant MEMBER)', () => {
      expect(service.can('MEMBER', null, 'view_task_history')).toBe(false);
    });

    it('allows tenant OWNER/ADMIN to view_task_history via bypass', () => {
      expect(service.can('OWNER', null, 'view_task_history')).toBe(true);
      expect(service.can('ADMIN', null, 'view_task_history')).toBe(true);
    });

    it('keeps view_audit_events restricted to PROJECT_ADMIN (+ tenant bypass)', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'view_audit_events')).toBe(true);
      expect(service.can('OWNER', null, 'view_audit_events')).toBe(true);
    });

    it('allows PROJECT_ADMIN to view_audit_events', () => {
      expect(service.can('MEMBER', 'PROJECT_ADMIN', 'view_audit_events')).toBe(true);
    });

    it('denies EDITOR from view_audit_events', () => {
      expect(service.can('MEMBER', 'EDITOR', 'view_audit_events')).toBe(false);
    });

    it('denies VIEWER from view_audit_events', () => {
      expect(service.can('MEMBER', 'VIEWER', 'view_audit_events')).toBe(false);
    });
  });

  // ── No project membership ────────────────────────────────────────────────

  describe('no project membership', () => {
    it('denies MEMBER without project role from project-level actions', () => {
      expect(service.can('MEMBER', null, 'create_task')).toBe(false);
      expect(service.can('MEMBER', null, 'view_task')).toBe(false);
      expect(service.can('MEMBER', null, 'manage_project')).toBe(false);
    });

    it('denies MEMBER with undefined project role', () => {
      expect(service.can('MEMBER', undefined, 'create_task')).toBe(false);
    });
  });

  // ── Viewer cannot write ──────────────────────────────────────────────────

  describe('viewer cannot write', () => {
    it('denies VIEWER from all write actions', () => {
      const writeActions = [
        'create_task',
        'edit_task',
        'delete_task',
        'manage_project',
        'manage_project_members',
        'create_sprint',
        'change_sprint_status',
        'edit_project_config',
        'manage_statuses',
        'manage_boards',
        'create_comment',
        'edit_comment',
        'delete_comment',
        'view_audit_events',
      ] as const;

      for (const action of writeActions) {
        expect(service.can('MEMBER', 'VIEWER', action)).toBe(false);
      }
    });
  });

  // The `getEffectiveRole` block moved with the method — it was a dead
  // descriptive helper duplicating the "tenant Owner/Admin supersedes the project
  // role" rule. The authoritative copy of that rule is the RBAC matrix exercised
  // by the `can()` blocks above, which are unchanged.
});
