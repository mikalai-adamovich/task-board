import {
  MemberStatus,
  TenantRole,
  TenantStatus,
  ProjectStatus,
  ArchiveReason,
  generateSlugFromName,
  isValidTenantSlug,
  DELETION_GRACE_PERIOD_MS,
} from '@task-board/shared';
import type { Tenant, TenantMember, CreateTenant, UpdateTenant } from '@task-board/shared';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/app-error.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { TenantMemberRepository } from '../repositories/tenant-member.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import type { AuditService } from './audit.service.js';
import { isTenantAdmin } from './rbac.service.js';
import { assertNotLastOwner } from './tenant-member.service.js';

/** Minimal project repository interface for tenant cascade operations */
export interface TenantServiceProjectRepo {
  findByTenant(tenantId: string): Promise<{ id: string; status: string; archiveReason: string | null }[]>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
}

/**
 * The project cascade, as the WORKSPACE purge needs it.
 *
 * Structural and deliberately one method wide: the workspace purge must delete
 * every project it owns, and this is the only capability that can. It is
 * `ProjectService.purgeProjectData` in production — the same ordered,
 * root-last cascade a standalone project purge runs — passed here as a narrow
 * interface so this service cannot reach anything else, and so the unit specs
 * can hand in a one-method fake.
 */
export interface TenantPurgeProjectCascade {
  purgeProjectData(projectId: string): Promise<void>;
}

/** Minimal project-member repository interface for user-deletion cleanup */
export interface TenantServiceProjectMemberRepo {
  deleteByUserId(userId: string): Promise<void>;
}

// ─── Tenant Service ──────────────────────────────────────────────────────────

