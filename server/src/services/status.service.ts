import type { Status, CreateStatus, UpdateStatus } from '@task-board/shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { StatusRepository } from '../repositories/status.repository.js';
import { ensurePermission } from './rbac.service.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import type { AuditService } from './audit.service.js';

// ─── Interfaces for cross-repository dependencies ────────────────────────────

/** Minimal task repository interface needed by StatusService */
export interface StatusServiceTaskRepo {
  countByStatus(projectId: string, statusId: string): Promise<number>;
  updateManyByStatus(
    projectId: string,
    oldStatusId: string,
    newStatusId: string,
    newStatusName?: string | null,
  ): Promise<void>;
  /** Propagate a status rename to the denormalized task.statusName */
  setStatusNameForTasks(projectId: string, statusId: string, statusName: string): Promise<void>;
}

/** Minimal board repository interface needed by StatusService */
export interface StatusServiceBoardRepo {
  replaceStatusInColumns(projectId: string, oldStatusId: string, newStatusId: string): Promise<void>;
}

/** Minimal project repository interface needed by StatusService */
export interface StatusServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface StatusServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

// ─── Status Service ──────────────────────────────────────────────────────────

export class StatusService {
  constructor(
    private readonly statusRepo: StatusRepository,
    private readonly taskRepo: StatusServiceTaskRepo,
    private readonly boardRepo: StatusServiceBoardRepo,
    private readonly projectRepo: StatusServiceProjectRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: StatusServiceProjectMemberRepo,
  ) {}

  /**
   * (read path): the project must belong to the caller's
   * tenant, otherwise 404 — never 403, so a foreign project id looks exactly
   * like a nonexistent one. The caller context is REQUIRED; a missing one
   * throws instead of silently skipping the check (fail closed).
   */
  private async assertProjectScope(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId } = requireCallerContext(context);

