import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection } from 'mongodb';
import { ProjectRole, ProjectStatus, ArchiveReason, MemberStatus, DELETION_GRACE_PERIOD_MS } from '@task-board/shared';
import type { Project, ProjectMember, CreateProject, UpdateProject } from '@task-board/shared';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { TransactionsUnsupportedError, withTransaction } from '../db/mongo.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { ProjectMemberRepository } from '../repositories/project-member.repository.js';
import type { AuditService } from './audit.service.js';
import { rbacService, type PermissionAction } from './rbac.service.js';
import { assertProjectInTenant, requireCallerContext, type CallerContext } from './tenant-assert.js';
import { assertProjectAcceptsWrites } from './project-write-guard.js';

// ─── Constants ───────────────────────────────────────────────────────────────

// `name` is the human-readable display name shown in boards/tables;
// `key` is the stable seed identifier used for board-column wiring and
// defaultStatusId (keys/positions/normalizedNames are unchanged).
const SEED_STATUSES = [
  { key: 'TODO', name: 'To Do', normalizedName: 'todo', position: 0 },
  { key: 'IN_PROGRESS', name: 'In Progress', normalizedName: 'in_progress', position: 1 },
  { key: 'IN_REVIEW', name: 'In Review', normalizedName: 'in_review', position: 2 },
  { key: 'REOPENED', name: 'Reopened', normalizedName: 'reopened', position: 3 },
  { key: 'DONE', name: 'Done', normalizedName: 'done', position: 4 },
];
const SEED_TASK_TYPES = [
  { key: 'TASK', name: 'Task', icon: '📋', position: 0 },
  { key: 'BUG', name: 'Bug', icon: '🐛', position: 1 },
  { key: 'STORY', name: 'Story', icon: '📖', position: 2 },
];
// Board columns: TODO+REOPENED, IN_PROGRESS, IN_REVIEW, DONE
const SEED_BOARD_COLUMNS = [
  { name: 'To Do', statusRefs: ['TODO', 'REOPENED'], position: 0 },
  { name: 'In Progress', statusRefs: ['IN_PROGRESS'], position: 1 },
  { name: 'In Review', statusRefs: ['IN_REVIEW'], position: 2 },
  { name: 'Done', statusRefs: ['DONE'], position: 3 },
];

// ─── Interfaces for cascade delete ───────────────────────────────────────────

