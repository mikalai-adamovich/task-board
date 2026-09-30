import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRelationshipService } from './task-relationship.service.js';
import type { TaskRelationshipRepository } from '../repositories/task-relationship.repository.js';
import type {
  TaskRelationshipServiceTaskRepo,
  TaskRelationshipServiceProjectRepo,
  TaskRelationshipServiceProjectMemberRepo,
} from './task-relationship.service.js';
import type { AuditService } from './audit.service.js';
import { AppError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import type { TaskRelationship } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockRelationshipRepo() {
  return {
    findByTask: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  } as unknown as TaskRelationshipRepository;
}

function createMockTaskRepo() {
  return {
    findById: vi.fn(),
  } as unknown as TaskRelationshipServiceTaskRepo;
}

function createMockProjectRepo() {
  return {
    findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }),
  } as unknown as TaskRelationshipServiceProjectRepo;
}

function createMockProjectMemberRepo(role: string | null) {
  return {
    findByUserAndProject: vi.fn().mockResolvedValue(role ? { role } : null),
  } as unknown as TaskRelationshipServiceProjectMemberRepo;
}

function createMockAuditService() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
}

function makeRelationship(overrides: Partial<TaskRelationship> = {}): TaskRelationship {
  return {
    id: 'rel-1',
    projectId: 'project-1',
    sourceTaskId: 'task-1',
    targetTaskId: 'task-2',
    type: 'BLOCKS',
    createdById: 'user-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as TaskRelationship;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TaskRelationshipService', () => {
  let relationshipRepo: ReturnType<typeof createMockRelationshipRepo>;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let projectRepo: ReturnType<typeof createMockProjectRepo>;
  let auditService: ReturnType<typeof createMockAuditService>;
  /** The caller context every project-scoped method now REQUIRES. */
  const ctx = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

  beforeEach(() => {
    relationshipRepo = createMockRelationshipRepo();
    taskRepo = createMockTaskRepo();
    projectRepo = createMockProjectRepo();
    auditService = createMockAuditService();
  });

  describe('getRelationshipsByTask', () => {
    it('returns all relationships for a task', async () => {
      relationshipRepo.findByTask = vi.fn().mockResolvedValue([makeRelationship()]);
      taskRepo.findById = vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' });

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);
      const result = await service.getRelationshipsByTask('task-1', ctx);

      expect(result).toHaveLength(1);
      expect(relationshipRepo.findByTask).toHaveBeenCalledWith('task-1');
    });

    // The read path had NO tenant assertion before.
    it('throws NOT_FOUND for a task of another tenant — the relationship list never leaks (M-02)', async () => {
      relationshipRepo.findByTask = vi.fn().mockResolvedValue([makeRelationship()]);
      taskRepo.findById = vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' });
      projectRepo.findById = vi.fn().mockResolvedValue({ tenantId: 'tenant-OTHER' });

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.getRelationshipsByTask('task-1', ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(relationshipRepo.findByTask).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' });

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.getRelationshipsByTask('task-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('createRelationship', () => {
    const input = { targetTaskId: 'task-2', type: 'BLOCKS' as const };

    function mockTasks(sourceProject = 'project-1', targetProject = 'project-1') {
      taskRepo.findById = vi.fn().mockImplementation((id: string) => {
        if (id === 'task-1') return Promise.resolve({ id: 'task-1', projectId: sourceProject });
        if (id === 'task-2') return Promise.resolve({ id: 'task-2', projectId: targetProject });
        return Promise.resolve(null);
      });
    }

    it('creates a relationship for a project admin', async () => {
      mockTasks();
      relationshipRepo.create = vi.fn().mockResolvedValue(makeRelationship());

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );
      const result = await service.createRelationship('task-1', input, ctx);

      expect(result.id).toBe('rel-1');
      expect(relationshipRepo.create).toHaveBeenCalledWith({
        projectId: 'project-1',
        sourceTaskId: 'task-1',
        targetTaskId: 'task-2',
        type: 'BLOCKS',
        createdById: 'user-1',
      });
    });

    it('allows an editor (manage_task_relationships includes EDITOR)', async () => {
      mockTasks();
      relationshipRepo.create = vi.fn().mockResolvedValue(makeRelationship());

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('EDITOR'),
      );

      await expect(service.createRelationship('task-1', input, ctx)).resolves.toBeDefined();
    });

    it('throws 422 when source and target are the same task', async () => {
      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(
        service.createRelationship('task-1', { targetTaskId: 'task-1', type: 'BLOCKS' }, ctx),
      ).rejects.toThrow(AppError);
    });

    it('throws NotFoundError when the source task does not exist', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(null);

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.createRelationship('missing', input, ctx)).rejects.toThrow('Source task not found');
    });

    it('throws NotFoundError when the target task does not exist', async () => {
      taskRepo.findById = vi
        .fn()
        .mockImplementation((id: string) =>
          id === 'task-1' ? Promise.resolve({ id: 'task-1', projectId: 'project-1' }) : Promise.resolve(null),
        );

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.createRelationship('task-1', input, ctx)).rejects.toThrow('Target task not found');
    });

    it('throws 422 when the tasks belong to different projects', async () => {
      mockTasks('project-1', 'project-2');

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.createRelationship('task-1', input, ctx)).rejects.toThrow(
        'Both tasks must belong to the same project',
      );
    });

    it('throws ForbiddenError for a viewer', async () => {
      mockTasks();

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('VIEWER'),
      );

      await expect(service.createRelationship('task-1', input, ctx)).rejects.toThrow(ForbiddenError);
      expect(relationshipRepo.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when membership lookup is unavailable', async () => {
      mockTasks();

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.createRelationship('task-1', input, ctx)).rejects.toThrow(
        'Project membership lookup is unavailable',
      );
    });

    it('throws NOT_FOUND for a SOURCE task of another tenant (M-02)', async () => {
      mockTasks();
      projectRepo.findById = vi.fn().mockResolvedValue({ tenantId: 'tenant-OTHER' });

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await expect(service.createRelationship('task-1', input, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(relationshipRepo.create).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      mockTasks();

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.createRelationship('task-1', input, undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(relationshipRepo.create).not.toHaveBeenCalled();
    });

    it('writes an audit event when audit service and project repo are present', async () => {
      mockTasks();
      relationshipRepo.create = vi.fn().mockResolvedValue(makeRelationship());

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.createRelationship('task-1', input, ctx);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'TASK_RELATIONSHIP', action: 'CREATED', actorId: 'user-1' }),
      );
    });
  });

  describe('deleteRelationship', () => {
    it('deletes a relationship for a project admin', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(makeRelationship());
      relationshipRepo.delete = vi.fn().mockResolvedValue(undefined);

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.deleteRelationship('rel-1', ctx);

      expect(relationshipRepo.delete).toHaveBeenCalledWith('rel-1');
    });

    it('throws NotFoundError when the relationship does not exist', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(null);

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.deleteRelationship('missing', ctx)).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError for a viewer', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(makeRelationship());

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('VIEWER'),
      );

      await expect(service.deleteRelationship('rel-1', ctx)).rejects.toThrow(ForbiddenError);
      expect(relationshipRepo.delete).not.toHaveBeenCalled();
    });

    // The relationship carries its own projectId, so the tenant of the
    // addressed relationship is asserted through that project.
    it('throws NOT_FOUND for a relationship whose project is in another tenant (M-02)', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(makeRelationship());
      // the caller is a PROJECT_ADMIN of ITS OWN tenant, but the project that
      // owns the relationship belongs to a DIFFERENT one → 404, not 403.
      projectRepo.findById = vi.fn().mockResolvedValue({ tenantId: 'tenant-OTHER' });

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await expect(service.deleteRelationship('rel-1', ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(relationshipRepo.delete).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(makeRelationship());

      const service = new TaskRelationshipService(relationshipRepo, taskRepo, projectRepo);

      await expect(service.deleteRelationship('rel-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(relationshipRepo.delete).not.toHaveBeenCalled();
    });

    it('writes a DELETED audit event before deleting', async () => {
      relationshipRepo.findById = vi.fn().mockResolvedValue(makeRelationship());
      relationshipRepo.delete = vi.fn().mockResolvedValue(undefined);

      const service = new TaskRelationshipService(
        relationshipRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.deleteRelationship('rel-1', ctx);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'TASK_RELATIONSHIP', action: 'DELETED', actorId: 'user-1' }),
      );
    });
  });
});
