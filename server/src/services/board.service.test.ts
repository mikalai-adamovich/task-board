import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoardService } from './board.service.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { StatusRepository } from '../repositories/status.repository.js';
import type { BoardConfig, Status } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockBoardRepo() {
  return {
    findByProject: vi.fn(),
    create: vi.fn(),
    updateColumnsWithVersion: vi.fn(),
    replaceStatusInColumns: vi.fn(),
    deleteByProject: vi.fn(),
  } as unknown as BoardRepository;
}

function createMockStatusRepo() {
  return {
    findById: vi.fn(),
    findByIds: vi.fn(),
    findByProject: vi.fn(),
    findByProjectAndNormalizedName: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as StatusRepository;
}

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    projectId: 'project-1',
    columns: [
      { id: 'col-1', statusIds: ['status-1'], position: 0 },
      { id: 'col-2', statusIds: ['status-2'], position: 1 },
    ],
    // A board carries a version, exactly as a task does.
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: 'status-1',
    projectId: 'project-1',
    name: 'TODO',
    normalizedName: 'todo',
    position: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('BoardService (single-board model)', () => {
  let boardRepo: ReturnType<typeof createMockBoardRepo>;
  let statusRepo: ReturnType<typeof createMockStatusRepo>;
  let projectRepo: { findById: ReturnType<typeof vi.fn> };
  let projectMemberRepo: { findByUserAndProject: ReturnType<typeof vi.fn> };
  let service: BoardService;
  /** The caller context every project-scoped method now REQUIRES. */
  const ctx = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };
  /** A context pointing at a DIFFERENT tenant — must yield 404, never 403. */
  const foreignCtx = { tenantId: 'tenant-OTHER', userId: 'user-1', userRole: 'MEMBER' };

  beforeEach(() => {
    boardRepo = createMockBoardRepo();
    statusRepo = createMockStatusRepo();
    projectRepo = { findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }) };
    // The project-member repo is now a REQUIRED dependency of the mutation path
    // (a missing one means "cannot prove membership" → 403, never a silent skip),
    // so the default wiring grants PROJECT_ADMIN.
    projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) };
    service = new BoardService(boardRepo, statusRepo, projectRepo as never, undefined, projectMemberRepo);
  });

  describe('getBoardByProject', () => {
    it('returns the project board when found', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());

      const result = await service.getBoardByProject('project-1', ctx);

      expect(result.projectId).toBe('project-1');
      expect(boardRepo.findByProject).toHaveBeenCalledWith('project-1');
    });

    it('throws NOT_FOUND when the board does not exist', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(null);

      await expect(service.getBoardByProject('project-1', ctx)).rejects.toThrow('Board not found');
    });

    // The read path used to have NO tenant assertion at all.
    it('throws NOT_FOUND (not 403) for a project of another tenant (M-02)', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());

      await expect(service.getBoardByProject('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(boardRepo.findByProject).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());

      await expect(service.getBoardByProject('project-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(boardRepo.findByProject).not.toHaveBeenCalled();
    });
  });

  describe('updateColumns', () => {
    it('updates the columns after validating statuses', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());
      statusRepo.findByIds = vi.fn().mockResolvedValue([makeStatus(), makeStatus({ id: 'status-2' })]);
      boardRepo.updateColumnsWithVersion = vi
        .fn()
        .mockResolvedValue(
          makeBoard({ columns: [{ id: 'col-1', statusIds: ['status-1', 'status-2'], position: 0 }], version: 2 }),
        );

      const result = await service.updateColumns(
        'project-1',
        { columns: [{ statusIds: ['status-1', 'status-2'], position: 0 }], version: 1 },
        { tenantId: 'tenant-1', userId: 'user-1', userRole: 'OWNER' },
      );

      // The version the client read is forwarded to the atomic write — that is
      // the whole of the version check on this path.
      expect(boardRepo.updateColumnsWithVersion).toHaveBeenCalledWith(
        'project-1',
        [{ statusIds: ['status-1', 'status-2'], position: 0 }],
        1,
      );
      expect(result.version).toBe(2);
      expect(result.columns[0]?.statusIds).toEqual(['status-1', 'status-2']);
    });

    it('throws NOT_FOUND when the board does not exist', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(null);

      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 },
          { tenantId: 'tenant-1', userId: 'user-1', userRole: 'OWNER' },
        ),
      ).rejects.toThrow('Board not found');
    });

    it('throws NOT_FOUND when a status does not belong to the project', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());
      statusRepo.findByIds = vi.fn().mockResolvedValue([]);

      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['bad-status'], position: 0 }], version: 1 },
          { tenantId: 'tenant-1', userId: 'user-1', userRole: 'OWNER' },
        ),
      ).rejects.toThrow('not found in project');
    });

    it('M-14: validates all status ids with ONE batched findByIds call', async () => {
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());
      statusRepo.findByIds = vi.fn().mockResolvedValue([makeStatus(), makeStatus({ id: 'status-2' })]);
      boardRepo.updateColumnsWithVersion = vi.fn().mockResolvedValue(makeBoard());

      await service.updateColumns(
        'project-1',
        {
          columns: [
            { statusIds: ['status-1'], position: 0 },
            { statusIds: ['status-2', 'status-1'], position: 1 },
          ],
          version: 1,
        },
        { tenantId: 'tenant-1', userId: 'user-1', userRole: 'OWNER' },
      );

      // one batched lookup for the deduped id set — not one findById per status
      expect(statusRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(statusRepo.findByIds).toHaveBeenCalledWith(['status-1', 'status-2']);
      expect(statusRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ── V2-4: manage_boards enforcement ──────────────────────────────────────

  describe('manage_boards enforcement', () => {
    beforeEach(() => {
      projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) };
      service = new BoardService(boardRepo, statusRepo, projectRepo as never, undefined, projectMemberRepo);
      boardRepo.findByProject = vi.fn().mockResolvedValue(makeBoard());
      statusRepo.findByIds = vi.fn().mockResolvedValue([makeStatus()]);
      boardRepo.updateColumnsWithVersion = vi.fn().mockResolvedValue(makeBoard());
    });

    it('denies updateColumns for an EDITOR (manage_boards is PROJECT_ADMIN only)', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });

      await expect(
        service.updateColumns('project-1', { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 }, ctx),
      ).rejects.toThrow("Insufficient permissions. Requires 'manage_boards'.");
      expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
    });

    it('allows updateColumns for a PROJECT_ADMIN', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });

      await expect(
        service.updateColumns('project-1', { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 }, ctx),
      ).resolves.toBeDefined();
    });

    it('bypasses the project role for a tenant ADMIN', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue(null);

      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 },
          {
            ...ctx,
            userRole: 'ADMIN',
          },
        ),
      ).resolves.toBeDefined();
    });

    it('denies a tenant MEMBER without a project membership (403)', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue(null);

      await expect(
        service.updateColumns('project-1', { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 }, ctx),
      ).rejects.toThrow("Insufficient permissions. Requires 'manage_boards'.");
      expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND for a project of another tenant — the tenant check runs BEFORE the role check', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });

      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 },
          foreignCtx,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
    });

    /**
     * INVERTED from the pre-audit expectation: the old guard was
     * `if (!userId || !userRole) return;` and this test asserted that skipping
     * the check was CORRECT. That fail-open shape is exactly what let a call
     * site that forgot the caller context bypass `manage_boards` entirely.
     * The context is now required, so a missing one throws 401.
     */
    it('throws 401 when no caller context is provided (no longer skips the check)', async () => {
      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 },
          undefined as never,
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(projectMemberRepo.findByUserAndProject).not.toHaveBeenCalled();
      expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context carries no role', async () => {
      await expect(
        service.updateColumns(
          'project-1',
          { columns: [{ statusIds: ['status-1'], position: 0 }], version: 1 },
          {
            tenantId: 'tenant-1',
            userId: 'user-1',
            userRole: '',
          },
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
    });
  });
});