export interface ProjectCascadeTaskRepo {
  findIdsByProject(projectId: string): Promise<string[]>;
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeSprintRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeBoardRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeLabelRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeStatusRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeTaskTypeRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeRelationshipRepo {
  deleteByProject(projectId: string): Promise<void>;
}

export interface ProjectCascadeCommentRepo {
  deleteByTaskIds(taskIds: string[]): Promise<void>;
}

export interface ProjectCascadeFilterRepo {
  deleteByProject(projectId: string): Promise<void>;
}

/**
 * The cascade has NO audit repository, and that is the fix.
 *
 * The old cascade called `auditRepo.deleteByProject`, which removed every audit
 * row for the project — INCLUDING the `PROJECT/DELETED` event recording who
 * purged it, so a permanent delete destroyed the record of the deletion. The
 * decision is a retention window enforced by a time-to-live index
 * (`db/migrations.ts`), so audit rows leave on a CLOCK and never at a purge's
 * discretion.
 *
 * The dependency is REMOVED rather than kept-and-unused, because
 * `container.test.ts` asserts that every repository the cascade bundle carries is
 * one the cascade actually calls — a wiring that exists only to be unused is
 * exactly the shape that lets the next person wire it up. The purge appends its
 * record through `AuditService.logSystem` instead, and
 * `purge-cascade.guardrail.test.ts` scans every service, route and repository for
 * a call to the audit delete, which is the guardrail that actually holds.
 */

export interface ProjectCascadeCounterRepo {
  deleteByProject(projectId: string): Promise<void>;
}

/**
 * Narrow view of the tenant-membership repository needed by
 * {@link ProjectService.addMember}.
 *
 * Deliberately structural: the service depends on the ONE method it needs, so
 * the check cannot be silently disabled by passing a repository that lacks it,
 * and the unit specs can hand in a two-method fake instead of a whole repository.
 */
export interface ProjectServiceTenantMemberRepo {
  /** DEC-055 `expiresAt` is part of the domain object — a lapsed membership is not ACTIVE. */
  findByUserAndTenant(userId: string, tenantId: string): Promise<{ status: string; expiresAt?: string | null } | null>;
}

// ─── Project Service ─────────────────────────────────────────────────────────

export class ProjectService {
  /**
   * Every parameter is REQUIRED.
   *
   * `cascadeRepos` and `auditService` used to be optional, so `container.ts`
   * could pass 3 of 5 arguments and still typecheck — and because every use was
   * guarded by `if (this.x)`, the omissions were silent: `permanentDelete`
   * removed only the project document and no project-level audit event was ever
   * written. Making them required turns the next omission into a compile error.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    /** Direct collections for seed data (task_types, statuses, boards) */
    private readonly collections: {
      taskTypes: Collection;
      statuses: Collection;
      boards: Collection;
    },
    private readonly cascadeRepos: {
      taskRepo: ProjectCascadeTaskRepo;
      sprintRepo: ProjectCascadeSprintRepo;
      boardRepo: ProjectCascadeBoardRepo;
      labelRepo: ProjectCascadeLabelRepo;
      statusRepo: ProjectCascadeStatusRepo;
      taskTypeRepo: ProjectCascadeTaskTypeRepo;
      relationshipRepo: ProjectCascadeRelationshipRepo;
      commentRepo: ProjectCascadeCommentRepo;
      filterRepo: ProjectCascadeFilterRepo;
      counterRepo: ProjectCascadeCounterRepo;
    },
    private readonly auditService: AuditService,
    /**
     * REQUIRED. `addMember` used to be guarded only in
     * `routes/projects.ts`, so a direct call to the service (new code, a
     * background job, a future route that forgets the helper) could grant a
     * `PROJECT_ADMIN` seat to an arbitrary user id — the exact production
     * exploit. Authorization now lives in the service layer; omitting
     * this argument is a compile error and `container.test.ts` asserts the real
     * `TenantMemberRepository` is wired.
     */
    private readonly tenantMemberRepo: ProjectServiceTenantMemberRepo,
  ) {}

  // ─── Project CRUD ──────────────────────────────────────────────────────────

  async listProjects(tenantId: string): Promise<Project[]> {
    return this.projectRepo.findByTenant(tenantId);
  }

  /**
   * Create a new project with atomic seed data.
   * Validates key format and uniqueness within tenant.
   * Seeds TaskTypes, Statuses, default Board, and creates creator membership.
   *
   * The whole seed runs inside a MongoDB transaction: an abort leaves no
   * partially initialized project visible. On deployments without transaction
   * support (standalone `mongod`), falls back to ordered inserts with a
   * compensating delete — see {@link createProjectWithCompensatingCleanup}.
   */
  async createProject(tenantId: string, userId: string, userRole: string, input: CreateProject): Promise<Project> {
    this.requireTenantPermission('create_project', userRole);

    // Validate key format
    this.validateKey(input.key);

    // Check key uniqueness within tenant
    const existing = await this.projectRepo.findByTenantAndKey(tenantId, input.key);

    if (existing) {
      throw new ConflictError('A project with this key already exists in this tenant', 'DUPLICATE_PROJECT_KEY');
    }

    let project: Project;

    try {
      // Insert project + statuses + task types + default board +
      // creator membership atomically; commit ⇒ all visible, abort ⇒ nothing.
      // A lost `{tenantId,key}` race inside the transaction is the same
      // conflict the pre-check above reports, so it is translated instead of
      // surfacing as a 500 from the raw driver error.
      project = await withConflictOnDuplicate(
        () =>
          withTransaction(async (session) => {
            const created = await this.projectRepo.create(tenantId, input, { session });
            const statusMap = await this.seedStatuses(created.id, session);

            await this.seedBoard(created.id, statusMap, session);

            await this.seedTaskTypes(created.id, session);

            // Link the default status on the project (still inside the transaction)
            await this.projectRepo.update(created.id, { defaultStatusId: statusMap.get('TODO') ?? '' }, { session });

            // Add creator as PROJECT_ADMIN
            await this.projectMemberRepo.create(
              { userId, projectId: created.id, role: ProjectRole.PROJECT_ADMIN },
              { session },
            );

            return created;
          }),
        () => new ConflictError('A project with this key already exists in this tenant', 'DUPLICATE_PROJECT_KEY'),
      );
    } catch (err) {
      if (err instanceof TransactionsUnsupportedError) {
        // Fallback policy: standalone MongoDB (no replica set) cannot
        // run transactions. Log clearly and use the legacy compensating-cleanup
        // path so local dev does not hard-fail. Production (Atlas Free replica
        // set) and docker-compose dev both run a replica set and never hit this.
        console.warn(
          '[projects] MongoDB topology does not support transactions — falling back to compensating-cleanup seed. ' +
            'Run local MongoDB as a single-node replica set (see docker-compose.yml) for atomic seeding.',
        );
        project = await this.createProjectWithCompensatingCleanup(tenantId, userId, input);
      } else {
        throw err;
      }
    }

    // Return the updated project
    const updated = await this.projectRepo.findById(project.id);

    // Audit side effect
    await this.auditService.log({
      tenantId,
      projectId: project.id,
      entityType: 'PROJECT',
      entityId: project.id,
      action: 'CREATED',
      actorId: userId,
    });

    return updated ?? project;
  }

