import { ProjectStatus, SprintStatus } from '@task-board/shared';
import type { Sprint, CreateSprint, UpdateSprint } from '@task-board/shared';
import { AppError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import { SprintRepository } from '../repositories/sprint.repository.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { ensurePermission } from './rbac.service.js';
import type { AuditService } from './audit.service.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface SprintServiceTaskRepo {
  clearSprintFromTasks(projectId: string, sprintId: string): Promise<void>;
  /** Propagate a sprint rename to the denormalized task.sprintName */
  setSprintNameForTasks(projectId: string, sprintId: string, sprintName: string): Promise<void>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface SprintServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

// ─── Sprint Service ──────────────────────────────────────────────────────────

export class SprintService {
  constructor(
    private readonly sprintRepo: SprintRepository,
    private readonly projectRepo: ProjectRepository,
    private readonly taskRepo: SprintServiceTaskRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: SprintServiceProjectMemberRepo,
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
   * project), then the RBAC matrix (`create_sprint` / `change_sprint_status` —
   * PROJECT_ADMIN only; tenant Owner/Admin bypass inside the matrix) via
   * {@link ensurePermission}. Routes with `:projectId` in the path are
   * additionally gated by requirePermission — this is the id-based-route
   * layer, and it no longer fails open when the context is missing.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertSprintPermission(
    action: 'create_sprint' | 'change_sprint_status',
    projectId: string,
    context: CallerContext,
  ): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — tenant scope first, then the single server-owned
    // rule that a project scheduled for deletion is read-only. This also
    // subsumes the ad-hoc ACTIVE check `createSprint` used to repeat.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission(action, userRole, membership?.role ?? null);

    return project;
  }

  async getSprintsByProject(projectId: string, context: CallerContext): Promise<Sprint[]> {
    await this.assertProjectScope(projectId, context);

    return this.sprintRepo.findByProject(projectId);
  }

  async getSprint(id: string, context: CallerContext): Promise<Sprint> {
    const sprint = await this.sprintRepo.findById(id);

    if (!sprint) {
      throw new NotFoundError('Sprint not found');
    }

    // A bare sprint id must never cross tenant boundaries (404, not 403)
    await this.assertProjectScope(sprint.projectId, context);

    return sprint;
  }

  async createSprint(projectId: string, input: CreateSprint, context: CallerContext): Promise<Sprint> {
    const project = await this.assertSprintPermission('create_sprint', projectId, context);
    // Validate project exists and is ACTIVE
    const fullProject = await this.projectRepo.findById(projectId);

    if (!fullProject) {
      throw new NotFoundError('Project not found');
    }

    if (fullProject.status !== ProjectStatus.ACTIVE) {
      throw new AppError(400, 'PROJECT_ARCHIVED', 'Cannot create sprints in an archived project');
    }

    // Validate date constraints
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new AppError(422, 'INVALID_SPRINT_DATES', 'endDate must be >= startDate');
    }

    const sprint = await this.sprintRepo.create(projectId, {
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'SPRINT',
        entityId: sprint.id,
        action: 'CREATED',
        actorId: context.userId,
      });
    }

    return sprint;
  }

  async updateSprint(id: string, input: UpdateSprint, context: CallerContext): Promise<Sprint> {
    const sprint = await this.sprintRepo.findById(id);

    if (!sprint) {
      throw new NotFoundError('Sprint not found');
    }

    const project = await this.assertSprintPermission('change_sprint_status', sprint.projectId, context);
    // Handle status transitions with date side effects
    const updates: {
      name?: string;
      status?: string;
      startDate?: string | Date | null;
      endDate?: string | Date | null;
    } = {};

    if (input.name !== undefined) updates.name = input.name;

    if (input.status !== undefined && input.status !== sprint.status) {
      updates.status = input.status;

      // Starting sprint: set startDate to now only when null (DEC-016 — endDate is never modified on start)
      if (input.status === SprintStatus.ACTIVE) {
        if (!sprint.startDate && !input.startDate) {
          updates.startDate = new Date();
        }
      }

      // Completing sprint: set endDate to now if null
      if (input.status === SprintStatus.COMPLETED) {
        if (!sprint.endDate && !input.endDate) {
          updates.endDate = new Date();
        }
      }
    }

    if (input.startDate !== undefined) updates.startDate = input.startDate;
    if (input.endDate !== undefined) updates.endDate = input.endDate;

    // Validate date constraints
    const toDate = (value: string | Date | null | undefined): Date | null => {
      if (value === null || value === undefined) return null;
      return new Date(value);
    };
    const effectiveStartDate = updates.startDate !== undefined ? toDate(updates.startDate) : toDate(sprint.startDate);
    const effectiveEndDate = updates.endDate !== undefined ? toDate(updates.endDate) : toDate(sprint.endDate);

    if (effectiveStartDate && effectiveEndDate && effectiveEndDate < effectiveStartDate) {
      throw new AppError(422, 'INVALID_SPRINT_DATES', 'endDate must be >= startDate');
    }

    const updated = await this.sprintRepo.update(id, updates);

    if (!updated) {
      throw new NotFoundError('Sprint not found');
    }

    // Propagate a rename to the denormalized task.sprintName (sort-only)
    if (input.name !== undefined && input.name !== sprint.name) {
      await this.taskRepo.setSprintNameForTasks(sprint.projectId, id, input.name);
    }

    // Audit side effect
    if (this.auditService) {
      const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];

      if (input.name !== undefined) changes.push({ field: 'name', oldValue: sprint.name, newValue: input.name });
      if (input.status !== undefined)
        changes.push({ field: 'status', oldValue: sprint.status, newValue: input.status });
      if (input.startDate !== undefined)
        changes.push({ field: 'startDate', oldValue: sprint.startDate, newValue: input.startDate });
      if (input.endDate !== undefined)
        changes.push({ field: 'endDate', oldValue: sprint.endDate, newValue: input.endDate });
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: updated.projectId,
        entityType: 'SPRINT',
        entityId: updated.id,
        action: 'UPDATED',
        actorId: context.userId,
        changes,
      });
    }

    return updated;
  }

  async deleteSprint(id: string, context: CallerContext): Promise<void> {
    const sprint = await this.sprintRepo.findById(id);

    if (!sprint) {
      throw new NotFoundError('Sprint not found');
    }

    const project = await this.assertSprintPermission('change_sprint_status', sprint.projectId, context);

    // Set sprintId = null on all affected tasks
    await this.taskRepo.clearSprintFromTasks(sprint.projectId, id);

    // Audit side effect (before hard delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: sprint.projectId,
        entityType: 'SPRINT',
        entityId: sprint.id,
        action: 'DELETED',
        actorId: context.userId,
      });
    }

    // Hard delete the sprint
    await this.sprintRepo.delete(id);
  }
}
