import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskTypeService } from './task-type.service.js';
import type {
  TaskTypeServiceTaskRepo,
  TaskTypeServiceProjectRepo,
  TaskTypeServiceProjectMemberRepo,
} from './task-type.service.js';
import { TaskTypeRepository } from '../repositories/task-type.repository.js';
import type { CallerContext } from './tenant-assert.js';
import type { AuditService } from './audit.service.js';
import { UnauthorizedError } from '../errors/app-error.js';
import type { TaskType } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockTaskTypeRepo() {
  return {
    findById: vi.fn(),
    findByProject: vi.fn(),
    findByProjectAndKey: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    reorderPositions: vi.fn(),
    delete: vi.fn(),
  } as unknown as TaskTypeRepository;
}

function createMockTaskRepo(): TaskTypeServiceTaskRepo {
  return {
    countByType: vi.fn().mockResolvedValue(0),
    updateManyByType: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProjectRepo(tenantId = 'tenant-1'): TaskTypeServiceProjectRepo {
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

function makeTaskType(overrides: Partial<TaskType> = {}): TaskType {
  return {
    id: 'type-1',
    projectId: 'project-1',
    key: 'TASK',
    name: 'Task',
    icon: '📋',
    position: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as TaskType;
}

/** A caller context is now REQUIRED on every project-scoped method. */
const CTX: CallerContext = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

describe('TaskTypeService', () => {
  let taskTypeRepo: ReturnType<typeof createMockTaskTypeRepo>;
  let taskRepo: TaskTypeServiceTaskRepo;
  let projectRepo: TaskTypeServiceProjectRepo;
  let auditService: AuditService;
  // Hard dependency of the (fail-closed) guard → the default fixture is an
  // authorized project admin.
  let projectMemberRepo: TaskTypeServiceProjectMemberRepo & { findByUserAndProject: ReturnType<typeof vi.fn> };
  let service: TaskTypeService;

  beforeEach(() => {
    taskTypeRepo = createMockTaskTypeRepo();
    taskRepo = createMockTaskRepo();
    projectRepo = createMockProjectRepo();
    auditService = createMockAuditService();
    projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) };
    service = new TaskTypeService(taskTypeRepo, taskRepo, projectRepo, auditService, projectMemberRepo);
  });

  describe('getTaskTypesByProject', () => {
    it('returns all task types for a project', async () => {
      taskTypeRepo.findByProject = vi.fn().mockResolvedValue([makeTaskType()]);

      const result = await service.getTaskTypesByProject('project-1', CTX);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Task');
    });
  });

  describe('createTaskType', () => {
    it('creates a task type when key is unique', async () => {
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(null);
      taskTypeRepo.create = vi.fn().mockResolvedValue(makeTaskType());

      const result = await service.createTaskType('project-1', { key: 'TASK', name: 'Task', position: 0 }, CTX);

      expect(result.name).toBe('Task');
    });

    it('throws CONFLICT when key exists', async () => {
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(makeTaskType());

      await expect(
        service.createTaskType('project-1', { key: 'TASK', name: 'Task', position: 0 }, CTX),
      ).rejects.toThrow('A task type with this key already exists');
    });

    it('creates audit event on task type creation', async () => {
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(null);
      taskTypeRepo.create = vi.fn().mockResolvedValue(makeTaskType());

      await service.createTaskType('project-1', { key: 'TASK', name: 'Task', position: 0 }, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'TASK_TYPE',
          action: 'CREATED',
          actorId: 'user-1',
        }),
      );
    });
  });

  describe('updateTaskType', () => {
    it('updates name only (key is immutable)', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.update = vi.fn().mockResolvedValue(makeTaskType({ name: 'New Name' }));

      await service.updateTaskType('type-1', { name: 'New Name' }, CTX);

      expect(taskTypeRepo.update).toHaveBeenCalledWith('type-1', {
        name: 'New Name',
        icon: undefined,
        position: undefined,
      });
    });

    it('creates audit event on task type update', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.update = vi.fn().mockResolvedValue(makeTaskType({ name: 'New Name' }));

      await service.updateTaskType('type-1', { name: 'New Name' }, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'TASK_TYPE',
          action: 'UPDATED',
          actorId: 'user-1',
          changes: expect.arrayContaining([
            expect.objectContaining({ field: 'name', oldValue: 'Task', newValue: 'New Name' }),
          ]),
        }),
      );
    });
  });

  describe('deleteTaskType', () => {
    it('deletes task type not in use', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      (taskRepo.countByType as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.deleteTaskType('type-1', undefined, CTX);

      expect(taskTypeRepo.delete).toHaveBeenCalledWith('type-1');
    });

    it('throws TASK_TYPE_IN_USE when type is in use without replacement', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      (taskRepo.countByType as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      await expect(service.deleteTaskType('type-1', undefined, CTX)).rejects.toThrow('Task type is in use by tasks');
    });

    it('uses TASK_TYPE_IN_USE error code (not INVALID_STATUS_REPLACEMENT)', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      (taskRepo.countByType as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      try {
        await service.deleteTaskType('type-1', undefined, CTX);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        const err = error as { code: string };

        expect(err.code).toBe('TASK_TYPE_IN_USE');
      }
    });

    it('updates tasks when replacement provided', async () => {
      taskTypeRepo.findById = vi
        .fn()
        .mockResolvedValueOnce(makeTaskType())
        .mockResolvedValueOnce(makeTaskType({ id: 'type-2', key: 'BUG', name: 'Bug' }));
      (taskRepo.countByType as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      await service.deleteTaskType('type-1', 'type-2', CTX);

      expect(taskRepo.updateManyByType).toHaveBeenCalledWith('project-1', 'type-1', 'type-2');
      expect(taskTypeRepo.delete).toHaveBeenCalledWith('type-1');
    });

    it('creates audit event on task type deletion', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.delete = vi.fn().mockResolvedValue(true);
      (taskRepo.countByType as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.deleteTaskType('type-1', undefined, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'TASK_TYPE',
          action: 'DELETED',
          actorId: 'user-1',
        }),
      );
    });
  });

  // ── V2-4: edit_project_config enforcement ────────────────────────────────

  describe('edit_project_config enforcement', () => {
    beforeEach(() => {
      projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) };
      service = new TaskTypeService(taskTypeRepo, taskRepo, projectRepo, auditService, projectMemberRepo);
    });

    it('denies createTaskType for an EDITOR (edit_project_config is PROJECT_ADMIN only)', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });

      await expect(
        service.createTaskType('project-1', { key: 'BUG', name: 'Bug', position: 0 }, { ...CTX, userRole: 'EDITOR' }),
      ).rejects.toThrow("Insufficient permissions. Requires 'edit_project_config'.");
      expect(taskTypeRepo.create).not.toHaveBeenCalled();
    });

    it('denies updateTaskType for a VIEWER', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.updateTaskType('type-1', { name: 'X' }, { ...CTX, userRole: 'VIEWER' })).rejects.toThrow(
        "Insufficient permissions. Requires 'edit_project_config'.",
      );
      expect(taskTypeRepo.update).not.toHaveBeenCalled();
    });

    it('allows createTaskType for a PROJECT_ADMIN', async () => {
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(null);
      taskTypeRepo.create = vi.fn().mockResolvedValue(makeTaskType({ id: 'type-new', key: 'BUG', name: 'Bug' }));
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });

      const result = await service.createTaskType(
        'project-1',
        { key: 'BUG', name: 'Bug', position: 0 },
        { ...CTX, userRole: 'PROJECT_ADMIN' },
      );

      expect(result.key).toBe('BUG');
    });

    it('bypasses the project role for a tenant OWNER', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.delete = vi.fn().mockResolvedValue(true);
      // no membership record at all — tenant OWNER bypasses project-level checks
      projectMemberRepo.findByUserAndProject.mockResolvedValue(null);

      await service.deleteTaskType('type-1', undefined, { ...CTX, userRole: 'OWNER' });

      expect(taskTypeRepo.delete).toHaveBeenCalledWith('type-1');
    });

    /**
     * The old behaviour was "no caller context → silently
     * skip the check and delete anyway". That was the production hijack. It now
     * throws Unauthorized and touches nothing.
     */
    it('throws Unauthorized (fail closed) instead of skipping the check when no caller context is provided', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.delete = vi.fn().mockResolvedValue(true);

      await expect(
        service.deleteTaskType('type-1', undefined, { tenantId: '', userId: '', userRole: '' }),
      ).rejects.toThrow(UnauthorizedError);

      expect(projectMemberRepo.findByUserAndProject).not.toHaveBeenCalled();
      expect(taskTypeRepo.delete).not.toHaveBeenCalled();
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
      service = new TaskTypeService(taskTypeRepo, taskRepo, projectRepo, auditService, projectMemberRepo);
    });

    it('createTaskType rejects a foreign tenant with 404 and creates nothing', async () => {
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(null);
      taskTypeRepo.create = vi.fn().mockResolvedValue(makeTaskType());

      await expect(
        service.createTaskType('project-1', { key: 'BUG', name: 'Bug', position: 0 }, foreignCtx),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(taskTypeRepo.create).not.toHaveBeenCalled();
    });

    it('getTaskTypesByProject rejects a foreign tenant with 404 and lists nothing', async () => {
      taskTypeRepo.findByProject = vi.fn().mockResolvedValue([makeTaskType()]);

      await expect(service.getTaskTypesByProject('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskTypeRepo.findByProject).not.toHaveBeenCalled();
    });

    it('reorder rejects a foreign tenant with 404 and reorders nothing', async () => {
      await expect(service.reorder('project-1', [{ id: 'type-1', position: 2 }], foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskTypeRepo.reorderPositions).not.toHaveBeenCalled();
    });

    it('updateTaskType on a foreign-tenant type is 404 and never renames it', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());
      taskTypeRepo.update = vi.fn().mockResolvedValue(makeTaskType({ name: 'HIJACKED' }));

      await expect(service.updateTaskType('type-1', { name: 'HIJACKED' }, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskTypeRepo.update).not.toHaveBeenCalled();
    });

    it('deleteTaskType on a foreign-tenant type is 404 and never deletes it', async () => {
      taskTypeRepo.findById = vi.fn().mockResolvedValue(makeTaskType());

      await expect(service.deleteTaskType('type-1', undefined, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskTypeRepo.delete).not.toHaveBeenCalled();
    });

    it('a 404 for a foreign project is indistinguishable from a nonexistent one', async () => {
      const missingProjectRepo: TaskTypeServiceProjectRepo = { findById: vi.fn().mockResolvedValue(null) };
      const absent = new TaskTypeService(taskTypeRepo, taskRepo, missingProjectRepo, auditService, projectMemberRepo);
      const messageOf = async (s: TaskTypeService) =>
        s
          .createTaskType('project-1', { key: 'X', name: 'X', position: 0 }, foreignCtx)
          .then(() => null)
          .catch((e: Error) => e.message);

      expect(await messageOf(service)).toBe(await messageOf(absent));
    });

    it('throws Unauthorized (401) instead of silently skipping the check when the context is empty', async () => {
      await expect(
        service.createTaskType('project-1', { key: 'BUG', name: 'Bug', position: 0 }, emptyCtx),
      ).rejects.toThrow(UnauthorizedError);
      await expect(service.getTaskTypesByProject('project-1', emptyCtx)).rejects.toThrow(UnauthorizedError);
      expect(taskTypeRepo.create).not.toHaveBeenCalled();
    });

    it('throws Forbidden (403) for an EDITOR inside the owning tenant', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });

      await expect(
        service.createTaskType('project-1', { key: 'BUG', name: 'Bug', position: 0 }, CTX),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      expect(taskTypeRepo.create).not.toHaveBeenCalled();
    });

    it('happy path: a project admin of the owning tenant still succeeds', async () => {
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });
      taskTypeRepo.findByProjectAndKey = vi.fn().mockResolvedValue(null);
      taskTypeRepo.create = vi.fn().mockResolvedValue(makeTaskType());

      const result = await service.createTaskType('project-1', { key: 'TASK', name: 'Task', position: 0 }, CTX);

      expect(result.key).toBe('TASK');
    });
  });
});
