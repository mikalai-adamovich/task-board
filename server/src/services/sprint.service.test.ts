import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintService } from './sprint.service.js';
import type { SprintServiceTaskRepo } from './sprint.service.js';
import { SprintRepository } from '../repositories/sprint.repository.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import type { CallerContext } from './tenant-assert.js';
import { UnauthorizedError } from '../errors/app-error.js';
import type { Sprint } from '@task-board/shared';

function createMockSprintRepo() {
  return {
    findById: vi.fn(),
    findByProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as SprintRepository;
}

/** Owning tenant is 'tenant-1' — every project-scoped method now asserts it. */
function createMockProjectRepo() {
  return {
    findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }),
  } as unknown as ProjectRepository;
}

function createMockTaskRepo(): SprintServiceTaskRepo {
  return {
    clearSprintFromTasks: vi.fn().mockResolvedValue(undefined),
    // Rename fan-out
    setSprintNameForTasks: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    projectId: 'project-1',
    name: 'Sprint 1',
    status: 'FUTURE',
    startDate: null,
    endDate: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Sprint;
}

/** A caller context is now REQUIRED on every project-scoped method. */
const CTX: CallerContext = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

describe('SprintService', () => {
  let sprintRepo: ReturnType<typeof createMockSprintRepo>;
  let projectRepo: ReturnType<typeof createMockProjectRepo>;
  let taskRepo: SprintServiceTaskRepo;
  // Hard dependency of the (fail-closed) guard → the default fixture is an
  // authorized project admin.
  let projectMemberRepo: { findByUserAndProject: ReturnType<typeof vi.fn> };
  let service: SprintService;

  beforeEach(() => {
    sprintRepo = createMockSprintRepo();
    projectRepo = createMockProjectRepo();
    taskRepo = createMockTaskRepo();
    projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) };
    service = new SprintService(sprintRepo, projectRepo, taskRepo, undefined, projectMemberRepo);
  });

  // ── V2-4: sprint mutation enforcement ─────────────────────────────────────

  describe('sprint RBAC enforcement (V2-4)', () => {
    beforeEach(() => {
      projectMemberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) };
      service = new SprintService(sprintRepo, projectRepo, taskRepo, undefined, projectMemberRepo);
    });

    it('denies createSprint for a project EDITOR', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });

      await expect(service.createSprint('project-1', { name: 'Sprint X' }, CTX)).rejects.toThrow('create_sprint');
      expect(sprintRepo.create).not.toHaveBeenCalled();
    });

    it('allows createSprint for a PROJECT_ADMIN', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      sprintRepo.create = vi.fn().mockResolvedValue(makeSprint({ id: 'sprint-new' }));
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });

      const sprint = await service.createSprint('project-1', { name: 'Sprint X' }, CTX);

      expect(sprint.id).toBe('sprint-new');
    });

    it('denies updateSprint for a project VIEWER (id-based route — service is the only gate)', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.updateSprint('sprint-1', { name: 'Renamed' }, CTX)).rejects.toThrow('change_sprint_status');
      expect(sprintRepo.update).not.toHaveBeenCalled();
    });

    it('denies deleteSprint for a project EDITOR but allows a tenant OWNER bypass', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.delete = vi.fn().mockResolvedValue(true);

      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'EDITOR' });
      await expect(service.deleteSprint('sprint-1', CTX)).rejects.toThrow('change_sprint_status');
      expect(sprintRepo.delete).not.toHaveBeenCalled();

      // tenant OWNER bypasses without any project membership
      projectMemberRepo.findByUserAndProject.mockClear();
      await service.deleteSprint('sprint-1', { ...CTX, userRole: 'OWNER' });
      expect(sprintRepo.delete).toHaveBeenCalledWith('sprint-1');
    });
  });

  describe('getSprintsByProject', () => {
    it('returns sprints for a project', async () => {
      sprintRepo.findByProject = vi.fn().mockResolvedValue([makeSprint()]);

      const result = await service.getSprintsByProject('project-1', CTX);

      expect(result).toHaveLength(1);
    });
  });

  describe('getSprint', () => {
    it('returns sprint when found', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1' });

      const result = await service.getSprint('sprint-1', CTX);

      expect(result.name).toBe('Sprint 1');
    });

    it('throws NOT_FOUND when not found', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.getSprint('missing', CTX)).rejects.toThrow('Sprint not found');
    });

    it('throws NOT_FOUND (not 403) when the sprint belongs to another tenant (M-02)', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.getSprint('sprint-1', CTX)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('createSprint', () => {
    it('creates sprint with FUTURE status', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      sprintRepo.create = vi.fn().mockResolvedValue(makeSprint());

      const result = await service.createSprint('project-1', { name: 'Sprint 1' }, CTX);

      expect(result.status).toBe('FUTURE');
    });

    it('refuses the write when the project is archived (N-1: the shared write rule)', async () => {
      // This used to be an ad-hoc `status !== ACTIVE` check local to
      // `createSprint`, throwing 400 with its own message. It is now the ONE
      // server-owned predicate every project-scoped write uses, which answers
      // with the same 409 PROJECT_ARCHIVED the archived guard has always
      // produced — so the status and the code are now asserted rather than a
      // message substring.
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ARCHIVED' });

      await expect(service.createSprint('project-1', { name: 'Sprint 1' }, CTX)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PROJECT_ARCHIVED',
      });
    });

    it('refuses the write when the project is scheduled for deletion (N-1)', async () => {
      projectRepo.findById = vi
        .fn()
        .mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'DELETION_PENDING' });

      await expect(service.createSprint('project-1', { name: 'Sprint 1' }, CTX)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
    });
  });

  describe('updateSprint', () => {
    it('updates sprint name', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ name: 'Updated' }));

      const result = await service.updateSprint('sprint-1', { name: 'Updated' }, CTX);

      expect(result.name).toBe('Updated');
    });

    it('TOP-2: fans the renamed sprint name out to tasks', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ name: 'Updated' }));

      await service.updateSprint('sprint-1', { name: 'Updated' }, CTX);

      expect(taskRepo.setSprintNameForTasks).toHaveBeenCalledWith('project-1', 'sprint-1', 'Updated');
    });

    it('TOP-2: does not fan out when the name is unchanged', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ startDate: '2025-02-01T00:00:00.000Z' }));

      await service.updateSprint('sprint-1', { startDate: '2025-02-01T00:00:00.000Z' }, CTX);

      expect(taskRepo.setSprintNameForTasks).not.toHaveBeenCalled();
    });

    it('sets startDate but not endDate when transitioning to ACTIVE without dates (DEC-016)', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint({ status: 'FUTURE', startDate: null, endDate: null }));
      sprintRepo.update = vi.fn().mockImplementation((_id, input) =>
        Promise.resolve(
          makeSprint({
            status: input.status,
            startDate: input.startDate ? new Date(input.startDate).toISOString() : null,
            endDate: input.endDate ? new Date(input.endDate).toISOString() : null,
          }),
        ),
      );

      await service.updateSprint('sprint-1', { status: 'ACTIVE' }, CTX);

      expect(sprintRepo.update).toHaveBeenCalledWith(
        'sprint-1',
        expect.objectContaining({ status: 'ACTIVE', startDate: expect.any(Date) }),
      );
      // endDate must never be filled on start
      expect(sprintRepo.update).toHaveBeenCalledWith(
        'sprint-1',
        expect.not.objectContaining({ endDate: expect.anything() }),
      );
    });

    it('keeps existing startDate when transitioning to ACTIVE', async () => {
      const existingStart = '2025-06-01T00:00:00.000Z';

      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint({ status: 'FUTURE', startDate: existingStart }));
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ status: 'ACTIVE' }));

      await service.updateSprint('sprint-1', { status: 'ACTIVE' }, CTX);

      // Existing startDate is preserved by not being included in the update payload
      expect(sprintRepo.update).toHaveBeenCalledWith('sprint-1', { status: 'ACTIVE' });
    });

    it('sets endDate when completing sprint with null endDate', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint({ status: 'ACTIVE', endDate: null }));
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ status: 'COMPLETED' }));

      await service.updateSprint('sprint-1', { status: 'COMPLETED' }, CTX);

      expect(sprintRepo.update).toHaveBeenCalledWith(
        'sprint-1',
        expect.objectContaining({ status: 'COMPLETED', endDate: expect.any(Date) }),
      );
    });
  });

  describe('deleteSprint', () => {
    it('clears sprint from tasks and deletes sprint', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.delete = vi.fn().mockResolvedValue(true);

      await service.deleteSprint('sprint-1', CTX);

      expect(taskRepo.clearSprintFromTasks).toHaveBeenCalledWith('project-1', 'sprint-1');
      expect(sprintRepo.delete).toHaveBeenCalledWith('sprint-1');
    });

    it('throws when sprint not found', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.deleteSprint('missing', CTX)).rejects.toThrow('Sprint not found');
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
      service = new SprintService(sprintRepo, projectRepo, taskRepo, undefined, projectMemberRepo);
    });

    it('createSprint rejects a foreign tenant with 404 and creates nothing', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      sprintRepo.create = vi.fn().mockResolvedValue(makeSprint());

      await expect(service.createSprint('project-1', { name: 'Hijacked' }, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(sprintRepo.create).not.toHaveBeenCalled();
    });

    it('getSprintsByProject rejects a foreign tenant with 404 and lists nothing', async () => {
      sprintRepo.findByProject = vi.fn().mockResolvedValue([makeSprint()]);

      await expect(service.getSprintsByProject('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(sprintRepo.findByProject).not.toHaveBeenCalled();
    });

    it('getSprint on a foreign-tenant sprint is 404', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1' });

      await expect(service.getSprint('sprint-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('updateSprint on a foreign-tenant sprint is 404 and never renames it', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.update = vi.fn().mockResolvedValue(makeSprint({ name: 'HIJACKED' }));

      await expect(service.updateSprint('sprint-1', { name: 'HIJACKED' }, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(sprintRepo.update).not.toHaveBeenCalled();
    });

    it('deleteSprint on a foreign-tenant sprint is 404 and never deletes it', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());

      await expect(service.deleteSprint('sprint-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.clearSprintFromTasks).not.toHaveBeenCalled();
      expect(sprintRepo.delete).not.toHaveBeenCalled();
    });

    it('a 404 for a foreign project is indistinguishable from a nonexistent one', async () => {
      const missingProjectRepo = { findById: vi.fn().mockResolvedValue(null) } as unknown as ProjectRepository;
      const absent = new SprintService(sprintRepo, missingProjectRepo, taskRepo, undefined, projectMemberRepo);
      const messageOf = async (s: SprintService) =>
        s
          .getSprint('sprint-1', foreignCtx)
          .then(() => null)
          .catch((e: Error) => e.message);

      expect(await messageOf(service)).toBe(await messageOf(absent));
    });

    it('throws Unauthorized (401) instead of silently skipping the check when the context is empty', async () => {
      sprintRepo.findById = vi.fn().mockResolvedValue(makeSprint());
      sprintRepo.delete = vi.fn().mockResolvedValue(true);

      await expect(service.deleteSprint('sprint-1', emptyCtx)).rejects.toThrow(UnauthorizedError);
      await expect(service.getSprintsByProject('project-1', emptyCtx)).rejects.toThrow(UnauthorizedError);
      expect(sprintRepo.delete).not.toHaveBeenCalled();
    });

    it('throws Forbidden (403) for a VIEWER inside the owning tenant', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.createSprint('project-1', { name: 'Sprint X' }, CTX)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(sprintRepo.create).not.toHaveBeenCalled();
    });

    it('happy path: a project admin of the owning tenant still succeeds', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' });
      projectMemberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });
      sprintRepo.create = vi.fn().mockResolvedValue(makeSprint());

      const result = await service.createSprint('project-1', { name: 'Sprint 1' }, CTX);

      expect(result.id).toBe('sprint-1');
    });
  });
});
