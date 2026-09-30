import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusService } from './status.service.js';
import type { StatusServiceTaskRepo, StatusServiceBoardRepo, StatusServiceProjectRepo } from './status.service.js';
import { StatusRepository } from '../repositories/status.repository.js';
import type { CallerContext } from './tenant-assert.js';
import type { AuditService } from './audit.service.js';
import { UnauthorizedError } from '../errors/app-error.js';
import type { Status } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockStatusRepo() {
  return {
    findById: vi.fn(),
    findByProject: vi.fn(),
    findByProjectAndNormalizedName: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    reorderPositions: vi.fn(),
    delete: vi.fn(),
  } as unknown as StatusRepository;
}

function createMockTaskRepo(): StatusServiceTaskRepo {
  return {
    countByStatus: vi.fn().mockResolvedValue(0),
    updateManyByStatus: vi.fn().mockResolvedValue(undefined),
    // Rename fan-out
    setStatusNameForTasks: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBoardRepo(): StatusServiceBoardRepo {
  return {
    replaceStatusInColumns: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProjectRepo(tenantId = 'tenant-1'): StatusServiceProjectRepo {
  return {
    findById: vi.fn().mockResolvedValue({ tenantId, status: 'ACTIVE' }),
  };
}

function createMockAuditService(): AuditService {
  return {
    log: vi.fn().mockResolvedValue({}),
    queryByProject: vi.fn(),
    queryByTenant: vi.fn(),
  } as unknown as AuditService;
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
  } as Status;
}

/** A caller context is now REQUIRED on every project-scoped method. */
const CTX: CallerContext = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

describe('StatusService', () => {
  let statusRepo: ReturnType<typeof createMockStatusRepo>;
  let taskRepo: StatusServiceTaskRepo;
  let boardRepo: StatusServiceBoardRepo;
  let projectRepo: StatusServiceProjectRepo;
  let auditService: AuditService;
  // The membership lookup is a hard dependency of the (fail-closed) guard, so
  // the default fixture carries an authorized project admin.
  let projectMemberRepo: { findByUserAndProject: ReturnType<typeof vi.fn> };
  let service: StatusService;

  beforeEach(() => {
    statusRepo = createMockStatusRepo();
    taskRepo = createMockTaskRepo();
    boardRepo = createMockBoardRepo();
    projectRepo = createMockProjectRepo();
    auditService = createMockAuditService();
    projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) };
    service = new StatusService(statusRepo, taskRepo, boardRepo, projectRepo, auditService, projectMemberRepo);
  });

  // ── V2-4: manage_statuses enforcement ────────────────────────────────────

  describe('manage_statuses enforcement (V2-4)', () => {
    beforeEach(() => {
      projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) };
      service = new StatusService(statusRepo, taskRepo, boardRepo, projectRepo, auditService, projectMemberRepo);
    });

    it('denies createStatus for a VIEWER', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.createStatus('project-1', { name: 'New', position: 5 }, CTX)).rejects.toThrow(
        'manage_statuses',
      );
      expect(statusRepo.create).not.toHaveBeenCalled();
    });

    it('allows createStatus for a PROJECT_ADMIN', async () => {
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.create = vi.fn().mockResolvedValue(makeStatus({ id: 'status-new', name: 'New' }));
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });

      const status = await service.createStatus('project-1', { name: 'New', position: 5 }, CTX);

      expect(status.id).toBe('status-new');
    });

    it('denies deleteStatus for an EDITOR (id-based route — service is the only gate)', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });

      await expect(service.deleteStatus('status-1', undefined, CTX)).rejects.toThrow('manage_statuses');
      expect(statusRepo.delete).not.toHaveBeenCalled();
    });

    it('bypasses the project role for a tenant ADMIN', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.delete = vi.fn().mockResolvedValue(true);
      // no membership record at all
      projectMemberRepo.findByUserAndProject.mockResolvedValue(null);

      await service.deleteStatus('status-1', undefined, { ...CTX, userRole: 'ADMIN' });

      expect(statusRepo.delete).toHaveBeenCalledWith('status-1');
    });
  });

  describe('getStatusesByProject', () => {
    it('returns all statuses for a project', async () => {
      statusRepo.findByProject = vi.fn().mockResolvedValue([makeStatus()]);

      const result = await service.getStatusesByProject('project-1', CTX);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('TODO');
    });
  });

  describe('createStatus', () => {
    it('creates a status when name is unique', async () => {
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.create = vi.fn().mockResolvedValue(makeStatus());

      const result = await service.createStatus('project-1', { name: 'TODO', position: 0 }, CTX);

      expect(result.name).toBe('TODO');
      expect(statusRepo.create).toHaveBeenCalledWith('project-1', { name: 'TODO', position: 0 });
    });

    it('throws DUPLICATE_STATUS when name exists (case-insensitive)', async () => {
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(makeStatus());

      await expect(service.createStatus('project-1', { name: 'todo', position: 0 }, CTX)).rejects.toThrow(
        'A status with this name already exists',
      );
    });

    it('creates audit event on status creation', async () => {
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.create = vi.fn().mockResolvedValue(makeStatus());

      await service.createStatus('project-1', { name: 'TODO', position: 0 }, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          entityType: 'STATUS',
          entityId: 'status-1',
          action: 'CREATED',
          actorId: 'user-1',
        }),
      );
    });
  });

  describe('updateStatus', () => {
    it('updates name and normalizedName when name changes', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.update = vi.fn().mockResolvedValue(makeStatus({ name: 'In Progress', normalizedName: 'in progress' }));

      await service.updateStatus('status-1', { name: 'In Progress' }, CTX);

      expect(statusRepo.update).toHaveBeenCalledWith('status-1', {
        name: 'In Progress',
        normalizedName: 'in progress',
      });
    });

    it('TOP-2: fans the renamed status name out to tasks', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.update = vi.fn().mockResolvedValue(makeStatus({ name: 'In Progress', normalizedName: 'in progress' }));

      await service.updateStatus('status-1', { name: 'In Progress' }, CTX);

      expect(taskRepo.setStatusNameForTasks).toHaveBeenCalledWith('project-1', 'status-1', 'In Progress');
    });

    it('TOP-2: does not fan out when the name is unchanged', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.update = vi.fn().mockResolvedValue(makeStatus({ position: 3 }));

      await service.updateStatus('status-1', { position: 3 }, CTX);

      expect(taskRepo.setStatusNameForTasks).not.toHaveBeenCalled();
    });

    it('throws DUPLICATE_STATUS when new name conflicts', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(makeStatus({ id: 'status-2' }));

      await expect(service.updateStatus('status-1', { name: 'IN_PROGRESS' }, CTX)).rejects.toThrow(
        'A status with this name already exists',
      );
    });

    it('creates audit event on status update', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.update = vi.fn().mockResolvedValue(makeStatus({ name: 'In Progress', normalizedName: 'in progress' }));

      await service.updateStatus('status-1', { name: 'In Progress' }, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'STATUS',
          action: 'UPDATED',
          actorId: 'user-1',
          changes: expect.arrayContaining([
            expect.objectContaining({ field: 'name', oldValue: 'TODO', newValue: 'In Progress' }),
          ]),
        }),
      );
    });
  });

  describe('deleteStatus', () => {
    it('deletes status not in use', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      (taskRepo.countByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.deleteStatus('status-1', undefined, CTX);

      expect(statusRepo.delete).toHaveBeenCalledWith('status-1');
    });

    it('throws STATUS_IN_USE when status is in use without replacement', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      (taskRepo.countByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      await expect(service.deleteStatus('status-1', undefined, CTX)).rejects.toThrow('Status is in use by tasks');
    });

    it('uses STATUS_IN_USE error code (not INVALID_STATUS_REPLACEMENT)', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      (taskRepo.countByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      try {
        await service.deleteStatus('status-1', undefined, CTX);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        const err = error as { code: string };

        expect(err.code).toBe('STATUS_IN_USE');
      }
    });

    it('updates tasks and board columns when replacement provided', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      (taskRepo.countByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      statusRepo.findById = vi
        .fn()
        .mockResolvedValueOnce(makeStatus()) // first call: the status being deleted
        .mockResolvedValueOnce(makeStatus({ id: 'status-2', name: 'IN_PROGRESS' })); // replacement

      await service.deleteStatus('status-1', 'status-2', CTX);

      // The fan-out carries the replacement's denormalized name
      expect(taskRepo.updateManyByStatus).toHaveBeenCalledWith('project-1', 'status-1', 'status-2', 'IN_PROGRESS');
      expect(boardRepo.replaceStatusInColumns).toHaveBeenCalledWith('project-1', 'status-1', 'status-2');
      expect(statusRepo.delete).toHaveBeenCalledWith('status-1');
    });

    it('creates audit event on status deletion', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      (taskRepo.countByStatus as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.deleteStatus('status-1', undefined, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'STATUS',
          action: 'DELETED',
          actorId: 'user-1',
        }),
      );
    });
  });

  // ── Tenant isolation + fail-closed guardrails ─────────────────────────────

  describe('tenant isolation (M-001/M-006/M-034)', () => {
    /** tenant-B owner hitting tenant-A's project-1 — the RBAC bypass is irrelevant */
    const foreignCtx: CallerContext = { tenantId: 'tenant-OTHER', userId: 'user-1', userRole: 'OWNER' };
    /** the historical fail-open shape: no context at all */
    const emptyCtx: CallerContext = { tenantId: '', userId: '', userRole: '' };

    beforeEach(() => {
      // no project membership at all — only the tenant seam can stop this caller
      projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) };
      service = new StatusService(statusRepo, taskRepo, boardRepo, projectRepo, auditService, projectMemberRepo);
    });

    it('createStatus rejects a foreign tenant with 404 and creates nothing', async () => {
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.create = vi.fn().mockResolvedValue(makeStatus());

      await expect(
        service.createStatus('project-1', { name: 'HIJACKED', position: 9 }, foreignCtx),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(statusRepo.create).not.toHaveBeenCalled();
    });

    it('getStatusesByProject rejects a foreign tenant with 404 and lists nothing', async () => {
      statusRepo.findByProject = vi.fn().mockResolvedValue([makeStatus()]);

      await expect(service.getStatusesByProject('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(statusRepo.findByProject).not.toHaveBeenCalled();
    });

    it('reorder rejects a foreign tenant with 404 and reorders nothing', async () => {
      await expect(service.reorder('project-1', [{ id: 'status-1', position: 3 }], foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(statusRepo.reorderPositions).not.toHaveBeenCalled();
    });

    it('updateStatus on a foreign-tenant status is 404 and never renames it', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());
      statusRepo.update = vi.fn().mockResolvedValue(makeStatus({ name: 'HIJACKED' }));

      await expect(service.updateStatus('status-1', { name: 'HIJACKED' }, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(statusRepo.update).not.toHaveBeenCalled();
    });

    it('deleteStatus on a foreign-tenant status is 404 and never deletes it', async () => {
      statusRepo.findById = vi.fn().mockResolvedValue(makeStatus());

      await expect(service.deleteStatus('status-1', undefined, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(statusRepo.delete).not.toHaveBeenCalled();
    });

    it('a 404 for a foreign project is indistinguishable from a nonexistent one', async () => {
      const missingProjectRepo: StatusServiceProjectRepo = { findById: vi.fn().mockResolvedValue(null) };
      const absent = new StatusService(
        statusRepo,
        taskRepo,
        boardRepo,
        missingProjectRepo,
        auditService,
        projectMemberRepo,
      );
      const messageOf = async (s: StatusService) =>
        s
          .createStatus('project-1', { name: 'X', position: 1 }, foreignCtx)
          .then(() => null)
          .catch((e: Error) => e.message);

      expect(await messageOf(service)).toBe(await messageOf(absent));
    });

    it('throws Unauthorized (401) instead of silently skipping the check when the context is empty', async () => {
      await expect(service.createStatus('project-1', { name: 'New', position: 1 }, emptyCtx)).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(service.getStatusesByProject('project-1', emptyCtx)).rejects.toThrow(UnauthorizedError);
      await expect(service.reorder('project-1', [{ id: 'status-1', position: 1 }], emptyCtx)).rejects.toThrow(
        UnauthorizedError,
      );
      expect(statusRepo.create).not.toHaveBeenCalled();
      expect(statusRepo.reorderPositions).not.toHaveBeenCalled();
    });

    it('throws Forbidden (403) for a VIEWER inside the owning tenant', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.createStatus('project-1', { name: 'New', position: 1 }, CTX)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(statusRepo.create).not.toHaveBeenCalled();
    });

    it('happy path: a project admin of the owning tenant still succeeds', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });
      statusRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      statusRepo.create = vi.fn().mockResolvedValue(makeStatus());

      const result = await service.createStatus('project-1', { name: 'TODO', position: 0 }, CTX);

      expect(result.id).toBe('status-1');
      expect(statusRepo.create).toHaveBeenCalledWith('project-1', { name: 'TODO', position: 0 });
    });
  });
});