  /**
   * The tenant seam for every project-scoped method.
   *
   * Resolves the project and proves it belongs to the CALLER's tenant; a foreign
   * (or nonexistent) project yields 404, never 403, so a cross-tenant id is
   * indistinguishable from an unknown one. The caller context is REQUIRED:
   * `requireCallerContext` throws 401 when it is missing, so a call chain that
   * forgets to forward the context fails closed instead of skipping the check.
   *
   * The tenant assertion is deliberately the first thing that happens — before
   * any role check — so a foreign project never leaks its existence through a
   * 403 either.
   */
  async getProject(id: string, context: CallerContext): Promise<Project> {
    const { tenantId } = requireCallerContext(context);

    await assertProjectInTenant(this.projectRepo, id, tenantId);

    return this.requireProject(id);
  }

  async getProjectByKey(tenantId: string, key: string): Promise<Project> {
    const project = await this.projectRepo.findByTenantAndKey(tenantId, key);

    if (!project) {
      throw new NotFoundError('Project not found');
    }
    return project;
  }

  /**
   * The public project-scoped WRITE seam — tenant scope (404 on a foreign
   * project) then the single server-owned write rule.
   *
   * Exposed because a write is not always a `ProjectService` method: the
   * project-scoped preferences PATCH resolves the project here and then writes
   * through `UserPreferencesService`. Routing it through this method is what
   * keeps that route inside the same rule instead of a second, private copy.
   *
   * @returns the resolved project so a caller can audit-log without a re-read.
   */
  async assertProjectWritable(id: string, context: CallerContext): Promise<Project> {
    const project = await this.getProject(id, context);

    this.requireProjectWritable(project);

    return project;
  }

  async updateProject(id: string, input: UpdateProject, context: CallerContext): Promise<Project> {
    // Tenant scope first (404 on a foreign project), then the role gate.
    const project = await this.getProject(id, context);

    this.requireTenantPermission('manage_project', context.userRole);

    this.requireProjectWritable(project);

    // Key immutability check — reject if key is being changed and tasks exist
    // Note: UpdateProject doesn't include key, but we guard against future changes
    // The key field is not in the update schema, so this is a safety net

    // F22 (latent bug the flag exposed): `input` is a `PATCH` body, so omitted
    // fields arrive as `undefined`. Forwarding it verbatim put EVERY key of the
    // patch into `$set`, and BSON serialises `undefined` as `null` — so
    // `PATCH /projects/:id {"name":"X"}` nulled `description`. The patch is now
    // assembled from defined keys only, which is what `ProjectRepository.update`
    // requires under `exactOptionalPropertyTypes`.
    const patch: { name?: string; description?: string } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;

    const updated = await this.projectRepo.update(id, patch);

    if (!updated) {
      throw new NotFoundError('Project not found');
    }

    // Audit side effect. The actor is no longer an OPTIONAL argument —
    // it comes from the REQUIRED caller context, so a PROJECT UPDATED event is
    // always written and can no longer be skipped by forgetting to forward a
    // userId (the audit SERVICE itself was already a required dependency).
    const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];

