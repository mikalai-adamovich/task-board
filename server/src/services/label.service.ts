import type { Label, CreateLabel, UpdateLabel } from '@task-board/shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { LabelRepository } from '../repositories/label.repository.js';
import { ensurePermission } from './rbac.service.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import type { AuditService } from './audit.service.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface LabelServiceTaskRepo {
  removeLabelFromAll(projectId: string, labelId: string): Promise<void>;
}

export interface LabelServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface LabelServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

// ─── Label Service ───────────────────────────────────────────────────────────

/**
 * The ONE message an id-addressed label route answers with, whether the
 * id does not exist or belongs to another tenant.
 */
const LABEL_NOT_FOUND = 'Label not found';

export class LabelService {
  constructor(
    private readonly labelRepo: LabelRepository,
    private readonly taskRepo: LabelServiceTaskRepo,
    private readonly projectRepo: LabelServiceProjectRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: LabelServiceProjectMemberRepo,
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
   * project), then the RBAC matrix via {@link ensurePermission} — no ad-hoc
   * role strings, no fail-open early return.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertManageLabels(
    projectId: string,
    context: CallerContext,
    entityName = 'Project',
  ): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // `entityName` decides the 404 message. On a LABEL-addressed route the
    // entity being addressed is the label, so a foreign label must answer
    // exactly what a nonexistent one answers — otherwise the suppressed 403
    // comes back through `message` and any label id becomes a tenant-ownership
    // oracle. A project-addressed route keeps naming the project.
    // The WRITABLE seam — tenant scope first, then the single server-owned
    // rule that a project scheduled for deletion is read-only.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId, entityName);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission('manage_labels', userRole, membership?.role ?? null);

    return project;
  }

  async getLabelsByProject(projectId: string, context: CallerContext): Promise<Label[]> {
    await this.assertProjectScope(projectId, context);

    return this.labelRepo.findByProject(projectId);
  }

  async createLabel(projectId: string, input: CreateLabel, context: CallerContext): Promise<Label> {
    const project = await this.assertManageLabels(projectId, context);
    const normalizedName = input.name.toLowerCase().trim();
    const existing = await this.labelRepo.findByProjectAndNormalizedName(projectId, normalizedName);

    if (existing) {
      throw new ConflictError('A label with this name already exists in this project', 'DUPLICATE_LABEL');
    }

    const label = await this.labelRepo.create(projectId, input);

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'LABEL',
        entityId: label.id,
        action: 'CREATED',
        actorId: context.userId,
      });
    }

    return label;
  }

  async updateLabel(labelId: string, input: UpdateLabel, context: CallerContext): Promise<Label> {
    const label = await this.labelRepo.findById(labelId);

    if (!label) {
      throw new NotFoundError(LABEL_NOT_FOUND);
    }

    const project = await this.assertManageLabels(label.projectId, context, 'Label');
    const normalizedName = input.name.toLowerCase().trim();
    const existing = await this.labelRepo.findByProjectAndNormalizedName(label.projectId, normalizedName);

    if (existing && existing.id !== labelId) {
      throw new ConflictError('A label with this name already exists in this project', 'DUPLICATE_LABEL');
    }

    const updated = await this.labelRepo.update(labelId, { name: input.name, normalizedName });

    if (!updated) {
      throw new NotFoundError(LABEL_NOT_FOUND);
    }

    // Audit side effect
    if (this.auditService) {
      const changes = [{ field: 'name', oldValue: label.name, newValue: input.name }];

      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: updated.projectId,
        entityType: 'LABEL',
        entityId: updated.id,
        action: 'UPDATED',
        actorId: context.userId,
        changes,
      });
    }

    return updated;
  }

  async deleteLabel(labelId: string, context: CallerContext): Promise<void> {
    const label = await this.labelRepo.findById(labelId);

    if (!label) {
      throw new NotFoundError(LABEL_NOT_FOUND);
    }

    const project = await this.assertManageLabels(label.projectId, context, 'Label');

    // Remove all task-label associations
    await this.taskRepo.removeLabelFromAll(label.projectId, labelId);

    // Audit side effect (before delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId: label.projectId,
        entityType: 'LABEL',
        entityId: labelId,
        action: 'DELETED',
        actorId: context.userId,
      });
    }

    await this.labelRepo.delete(labelId);
  }
}