    return assertProjectInTenant(this.projectRepo, projectId, tenantId);
  }

  /**
   * (write path): tenant scope FIRST (404 on a foreign
   * project), then `manage_statuses` (PROJECT_ADMIN only; tenant Owner/Admin
   * bypass inside the RBAC matrix) via {@link ensurePermission}. Routes with
   * `:projectId` in the path are additionally gated by requirePermission —
   * this is the defense-in-depth / id-based-route layer, and it no longer
   * fails open when the context is missing.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertManageStatuses(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — tenant scope first, then the single server-owned
    // rule that a project scheduled for deletion is read-only.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission('manage_statuses', userRole, membership?.role ?? null);

    return project;
  }

  async getStatusesByProject(projectId: string, context: CallerContext): Promise<Status[]> {
    await this.assertProjectScope(projectId, context);

    return this.statusRepo.findByProject(projectId);
  }

  /**
   * Reorder statuses in a single bulk pass (transactional alternative to
   * two sequential PATCH calls that could leave positions inconsistent).
   */
  async reorder(
    projectId: string,
    items: { id: string; position: number }[],
    context: CallerContext,
  ): Promise<Status[]> {
    await this.assertManageStatuses(projectId, context);

    const statuses = await this.statusRepo.findByProject(projectId);
    const knownIds = new Set(statuses.map((s) => s.id));

    if (!items.every((item) => knownIds.has(item.id))) {
      throw new NotFoundError('Status not found in this project');
    }

    await this.statusRepo.reorderPositions(items);

    return this.statusRepo.findByProject(projectId);
  }

  async createStatus(projectId: string, input: CreateStatus, context: CallerContext): Promise<Status> {
    const project = await this.assertManageStatuses(projectId, context);
    const normalizedName = input.name.toLowerCase().trim();
    const existing = await this.statusRepo.findByProjectAndNormalizedName(projectId, normalizedName);

    if (existing) {
      throw new ConflictError('A status with this name already exists in this project', 'DUPLICATE_STATUS');
    }

    // The pre-check above is racy; the unique `{projectId,normalizedName}`
    // index is the real guard, so a lost race is translated into the same 409.
    const status = await withConflictOnDuplicate(
      () => this.statusRepo.create(projectId, input),
      () => new ConflictError('A status with this name already exists in this project', 'DUPLICATE_STATUS'),
    );

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'STATUS',
        entityId: status.id,
        action: 'CREATED',
        actorId: context.userId,
      });
    }

    return status;
  }

  async updateStatus(statusId: string, input: UpdateStatus, context: CallerContext): Promise<Status> {
    const status = await this.statusRepo.findById(statusId);

    if (!status) {
      throw new NotFoundError('Status not found');
    }

    const project = await this.assertManageStatuses(status.projectId, context);
    const updateFields: { name?: string; normalizedName?: string; position?: number } = {};

    if (input.name !== undefined) {
      const normalizedName = input.name.toLowerCase().trim();
      const existing = await this.statusRepo.findByProjectAndNormalizedName(status.projectId, normalizedName);

      if (existing && existing.id !== statusId) {
        throw new ConflictError('A status with this name already exists in this project', 'DUPLICATE_STATUS');
      }

      updateFields.name = input.name;
      updateFields.normalizedName = normalizedName;
    }

    if (input.position !== undefined) {
      updateFields.position = input.position;
    }

    // A rename that loses the `{projectId,normalizedName}` race is the
    // same conflict the pre-check above reports — the rename must not silently
    // become a 500 (and, worse, must not half-apply: the repo update itself
    // is what the unique index rejects).
    const updated = await withConflictOnDuplicate(
      () => this.statusRepo.update(statusId, updateFields),
      () => new ConflictError('A status with this name already exists in this project', 'DUPLICATE_STATUS'),
    );

    if (!updated) {
      throw new NotFoundError('Status not found');
    }

    // Propagate a rename to the denormalized task.statusName (sort-only)
    if (input.name !== undefined && input.name !== status.name) {
      await this.taskRepo.setStatusNameForTasks(status.projectId, statusId, input.name);
    }

    // Audit side effect
    if (this.auditService) {
      const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];

      if (input.name !== undefined) changes.push({ field: 'name', oldValue: status.name, newValue: input.name });
      if (input.position !== undefined)
        changes.push({ field: 'position', oldValue: status.position, newValue: input.position });
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: updated.projectId,
        entityType: 'STATUS',
        entityId: updated.id,
        action: 'UPDATED',
        actorId: context.userId,
        changes,
      });
    }

    return updated;
  }

  async deleteStatus(statusId: string, replacementStatusId: string | undefined, context: CallerContext): Promise<void> {
    const status = await this.statusRepo.findById(statusId);

    if (!status) {
      throw new NotFoundError('Status not found');
    }

    const project = await this.assertManageStatuses(status.projectId, context);
    // Check if any tasks use this status
    const tasksWithStatus = await this.taskRepo.countByStatus(status.projectId, statusId);

    if (tasksWithStatus > 0) {
      if (!replacementStatusId) {
        throw new ConflictError(
          'Status is in use by tasks. Provide a replacementStatusId to reassign tasks before deletion.',
          'STATUS_IN_USE',
        );
      }

      const replacement = await this.statusRepo.findById(replacementStatusId);

      if (!replacement || replacement.projectId !== status.projectId) {
        throw new NotFoundError('Replacement status not found in this project');
      }

      // Update all tasks using this status (carries the replacement's name — TOP-2)
      await this.taskRepo.updateManyByStatus(status.projectId, statusId, replacementStatusId, replacement.name);
    }

    // Replace status in board columns
    if (replacementStatusId) {
      await this.boardRepo.replaceStatusInColumns(status.projectId, statusId, replacementStatusId);
    }

    // Audit side effect (before delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: status.projectId,
        entityType: 'STATUS',
        entityId: statusId,
        action: 'DELETED',
        actorId: context.userId,
      });
    }

    await this.statusRepo.delete(statusId);
  }
}