export class TenantService {
  /**
   * Every parameter is REQUIRED.
   *
   * `container.ts` used to pass literal `undefined, undefined` for
   * `projectRepo`/`auditService`; combined with the `if (this.x)` guards below
   * that silently disabled the tenant → project archive/restore cascade and all
   * tenant audit writes. Required params make the next omission a compile error.
   */
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly tenantMemberRepo: TenantMemberRepository,
    private readonly userRepo: UserRepository,
    private readonly projectRepo: TenantServiceProjectRepo,
    private readonly auditService: AuditService,
    private readonly projectMemberRepo: TenantServiceProjectMemberRepo,
    /**
     * REQUIRED. The workspace purge deletes every project the workspace
     * owns, and before this dependency existed that simply did not happen — the
     * purge removed memberships and the workspace document and left every
     * project, task, comment and audit row of every project behind. A purge that
     * silently skips its largest step is the failure mode this codebase has
     * already paid for once, so the dependency is a required constructor
     * parameter and `container.test.ts` asserts the real cascade is wired.
     */
    private readonly projectPurge: TenantPurgeProjectCascade,
  ) {}

  // ─── Tenant CRUD ──────────────────────────────────────────────────────────

  async createTenant(userId: string, input: CreateTenant): Promise<Tenant> {
    const slug = await this.resolveSlugForCreate(input);
    const tenant = await this.tenantRepo.create({ ...input, slug });

    await this.tenantMemberRepo.create({
      userId,
      tenantId: tenant.id,
      role: TenantRole.OWNER,
      status: MemberStatus.ACTIVE,
    });

    // Audit side effect — unconditional: the audit service is a required
    // dependency, so it is never conditionally skipped.
    //
    // This was logged as `PROJECT` ("closest entity type"), which put a
    // TENANT id into the project-labelled column: the enrichment service
    // resolved it through `projects`, found nothing, and rendered "Unknown".
    // The union now carries TENANT, and the enrichment service already resolves
    // it to the workspace name.
    await this.auditService.log({
      tenantId: tenant.id,
      projectId: null,
      entityType: 'TENANT',
      entityId: tenant.id,
      action: 'CREATED',
      actorId: userId,
    });

    // …and the creator's OWN membership is a membership transition like any
    // other: without it the audit log shows a workspace appearing with
    // no record of who was put in charge of it.
    await this.auditService.log({
      tenantId: tenant.id,
      projectId: null,
      entityType: 'MEMBERSHIP',
      entityId: userId,
      action: 'CREATED',
      actorId: userId,
      changes: [{ field: 'role', oldValue: null, newValue: TenantRole.OWNER }],
    });

    return tenant;
  }

  // `listTenantsForUser(userId)` was removed as dead code. The workspace
  // switcher reads its list from `ProjectRefStore` / the tenant-home route, which
  // resolve memberships through a different path; nothing called this method.

  async listTenantsWithRole(userId: string): Promise<(Tenant & { role: string })[]> {
    // One round-trip: memberships with tenant documents joined server-side
    // ($lookup) — replaces the previous findByUser → tenants.$in two-step.
    // Order: natural tenant_members order (same as findByUser had).
    const rows = await this.tenantMemberRepo.findByUserWithTenants(userId);

    return rows
      .filter((r) => r.membership.status === MemberStatus.ACTIVE && r.tenant !== null)
      .map((r) => {
        const tenant = r.tenant as Tenant;

        return { ...tenant, role: r.membership.role };
      });
  }

  async getTenant(id: string): Promise<Tenant> {
    const tenant = await this.tenantRepo.findById(id);

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }
    return tenant;
  }

  /**
   * Get a tenant for a specific requester — verifies membership first.
   * IDOR guard: `GET /tenants/:tenantId` must not expose arbitrary tenants
   * to any authenticated user.
   */
  async getTenantForUser(userId: string, id: string, precheckedMembership?: TenantMember): Promise<Tenant> {
    await this.requireMembership(userId, id, precheckedMembership);

    return this.getTenant(id);
  }

  /**
   * Check slug availability for the create-workspace form.
   *
   * Enumeration-safe: invalid slugs simply report as unavailable, without
   * distinguishing "invalid format" from "already taken".
   */
  async isSlugAvailable(slug: string): Promise<boolean> {
    if (!isValidTenantSlug(slug)) {
      return false;
    }

    return !(await this.tenantRepo.slugExists(slug));
  }

  async updateTenant(
    userId: string,
    id: string,
    input: UpdateTenant,
    precheckedMembership?: TenantMember,
  ): Promise<Tenant> {
    const membership = await this.requireMembership(userId, id, precheckedMembership);

    // The allow-list is the RBAC matrix's `manage_tenant` row again.
    if (!isTenantAdmin(membership.role)) {
      throw new ForbiddenError('Only owner or admin can update the tenant');
    }

    this.requireNotArchived(await this.getTenant(id));

    // F22 (latent bug the flag exposed): a PATCH body arrives with `undefined`
    // for every omitted field, and forwarding it verbatim put all keys into
    // `$set` — BSON writes `undefined` as `null`, so `PATCH /tenants/:id
    // {"name":"X"}` cleared `description`. Build the patch from defined keys only.
    const patch: { name?: string; description?: string } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;

    const tenant = await this.tenantRepo.update(id, patch);

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    return tenant;
  }

  // ─── Tenant Lifecycle ─────────────────────────────────────────────────────

  async deleteTenant(userId: string, id: string, precheckedMembership?: TenantMember): Promise<void> {
    const membership = await this.requireMembership(userId, id, precheckedMembership);

    if (membership.role !== TenantRole.OWNER) {
      throw new ForbiddenError('Only the owner can delete the tenant');
    }

    this.requireNotArchived(await this.getTenant(id));

    const deletionScheduledAt = new Date(Date.now() + DELETION_GRACE_PERIOD_MS);

    await this.tenantRepo.update(id, {
      status: TenantStatus.DELETION_PENDING,
      deletionScheduledAt,
    });
  }

  async archiveTenant(userId: string, id: string, precheckedMembership?: TenantMember): Promise<void> {
    const membership = await this.requireMembership(userId, id, precheckedMembership);

    if (!isTenantAdmin(membership.role)) {
      throw new ForbiddenError('Only owner or admin can archive the tenant');
    }

    const tenant = await this.getTenant(id);

    this.requireNotArchived(tenant);

    // Archive tenant
    await this.tenantRepo.update(id, { status: TenantStatus.ARCHIVED });

    // Archive all non-archived projects with TENANT_ARCHIVE reason
    const projects = await this.projectRepo.findByTenant(id);

    for (const project of projects) {
      if (project.status !== ProjectStatus.ARCHIVED) {
        await this.projectRepo.update(project.id, {
          status: 'ARCHIVED',
          archiveReason: 'TENANT_ARCHIVE',
        });
      }
    }
  }

  async restoreTenant(userId: string, id: string, precheckedMembership?: TenantMember): Promise<void> {
    const membership = await this.requireMembership(userId, id, precheckedMembership);

    if (!isTenantAdmin(membership.role)) {
      throw new ForbiddenError('Only owner or admin can restore the tenant');
    }

    await this.tenantRepo.update(id, {
      status: TenantStatus.ACTIVE,
      deletionScheduledAt: null,
    });

    // Restore only projects archived due to TENANT_ARCHIVE
    const projects = await this.projectRepo.findByTenant(id);

    for (const project of projects) {
      if (project.status === ProjectStatus.ARCHIVED && project.archiveReason === ArchiveReason.TENANT_ARCHIVE) {
        await this.projectRepo.update(project.id, {
          status: 'ACTIVE',
          archiveReason: null,
        });
      }
    }
  }

  async cancelDeletion(userId: string, id: string, precheckedMembership?: TenantMember): Promise<void> {
    const membership = await this.requireMembership(userId, id, precheckedMembership);

    if (membership.role !== TenantRole.OWNER) {
      throw new ForbiddenError('Only the owner can cancel deletion');
    }

    await this.tenantRepo.update(id, {
      status: TenantStatus.ACTIVE,
      deletionScheduledAt: null,
    });
  }

  async permanentDelete(id: string): Promise<void> {
    const tenant = await this.getTenant(id);

    if (tenant.status !== TenantStatus.DELETION_PENDING) {
      throw new AppError(400, 'CONFLICT', 'Tenant must be in DELETION_PENDING status');
    }

    await this.purgeTenantData(id);
  }

  /**
   * The unconditional, ordered WORKSPACE cascade.
   *
   * **The defect this replaces.** `permanentDelete` removed the memberships and
   * the workspace document and nothing else. Every project, task, comment,
   * relationship, sprint, board, label, status, task type, filter and counter of
   * every project in the workspace stayed resident, with no owner left to reach
   * it through the API and nothing scheduled to remove it. "Delete the workspace"
   * was a partial delete.
   *
   * **The order, and why a partial failure cannot orphan data.**
   * 1. every PROJECT, each through the full project cascade (which itself deletes
   *    its children before its own document, and appends its own audit record);
   * 2. the workspace MEMBERSHIPS;
   * 3. the audit RECORD of this purge;
   * 4. the workspace DOCUMENT — last.
   *
   * The workspace document is the reaper's only index into this work:
   * `PurgeService.findDue` selects workspaces still in `DELETION_PENDING`, so a
   * failure anywhere above leaves it in place, still selected on the next
   * scheduled run, and the whole cascade repeats over whatever is left. Every step
   * is a `deleteMany`-shaped or `deleteOne`-by-id operation, so re-running one is
   * a no-op on what it already removed. Nothing can be orphaned by a failure,
   * because the only document that could point at orphaned data is the one the
   * cascade has not deleted yet.
   *
   * **Audit rows are NOT deleted**: the retention window is a time-to-live
   * index, so the log leaves on a clock, not at a purge's discretion — and a
   * purge that deleted its own trail is what this decision removes. The record of
   * the purge is APPENDED instead, with a system actor, before the root delete.
   *
   * **No status check and no caller context**, deliberately: the scheduled
   * `PurgeService` calls this directly, and a workspace being destroyed takes its
   * `ACTIVE` projects with it — they do not each need their own grace period.
   * `permanentDelete` is the checked entry point and delegates here.
   */
  async purgeTenantData(id: string): Promise<void> {
    // 1. Projects — each one fully purged (children, memberships, its own audit
    //    record, then its document) before the next one is touched.
    const projects = await this.projectRepo.findByTenant(id);

    for (const project of projects) {
      await this.projectPurge.purgeProjectData(project.id);
    }

    // 2. Workspace memberships. After the projects, because a project membership
    //    is removed by its own project cascade and these are the workspace-level
    //    rows that remain.
    const members = await this.tenantMemberRepo.findByTenant(id);

    for (const member of members) {
      await this.tenantMemberRepo.delete(id, member.userId);
    }

    // 3. The record of this purge. Written before the root delete for the reason
    //    given in the module docs: a failure after this point leaves the workspace
    //    scheduled, and a retry re-records rather than losing the record.
    await this.auditService.logSystem({
      tenantId: id,
      projectId: null,
      entityType: 'TENANT',
      entityId: id,
      action: 'DELETED',
      changes: [
        {
          field: 'purged',
          oldValue: TenantStatus.DELETION_PENDING,
          newValue: `purged — ${projects.length} project(s) and all workspace data permanently removed`,
        },
      ],
    });

    // 4. ROOT LAST. Nothing above this line can be re-found once it is gone.
    await this.tenantRepo.delete(id);
  }

  // ─── User Deletion ─────────────────────────────────────────────────────────

  /**
   * Soft-delete a user.
   *
   * The requester must be an ACTIVE OWNER or ADMIN of at least one tenant that
   * the target user belongs to — cross-tenant deletion is rejected. On success
   * the user is soft-deleted AND all their live tenant/project memberships are
   * removed. Identity snapshots on tasks/comments remain untouched.
   *
   * The last-owner invariant (reused from {@link assertNotLastOwner}): this sweep
   * removes EVERY membership of the user at once, so it must first verify that
   * no tenant of theirs would be left without an active owner. Without the
   * check, an ADMIN of tenant A could delete a user who happens to be the sole
   * OWNER of unrelated tenant B and permanently brick B. The check runs over
   * ALL of the user's owner memberships BEFORE any write, so a refusal leaves
   * the database untouched (no partial application).
   */
  async deleteUser(requesterId: string, userId: string): Promise<void> {
    const targetUser = await this.userRepo.findById(userId);

    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    // Cannot delete yourself
    if (requesterId === userId) {
      throw new ForbiddenError('Cannot delete your own account');
    }

    // Requester must be OWNER/ADMIN of a tenant shared with the target user
    const targetMemberships = await this.tenantMemberRepo.findByUser(userId);
    let isAuthorized = false;

    for (const membership of targetMemberships) {
      const requesterMembership = await this.tenantMemberRepo.findByUserAndTenant(requesterId, membership.tenantId);

      // `isTenantAdmin` is the matrix; the ACTIVE/lazy-expiry check is the
      // DEC-055 membership rule and stays here — neither is an authorization
      // decision the caller can talk its way past.
      if (
        requesterMembership &&
        requesterMembership.status === MemberStatus.ACTIVE &&
        isTenantAdmin(requesterMembership.role)
      ) {
        isAuthorized = true;
        break;
      }
    }

    if (!isAuthorized) {
      throw new ForbiddenError('Only an owner or admin of the same tenant can delete a user');
    }

    // Refuse the WHOLE deletion if it would strip the last active owner of
    // any tenant — before the first write, so nothing is partially applied.
    for (const membership of targetMemberships) {
      if (membership.role !== TenantRole.OWNER || membership.status !== MemberStatus.ACTIVE) continue;

      try {
        await assertNotLastOwner(this.tenantMemberRepo, membership.tenantId, membership);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;

        const tenant = await this.tenantRepo.findById(membership.tenantId);
        const tenantLabel = tenant ? `"${tenant.name}"` : membership.tenantId;

        throw new ConflictError(
          `Cannot delete this user: they are the last active owner of the workspace ${tenantLabel} — promote another owner first`,
        );
      }
    }

    // Soft-delete the user
    await this.userRepo.softDelete(userId);

    // Remove live memberships (snapshots elsewhere stay untouched)
    await this.tenantMemberRepo.deleteByUserId(userId);

    await this.projectMemberRepo.deleteByUserId(userId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve the slug for a new tenant.
   *
   * - User-supplied slug: validated against shape/length rules, then checked
   *   for global uniqueness.
   * - Omitted slug: generated from the tenant name, then checked for global
   *   uniqueness (the create-workspace form offers a live availability check,
   *   so collisions surface as an explicit SLUG_TAKEN conflict).
   */
  private async resolveSlugForCreate(input: CreateTenant): Promise<string> {
    if (input.slug !== undefined) {
      if (!isValidTenantSlug(input.slug)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Slug must be 2-48 characters of lowercase letters, numbers, and hyphens, without leading/trailing hyphens',
        );
      }

      if (await this.tenantRepo.slugExists(input.slug)) {
        throw new ConflictError(`Slug "${input.slug}" is already taken`, 'SLUG_TAKEN');
      }

      return input.slug;
    }

    const generated = generateSlugFromName(input.name);

    // V4-6: a name that yields an empty/invalid slug is a validation failure
    // (400 VALIDATION_ERROR), not a conflict — the UI maps it to a field error.
    if (!isValidTenantSlug(generated)) {
      throw new ValidationError('Workspace name must contain letters or numbers');
    }

    if (await this.tenantRepo.slugExists(generated)) {
      throw new ConflictError(`Generated slug "${generated}" is already taken`, 'SLUG_TAKEN');
    }

    return generated;
  }

  private requireNotArchived(tenant: Tenant): void {
    if (tenant.status === TenantStatus.ARCHIVED) {
      throw new AppError(409, 'TENANT_ARCHIVED', 'Tenant is archived and cannot be modified');
    }
  }

  private async requireMembership(
    userId: string,
    tenantId: string,
    precheckedMembership?: TenantMember,
  ): Promise<TenantMember> {
    if (precheckedMembership && precheckedMembership.userId === userId && precheckedMembership.tenantId === tenantId) {
      return precheckedMembership;
    }

    const membership = await this.tenantMemberRepo.findByUserAndTenant(userId, tenantId);

    if (!membership || membership.status !== MemberStatus.ACTIVE) {
      throw new ForbiddenError('You are not a member of this tenant');
    }
    return membership;
  }
}
