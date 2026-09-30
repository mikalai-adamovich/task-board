import type { TaskRelationship, CreateTaskRelationship } from '@task-board/shared';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { TaskRelationshipRepository } from '../repositories/task-relationship.repository.js';
import { ensurePermission } from './rbac.service.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import type { AuditService } from './audit.service.js';

export interface TaskRelationshipServiceTaskRepo {
  findById(id: string): Promise<{ id: string; projectId: string } | null>;
}

export interface TaskRelationshipServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface TaskRelationshipServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

export class TaskRelationshipService {
  constructor(
    private readonly relationshipRepo: TaskRelationshipRepository,
    private readonly taskRepo: TaskRelationshipServiceTaskRepo,
    private readonly projectRepo: TaskRelationshipServiceProjectRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: TaskRelationshipServiceProjectMemberRepo,
  ) {}

  /**
   * V2-4: tenant scope FIRST (404 on a foreign project), then
   * `manage_task_relationships` (PROJECT_ADMIN + EDITOR; tenant Owner/Admin
   * bypass inside the RBAC matrix) via {@link ensurePermission}. This is the
   * defense-in-depth layer for id-based routes that carry no `:projectId` in
   * the path, and it no longer fails open when the context is missing.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertManageTaskRelationships(
    projectId: string,
    context: CallerContext,
  ): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — tenant scope first, then the single server-owned
    // rule that a project scheduled for deletion is read-only. Covers both
    // create and delete of a relationship.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission('manage_task_relationships', userRole, membership?.role ?? null);

    return project;
  }

  /**
   * A bare task id must never cross tenant boundaries. The task is
   * resolved first and its owning project is asserted against the caller's
   * tenant (404, not 403) BEFORE any relationship is read.
   */
  private async requireTaskInTenant(
    taskId: string,
    context: CallerContext,
  ): Promise<{ id: string; projectId: string }> {
    const { tenantId } = requireCallerContext(context);
    const task = await this.taskRepo.findById(taskId);

    if (!task) {
      throw new NotFoundError('Source task not found');
    }

    await assertProjectInTenant(this.projectRepo, task.projectId, tenantId, 'Task');

    return task;
  }

  async getRelationshipsByTask(taskId: string, context: CallerContext): Promise<TaskRelationship[]> {
    // The task itself must belong to the caller's tenant, otherwise the
    // relationship list of a foreign task would leak.
    await this.requireTaskInTenant(taskId, context);

    return this.relationshipRepo.findByTask(taskId);
  }

  async createRelationship(
    sourceTaskId: string,
    input: CreateTaskRelationship,
    context: CallerContext,
  ): Promise<TaskRelationship> {
    const { userId } = requireCallerContext(context);

    // Self-relationship prevention
    if (sourceTaskId === input.targetTaskId) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Cannot create a relationship to the same task');
    }

    // The SOURCE task is resolved and tenant-asserted first, so a
    // cross-tenant task id yields 404 before any further lookup.
    const sourceTask = await this.requireTaskInTenant(sourceTaskId, context);
    // Validate the target task exists in the same project
    const targetTask = await this.taskRepo.findById(input.targetTaskId);

    if (!targetTask) {
      throw new NotFoundError('Target task not found');
    }

    // Same-project validation
    if (sourceTask.projectId !== targetTask.projectId) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Both tasks must belong to the same project');
    }

    const project = await this.assertManageTaskRelationships(sourceTask.projectId, context);
    // There is no pre-check on this path, so the unique
    // `{projectId,sourceTaskId,targetTaskId}` index is what actually stops
    // a duplicate `blocks` / `relates_to` edge. A second request for the same
    // pair is a domain conflict, not a server fault: 409, never 500.
    const relationship = await withConflictOnDuplicate(
      () =>
        this.relationshipRepo.create({
          projectId: sourceTask.projectId,
          sourceTaskId,
          targetTaskId: input.targetTaskId,
          type: input.type,
          createdById: userId,
        }),
      () => new ConflictError('A relationship between these tasks already exists', 'CONFLICT'),
    );

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: sourceTask.projectId,
        entityType: 'TASK_RELATIONSHIP',
        entityId: relationship.id,
        action: 'CREATED',
        actorId: userId,
      });
    }

    return relationship;
  }

  async deleteRelationship(relationshipId: string, context: CallerContext): Promise<void> {
    const { userId } = requireCallerContext(context);
    const relationship = await this.relationshipRepo.findById(relationshipId);

    if (!relationship) {
      throw new NotFoundError('Task relationship not found');
    }

    // The relationship carries its projectId, so the tenant of the
    // addressee is asserted through the owning project (404 on a mismatch).
    const project = await this.assertManageTaskRelationships(relationship.projectId, context);

    // Audit side effect (before delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: relationship.projectId,
        entityType: 'TASK_RELATIONSHIP',
        entityId: relationshipId,
        action: 'DELETED',
        actorId: userId,
      });
    }

    await this.relationshipRepo.delete(relationshipId);
  }
}