    if (input.name !== undefined) changes.push({ field: 'name', oldValue: project.name, newValue: input.name });
    if (input.description !== undefined)
      changes.push({ field: 'description', oldValue: project.description, newValue: input.description });

    await this.auditService.log({
      tenantId: project.tenantId,
      projectId: id,
      entityType: 'PROJECT',
      entityId: id,
      action: 'UPDATED',
      actorId: context.userId,
      changes,
    });

    return updated;
  }

  // ─── Project Lifecycle ─────────────────────────────────────────────────────

  async deleteProject(id: string, context: CallerContext): Promise<void> {
    // Tenant scope first (404 on a foreign project), then the role gate.
    const project = await this.getProject(id, context);

    this.requireTenantPermission('manage_project', context.userRole);

    this.requireNotArchived(project);

    const deletionScheduledAt = new Date(Date.now() + DELETION_GRACE_PERIOD_MS);

    await this.projectRepo.update(id, {
      status: ProjectStatus.DELETION_PENDING,
      deletionScheduledAt,
    });

    // Audit side effect — The actor comes from the REQUIRED caller
    // context, so a PROJECT DELETED event is always written.
    await this.auditService.log({
      tenantId: project.tenantId,
      projectId: id,
      entityType: 'PROJECT',
      entityId: id,
      action: 'DELETED',
      actorId: context.userId,
    });
  }

  async archiveProject(id: string, context: CallerContext): Promise<void> {
    const project = await this.getProject(id, context);

    this.requireTenantPermission('manage_project', context.userRole);

    this.requireNotArchived(project);

    await this.projectRepo.update(id, {
      status: ProjectStatus.ARCHIVED,
      archiveReason: ArchiveReason.PROJECT_ARCHIVE,
    });
  }

  async restoreProject(id: string, context: CallerContext): Promise<void> {
    // Restore used to write straight through `projectRepo.update` — the
    // only lifecycle action that never resolved the project, so it addressed
    // ANY project id. It now goes through the same tenant seam.
    await this.getProject(id, context);

    this.requireTenantPermission('manage_project', context.userRole);

    await this.projectRepo.update(id, {
      status: ProjectStatus.ACTIVE,
      archiveReason: null,
      deletionScheduledAt: null,
    });
  }

  async cancelDeletion(id: string, context: CallerContext): Promise<void> {
    await this.getProject(id, context);

    this.requireTenantPermission('manage_project', context.userRole);

    await this.projectRepo.update(id, {
      status: ProjectStatus.ACTIVE,
      deletionScheduledAt: null,
    });
  }

  async permanentDelete(id: string): Promise<void> {
    // System-level reaper entry point — it is not reachable from a route
    // and therefore has no caller context; it keeps the existence-only lookup.
    const project = await this.requireProject(id);

    if (project.status !== ProjectStatus.DELETION_PENDING) {
      throw new AppError(400, 'CONFLICT', 'Project must be in DELETION_PENDING status');
    }

    await this.purgeProjectData(id);
  }

  /**
   * The unconditional, ordered project cascade.
   *
   * **Children first, root document LAST.** The root is the reaper's only index
   * into this work — `PurgeService.findDue` selects entities that are still in
   * `DELETION_PENDING` — so as long as it survives, the next scheduled run finds
   * this project again and repeats the whole cascade over whatever is left. Every
   * step below is a `deleteMany`-shaped operation, so re-running one is a no-op on
   * what it already removed. A failure therefore CANNOT orphan data: the only
   * document that could point at orphaned data is the one the cascade has not
   * reached yet. See `purge.service.ts` for what this does and does not guarantee.
   *
   * **No status check and no caller context**, deliberately. This is the method
   * the WORKSPACE purge calls for projects that are still `ACTIVE`: a project
   * being destroyed with its workspace does not need its own grace period, and
   * requiring `DELETION_PENDING` would make a workspace purge silently skip
   * exactly the projects that are still in use. `permanentDelete` is the checked
   * entry point for the standalone case and delegates here.
   *
   * **Audit rows are NOT deleted**: the retention window is a time-to-live
   * index, so the log leaves on a clock. What the purge does instead is APPEND
   * the record of what it destroyed — written after the children (so it is not
   * written for a purge that failed halfway) and before the root document (so a
   * failure after it still leaves the entity scheduled, and a retry re-records
   * rather than losing the record).
   */
  async purgeProjectData(id: string): Promise<void> {
    const project = await this.projectRepo.findById(id);
    // Comments are keyed by `taskId` (no `projectId` field) — collect the
    // project's task ids and delete their comments BEFORE removing the tasks.
    const taskIds = await this.cascadeRepos.taskRepo.findIdsByProject(id);

    await this.cascadeRepos.commentRepo.deleteByTaskIds(taskIds);
    await this.cascadeRepos.relationshipRepo.deleteByProject(id);
    await this.cascadeRepos.taskRepo.deleteByProject(id);
    await this.cascadeRepos.sprintRepo.deleteByProject(id);
    await this.cascadeRepos.boardRepo.deleteByProject(id);
    await this.cascadeRepos.labelRepo.deleteByProject(id);
    await this.cascadeRepos.statusRepo.deleteByProject(id);
    await this.cascadeRepos.taskTypeRepo.deleteByProject(id);
    await this.cascadeRepos.filterRepo.deleteByProject(id);
    await this.cascadeRepos.counterRepo.deleteByProject(id);

    // Remove all memberships
    const members = await this.projectMemberRepo.findByProject(id);

    for (const member of members) {
      await this.projectMemberRepo.delete(id, member.userId);
    }

    // The record of the purge. Written with a SYSTEM actor: no user
    // performed it, and a fabricated user id would eventually collide with a real
    // account. `tenantId` comes from the project document, which still exists —
    // this is why the record is written before the root delete below.
    if (project) {
      await this.auditService.logSystem({
        tenantId: project.tenantId,
        projectId: id,
        entityType: 'PROJECT',
        entityId: id,
        action: 'DELETED',
        changes: [
          {
            field: 'purged',
            oldValue: ProjectStatus.DELETION_PENDING,
            newValue: 'purged — all project data permanently removed',
          },
        ],
      });
    }

    // ROOT LAST. Nothing above this line can be re-found once it is gone.
    await this.projectRepo.delete(id);
  }

  // ─── Project Member Management ─────────────────────────────────────────────
  //
  // Every sub-route resolves the project through the tenant seam
  // FIRST (404 for a foreign project), then applies the tenant-admin role gate
  // (403). The role check alone was never a tenant check — a tenant-B OWNER
  // satisfied it while addressing a tenant-A project.

  /**
   * Add a member to a project.
   *
   * The caller context supplies the tenant (never a path/body value) and the
   * actor. The target user MUST already hold an ACTIVE membership in the
   * caller's tenant, otherwise 404 — deliberately not 403, so the endpoint does
   * not become a cross-tenant user-directory oracle (404 and 403 must not be
   * distinguishable for "member of the tenant" vs "not a member").
   *
   * This check USED TO live in `routes/projects.ts` (through the
   * `TenantMemberService.getTenantMembers` `$lookup` aggregate) and was therefore
   * bypassable by any direct call to the service. It now lives HERE, next to the
   * project tenant-assert and the role gate, so no call site can skip it.
   *
   * Check order (deliberate):
   *   1. project tenant  → 404 (a foreign project is indistinguishable from a
   *      nonexistent one, and a foreign project must never be observable even
   *      when the target user is not a member of the caller's tenant),
   *   2. target ACTIVE tenant membership → 404,
   *   3. tenant-admin role → 403,
   *   4. duplicate membership → 409.
   *
   * DEC-055 lazy expiry is reproduced here: an `ACTIVE` membership whose
   * `expiresAt` has passed counts as not ACTIVE (the same answer the aggregate
   * gave, because `getTenantMembers` flips it to ACCESS_REVOKED on read).
   */
  async addMember(
    projectId: string,
    input: { userId: string; role: string },
    context: CallerContext,
  ): Promise<ProjectMember> {
    // Membership is a write to the project, so the shared write rule applies
    // (a project scheduled for deletion accepts no new seats).
    this.requireProjectWritable(await this.getProject(projectId, context));

    const membership = await this.tenantMemberRepo.findByUserAndTenant(input.userId, context.tenantId);

    if (!membership || !this.isActiveMembership(membership)) {
      throw new NotFoundError('User is not a member of this tenant');
    }

    this.requireTenantPermission('manage_project_members', context.userRole);

    const existing = await this.projectMemberRepo.findByUserAndProject(input.userId, projectId);

    if (existing) {
      throw new ConflictError('User is already a member of this project');
    }

    // Two concurrent "add member" calls can both pass the check above; the
    // unique `{projectId,userId}` index then rejects the loser, which is the
    // very same "already a member" conflict — not a 500.
    return withConflictOnDuplicate(
      () =>
        this.projectMemberRepo.create({
          userId: input.userId,
          projectId,
          role: input.role,
        }),
      () => new ConflictError('User is already a member of this project'),
    );
  }

  /** An ACTIVE membership past `expiresAt` is treated as not ACTIVE. */
  private isActiveMembership(membership: { status: string; expiresAt?: string | null }): boolean {
    if (membership.status !== MemberStatus.ACTIVE) {
      return false;
    }

    if (!membership.expiresAt) {
      return true;
    }

    return new Date(membership.expiresAt).getTime() > Date.now();
  }

  /**
   * Change a project member's role.
   *
   * Escalation analysis (F24 re-verified against the F20–F23 state): the gate is
   * `manage_project_members` evaluated with NO project role, so the only callers
   * that reach this line are tenant OWNER/ADMIN — the same set the pre-F24
   * `requireTenantAdmin` accepted — and the RBAC matrix lets a tenant
   * OWNER/ADMIN bypass EVERY project-level check. A role change therefore cannot
   * grant its caller more than they already hold, and it is not self-escalation:
   * a project member who is only `PROJECT_ADMIN` is refused with 403 BEFORE this
   * point (pinned by a regression test in `project.service.test.ts`). The
   * cross-tenant vector (foreign project → 404) and an unknown target (→ 404)
   * stay blocked by the seam above.
   *
   * Demoting the LAST active `PROJECT_ADMIN` is now refused with 409 — the
   * project-level counterpart of the tenant last-OWNER invariant. See
   * {@link assertNotLastProjectAdmin} for why the strict reading cannot lock
   * anyone out. The previous behaviour ("a product decision, not invented") is
   * the ONE behaviour this task deliberately changes; nothing else moved.
   */
  async updateMemberRole(
    projectId: string,
    memberUserId: string,
    role: string,
    context: CallerContext,
  ): Promise<ProjectMember> {
    this.requireProjectWritable(await this.getProject(projectId, context));

    this.requireTenantPermission('manage_project_members', context.userRole);

    // A target whose CURRENT seat cannot be resolved is left entirely to
    // `updateRole`, which is the authority on existence and still answers 404 —
    // the invariant never invents a refusal for a member it could not see.
    const current = await this.projectMemberRepo.findByUserAndProject(memberUserId, projectId);

    if (current?.role === ProjectRole.PROJECT_ADMIN && role !== ProjectRole.PROJECT_ADMIN) {
      await this.assertNotLastProjectAdmin(
        projectId,
        memberUserId,
        'This member is the last active admin of this project — promote another admin before changing this role',
      );
    }

    const updated = await this.projectMemberRepo.updateRole(projectId, memberUserId, role);

    if (!updated) {
      throw new NotFoundError('Project member not found');
    }

    return updated;
  }

  async removeMember(projectId: string, memberUserId: string, context: CallerContext): Promise<void> {
    this.requireProjectWritable(await this.getProject(projectId, context));

    this.requireTenantPermission('manage_project_members', context.userRole);

    // Same last-admin invariant as updateMemberRole. Checked before the
    // delete so the 409 names the real problem; an unresolvable target still
    // reaches the delete, which answers 404.
    const current = await this.projectMemberRepo.findByUserAndProject(memberUserId, projectId);

    if (current?.role === ProjectRole.PROJECT_ADMIN) {
      await this.assertNotLastProjectAdmin(
        projectId,
        memberUserId,
        'Cannot remove this member: they are the last active admin of this project — promote another admin first',
      );
    }

    const deleted = await this.projectMemberRepo.delete(projectId, memberUserId);

    if (!deleted) {
      throw new NotFoundError('Project member not found');
    }
  }

  async getProjectMembers(projectId: string, context: CallerContext): Promise<ProjectMember[]> {
    await this.getProject(projectId, context);

    return this.projectMemberRepo.findByProjectWithUsers(projectId);
  }

  // ─── Seed Helpers ──────────────────────────────────────────────────────────

  private validateKey(key: string): void {
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Key must start with a letter and contain only uppercase letters and digits (2-10 chars)',
      );
    }
  }

  private async seedStatuses(projectId: string, session?: ClientSession): Promise<Map<string, string>> {
    const statusMap = new Map<string, string>();

    for (const status of SEED_STATUSES) {
      const id = randomUUID();

      await this.collections.statuses.insertOne(
        {
          id,
          projectId,
          name: status.name,
          normalizedName: status.normalizedName,
          position: status.position,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        // The driver option is `session?: ClientSession`, so an absent
        // session must be an absent KEY, not `session: undefined` — omit the
        // whole options object on the non-transactional seed path.
        session ? { session } : undefined,
      );
      statusMap.set(status.key, id);
    }

    return statusMap;
  }

  private async seedTaskTypes(projectId: string, session?: ClientSession): Promise<void> {
    for (const taskType of SEED_TASK_TYPES) {
      await this.collections.taskTypes.insertOne(
        {
          id: randomUUID(),
          projectId,
          key: taskType.key,
          name: taskType.name,
          icon: taskType.icon,
          position: taskType.position,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        session ? { session } : undefined,
      );
    }
  }

  /**
   * Seed the project's single board (single-board model, doc 102): identified
   * by projectId, no name/type, created atomically with the project.
   */
  private async seedBoard(projectId: string, statusMap: Map<string, string>, session?: ClientSession): Promise<void> {
    const columns = SEED_BOARD_COLUMNS.map((col) => ({
      id: randomUUID(),
      statusIds: col.statusRefs.map((ref) => statusMap.get(ref) ?? ''),
      position: col.position,
    }));

    await this.collections.boards.insertOne(
      {
        projectId,
        columns,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session ? { session } : undefined,
    );
  }

  /**
   * Legacy non-transactional seed path (DEC-025 fallback): ordered inserts
   * followed by a compensating delete of the project if any step fails.
   * Only used when the deployment's MongoDB cannot run transactions — there
   * is a small window where a partially seeded project is visible before the
   * cleanup completes.
   */
  private async createProjectWithCompensatingCleanup(
    tenantId: string,
    userId: string,
    input: CreateProject,
  ): Promise<Project> {
    const project = await this.projectRepo.create(tenantId, input);

    try {
      const statusMap = await this.seedStatuses(project.id);
      const todoStatusId = statusMap.get('TODO') ?? '';

      await this.seedBoard(project.id, statusMap);

      await this.seedTaskTypes(project.id);

      await this.projectRepo.update(project.id, { defaultStatusId: todoStatusId });

      await this.projectMemberRepo.create({
        userId,
        projectId: project.id,
        role: ProjectRole.PROJECT_ADMIN,
      });
    } catch (err) {
      // If seeding fails, clean up the project
      await this.projectRepo.delete(project.id);
      throw err;
    }

    return project;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Existence-only project lookup (no tenant scope).
   *
   * Used after {@link getProject} has already proven ownership, and by the
   * system-level `permanentDelete` reaper, which runs outside any request
   * context. It is deliberately NOT exposed as a public accessor — a route can
   * only reach a project through `getProject(id, context)`.
   */
  private async requireProject(id: string): Promise<Project> {
    const project = await this.projectRepo.findById(id);

    if (!project) {
      throw new NotFoundError('Project not found');
    }

    return project;
  }

  /**
   * The tenant-admin gate, now ANSWERED BY THE RBAC MATRIX.
   *
   * This used to be the last hand-rolled role comparison in the request path:
   * `if (role !== TenantRole.OWNER && role !== TenantRole.ADMIN)`. The allow-list
   * was a second, hand-maintained copy of a rule that already lives in
   * `rbac.service.ts`, so a change to the matrix would have silently left this
   * guard behind. The matrix is now consulted, and the guard states WHICH
   * permission it is enforcing so the 403 names a real action.
   *
   * ## Why `projectRole: null` and why the message is unchanged
   *
   * `null` is explicit, not a stub: the historical gate is a TENANT-ADMIN gate,
   * and `RbacService.can` with a project action and no project role answers
   * "tenant Owner/Admin bypass" — exactly the pre-existing allow-list, no wider.
   * The matrix DOES also grant `manage_project` / `manage_project_members` to a
   * project-level `PROJECT_ADMIN` (spec §2.4), so switching the guard to
   * `ensurePermission(action, role, <the caller's real project role>)` would let a
   * plain project admin archive or unseat members. That widening is a product
   * decision and is deliberately NOT taken here (F24 report).
   *
   * `ensurePermission` is not used for the same reason its message is not used:
   * it throws one generic "Insufficient permissions. Requires '<action>'." string,
   * and eleven project routes plus existing client-facing tests assert these
   * exact domain messages. The MATRIX decides; the domain keeps its own wording.
   */
  private requireTenantPermission(action: PermissionAction, role: string): void {
    if (!rbacService.can(role, null, action)) {
      throw new ForbiddenError('Only owner or admin can perform this action');
    }
  }

  /**
   * A project must always keep at least one active `PROJECT_ADMIN`.
   *
   * The project-level counterpart of `assertNotLastOwner` (the tenant-level rule). The
   * same reasoning applies: a project with no project admin cannot be repaired
   * through the project-scoped surface at all, and unlike a tenant it has no
   * separate "restore owner" entry point.
   *
   * The strict reading cannot lock anyone out, which is why it is implemented
   * rather than escalated as a question: demoting or removing the last project
   * admin requires the caller to be a tenant OWNER/ADMIN, and that same caller
   * can immediately re-add the seat through `addMember` (also tenant-gated).
   * So the 409 asks for a promotion that the caller is already able to perform —
   * it defuses a mistake, it does not create one.
   *
   * Only a `PROJECT_ADMIN` that is LOSING the role can trip this, and only when
   * no other `PROJECT_ADMIN` remains. Project memberships carry no
   * `status`/`expiresAt`, so "active" is simply "the row exists".
   */
  private async assertNotLastProjectAdmin(projectId: string, memberUserId: string, message: string): Promise<void> {
    const members = await this.projectMemberRepo.findByProject(projectId);
    const anotherAdmin = members.some((m) => m.userId !== memberUserId && m.role === ProjectRole.PROJECT_ADMIN);

    if (!anotherAdmin) {
      throw new ConflictError(message);
    }
  }

  /**
   * The delete/archive state machine's OWN precondition: an already-`ARCHIVED`
   * project cannot be archived or deleted again.
   *
   * Deliberately NOT the project-scoped write rule. Those transitions are what
   * move a project INTO and OUT OF a frozen status, so gating them by "is this
   * project frozen" would make a `DELETION_PENDING` project impossible to
   * re-arm or to purge. The machine is owned by a later package; this guard
   * keeps exactly the behaviour it has today.
   */
  private requireNotArchived(project: Project): void {
    if (project.status === ProjectStatus.ARCHIVED) {
      throw new AppError(409, 'PROJECT_ARCHIVED', 'Project is archived and cannot be modified');
    }
  }

  /**
   * The project-scoped write rule, delegated to the ONE server-owned
   * predicate (`project-write-guard.ts`) that every other project-scoped write
   * service also uses. It replaces the private `requireNotArchived` this class
   * carried, which tested only `ARCHIVED` and therefore let a `DELETION_PENDING`
   * project — the status the UI calls read-only — keep accepting writes.
   *
   * `ARCHIVED` still produces the identical `PROJECT_ARCHIVED` 409, so no client
   * contract and no existing assertion moves; `DELETION_PENDING` now produces a
   * 409 `CONFLICT` naming the deletion.
   *
   * NOT applied to the delete/archive/restore/cancel-deletion transitions: those
   * are the state machine that moves a project IN and OUT of a frozen status, and
   * it is owned by a later package.
   */
  private requireProjectWritable(project: Project): void {
    assertProjectAcceptsWrites(project);
  }
}
