import type { BoardConfig, UpdateBoardColumns } from '@task-board/shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { StatusRepository } from '../repositories/status.repository.js';
import { ensurePermission } from './rbac.service.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import type { AuditService } from './audit.service.js';

export interface BoardServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface BoardServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

// ─── Board Service ───────────────────────────────────────────────────────────

/**
 * Single-board model (doc 102): a project owns EXACTLY one board, identified
 * by its projectId. There is no board CRUD — the board is created atomically
 * with the project (seed) and deleted with it (cascade). The only mutation is
 * editing the columns/workflow.
 */
export class BoardService {
  constructor(
    private readonly boardRepo: BoardRepository,
    private readonly statusRepo: StatusRepository,
    private readonly projectRepo: BoardServiceProjectRepo,
    private readonly auditService?: AuditService,
    private readonly projectMemberRepo?: BoardServiceProjectMemberRepo,
  ) {}

  /**
   * (read path): the project must belong to the caller's
   * tenant, otherwise 404 — never 403, so a foreign project id looks exactly
   * like a nonexistent one. The caller context is REQUIRED; a missing one
   * throws (401) instead of silently skipping the check (fail closed).
   */
  private async assertProjectScope(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId } = requireCallerContext(context);

    return assertProjectInTenant(this.projectRepo, projectId, tenantId);
  }

  /**
   * Tenant scope FIRST (404 on a foreign project), then the single
   * server-owned write rule (a frozen project refuses the write), then
   * `manage_boards`
   * (PROJECT_ADMIN only; tenant Owner/Admin bypass inside the RBAC matrix)
   * via {@link ensurePermission}. The route also runs requirePermission — this
   * is the defense-in-depth layer, and it no longer fails open when the caller
   * context is missing.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertManageBoards(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — a project scheduled for deletion is read-only
    // (the promise the UI already makes), enforced here for the board too.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);

    if (!this.projectMemberRepo) {
      throw new ForbiddenError('Project membership lookup is unavailable');
    }

    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission('manage_boards', userRole, membership?.role ?? null);

    return project;
  }

  /** The project's single board. */
  async getBoardByProject(projectId: string, context: CallerContext): Promise<BoardConfig> {
    await this.assertProjectScope(projectId, context);

    const board = await this.boardRepo.findByProject(projectId);

    if (!board) {
      throw new NotFoundError('Board not found');
    }

    return board;
  }

  /** Replace the board's columns (workflow edit). */
  async updateColumns(projectId: string, input: UpdateBoardColumns, context: CallerContext): Promise<BoardConfig> {
    const project = await this.assertManageBoards(projectId, context);
    const current = await this.boardRepo.findByProject(projectId);

    if (!current) {
      throw new NotFoundError('Board not found');
    }

    // Optimistic concurrency, mirroring `TaskService.updateTask`
    // EXACTLY — a pre-check that names both versions, and a second refusal
    // when the atomic write loses the race between the read and the update.
    // The board write replaces the whole `columns` array, so without this the
    // second of two admins to save silently discards the first one's edit and
    // the API answers 200 with an audit event indistinguishable from an
    // ordinary save.
    if (current.version !== input.version) {
      throw new ConflictError(
        `Board was modified concurrently. Current version: ${current.version}, provided version: ${input.version}`,
        'CONFLICT',
      );
    }

    // Validate all statusIds belong to the same project
    await this.validateStatusIds(
      projectId,
      input.columns.flatMap((c) => c.statusIds),
    );

    const updated = await this.boardRepo.updateColumnsWithVersion(projectId, input.columns, input.version);

    if (!updated) {
      // The board vanished, or another save won the race between the read above
      // and this write. The task service reports the same case as a conflict
      // rather than a 404, and so does this one.
      throw new ConflictError(
        `Board was modified concurrently. Current version: ${current.version}, provided version: ${input.version}`,
        'CONFLICT',
      );
    }

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'BOARD',
        entityId: projectId,
        action: 'UPDATED',
        actorId: context.userId,
        changes: [{ field: 'columns', oldValue: current.columns, newValue: updated.columns }],
      });
    }

    return updated;
  }

  /**
   * Validate that all status IDs exist and belong to the given project.
   *
   * ONE batched `findByIds` query instead of a sequential `findById`
   * per status id; ownership is validated in code afterwards.
   */
  private async validateStatusIds(projectId: string, statusIds: string[]): Promise<void> {
    const uniqueStatusIds = [...new Set(statusIds)];

    if (uniqueStatusIds.length === 0) return;

    const statuses = await this.statusRepo.findByIds(uniqueStatusIds);
    const byId = new Map(statuses.map((status) => [status.id, status]));

    for (const statusId of uniqueStatusIds) {
      const status = byId.get(statusId);

      if (!status || status.projectId !== projectId) {
        throw new NotFoundError(`Status ${statusId} not found in project ${projectId}`);
      }
    }
  }
}
