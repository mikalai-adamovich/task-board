import type { TaskType, CreateTaskType, UpdateTaskType } from '@task-board/shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { TaskTypeRepository } from '../repositories/task-type.repository.js';
import { ensurePermission } from './rbac.service.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import type { AuditService } from './audit.service.js';

// ─── Interfaces for cross-repository dependencies ────────────────────────────

/** Minimal task repository interface needed by TaskTypeService */
export interface TaskTypeServiceTaskRepo {
  countByType(projectId: string, typeId: string): Promise<number>;
  updateManyByType(projectId: string, oldTypeId: string, newTypeId: string): Promise<void>;
}

/** Minimal project repository interface needed by TaskTypeService */
export interface TaskTypeServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface TaskTypeServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

// ─── TaskType Service ────────────────────────────────────────────────────────

export class TaskTypeService {
  constructor(
    private readonly taskTypeRepo: TaskTypeRepository,
    private readonly taskRepo: TaskTypeServiceTaskRepo,
    private readonly projectRepo: TaskTypeServiceProjectRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: TaskTypeServiceProjectMemberRepo,
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
   * project), then `edit_project_config` (PROJECT_ADMIN only; tenant
   * Owner/Admin bypass inside the RBAC matrix) via {@link ensurePermission}.
   * Routes with `:projectId` in the path are additionally gated by
   * requirePermission — this is the defense-in-depth / id-based-route layer,
   * and it no longer fails open when the context is missing.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertEditProjectConfig(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — tenant scope first, then the single server-owned
    // rule that a project scheduled for deletion is read-only.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission('edit_project_config', userRole, membership?.role ?? null);

    return project;
  }

  async getTaskTypesByProject(projectId: string, context: CallerContext): Promise<TaskType[]> {
    await this.assertProjectScope(projectId, context);

    return this.taskTypeRepo.findByProject(projectId);
  }

  /**
   * Reorder task types in a single bulk pass (transactional alternative to
   * two sequential PATCH calls that could leave positions inconsistent).
   */
  async reorder(
    projectId: string,
    items: { id: string; position: number }[],
    context: CallerContext,
  ): Promise<TaskType[]> {
    await this.assertEditProjectConfig(projectId, context);

    const taskTypes = await this.taskTypeRepo.findByProject(projectId);
    const knownIds = new Set(taskTypes.map((t) => t.id));

    if (!items.every((item) => knownIds.has(item.id))) {
      throw new NotFoundError('Task type not found in this project');
    }

    await this.taskTypeRepo.reorderPositions(items);

    return this.taskTypeRepo.findByProject(projectId);
  }

  async createTaskType(projectId: string, input: CreateTaskType, context: CallerContext): Promise<TaskType> {
    const project = await this.assertEditProjectConfig(projectId, context);
    const existing = await this.taskTypeRepo.findByProjectAndKey(projectId, input.key);

    if (existing) {
      throw new ConflictError('A task type with this key already exists in this project', 'CONFLICT');
    }

    // The pre-check is racy; the unique `{projectId,key}` index is the real
    // guard, so a lost race is translated into the same 409.
    const taskType = await withConflictOnDuplicate(
      () => this.taskTypeRepo.create(projectId, input),
      () => new ConflictError('A task type with this key already exists in this project', 'CONFLICT'),
    );

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'TASK_TYPE',
        entityId: taskType.id,
        action: 'CREATED',
        actorId: context.userId,
      });
    }

    return taskType;
  }

  async updateTaskType(taskTypeId: string, input: UpdateTaskType, context: CallerContext): Promise<TaskType> {
    const taskType = await this.taskTypeRepo.findById(taskTypeId);

    if (!taskType) {
      throw new NotFoundError('Task type not found');
    }

    const project = await this.assertEditProjectConfig(taskType.projectId, context);
    // Key is immutable — ignore any key in input
    //
    // F22 (latent bug the flag exposed): the patch used to be built as
    // `{ name: input.name, icon: input.icon, position: input.position }`. Every
    // key was therefore present on EVERY call, and for a PATCH that omits a field
    // the value is `undefined` — which the BSON serialiser writes as `null`.
    // `PATCH /task-types/:id {"name":"X"}` therefore nulled `icon` and
    // `position` in MongoDB. The patch is now assembled from defined keys only,
    // which is also what `TaskTypeRepository.update`'s parameter type demands
    // under `exactOptionalPropertyTypes`.
    const patch: { name?: string; icon?: string; position?: number } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.position !== undefined) patch.position = input.position;

    const updated = await this.taskTypeRepo.update(taskTypeId, patch);

    if (!updated) {
      throw new NotFoundError('Task type not found');
    }

    // Audit side effect
    if (this.auditService) {
      const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];

      if (input.name !== undefined) changes.push({ field: 'name', oldValue: taskType.name, newValue: input.name });
      if (input.icon !== undefined) changes.push({ field: 'icon', oldValue: taskType.icon, newValue: input.icon });
      if (input.position !== undefined)
        changes.push({ field: 'position', oldValue: taskType.position, newValue: input.position });
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: updated.projectId,
        entityType: 'TASK_TYPE',
        entityId: updated.id,
        action: 'UPDATED',
        actorId: context.userId,
        changes,
      });
    }

    return updated;
  }

  async deleteTaskType(
    taskTypeId: string,
    replacementTypeId: string | undefined,
    context: CallerContext,
  ): Promise<void> {
    const taskType = await this.taskTypeRepo.findById(taskTypeId);

    if (!taskType) {
      throw new NotFoundError('Task type not found');
    }

    const project = await this.assertEditProjectConfig(taskType.projectId, context);
    // Check if any tasks use this type
    const tasksWithType = await this.taskRepo.countByType(taskType.projectId, taskTypeId);

    if (tasksWithType > 0) {
      if (!replacementTypeId) {
        throw new ConflictError(
          'Task type is in use by tasks. Provide a replacementTypeId to reassign tasks before deletion.',
          'TASK_TYPE_IN_USE',
        );
      }

      const replacement = await this.taskTypeRepo.findById(replacementTypeId);

      if (!replacement || replacement.projectId !== taskType.projectId) {
        throw new NotFoundError('Replacement task type not found in this project');
      }

      // Update all tasks using this type
      await this.taskRepo.updateManyByType(taskType.projectId, taskTypeId, replacementTypeId);
    }

    // Audit side effect (before delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: taskType.projectId,
        entityType: 'TASK_TYPE',
        entityId: taskTypeId,
        action: 'DELETED',
        actorId: context.userId,
      });
    }

    await this.taskTypeRepo.delete(taskTypeId);
  }
}
