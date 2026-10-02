import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskService, BOARD_COLUMN_CONCURRENCY } from './task.service.js';
import type {
  TaskServiceUserRepo,
  TaskServiceSprintRepo,
  TaskServiceCommentRepo,
  TaskServiceRelationshipRepo,
  TaskServiceBoardRepo,
  TaskServiceTenantMemberRepo,
  TaskServiceLabelRepo,
} from './task.service.js';
import { decodeBoardCursor } from '@task-board/shared';
import type { BoardConfig } from '@task-board/shared';
import { NotFoundError, UnauthorizedError, ValidationError } from '../errors/app-error.js';
import { TaskRepository } from '../repositories/task.repository.js';
import { CounterService } from './counter.service.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { ProjectMemberRepository } from '../repositories/project-member.repository.js';
import { StatusRepository } from '../repositories/status.repository.js';
import { TaskTypeRepository } from '../repositories/task-type.repository.js';
import type { AuditService } from './audit.service.js';
import type { CreateTask, Task } from '@task-board/shared';

function createMock<T>(methods: Record<string, unknown>): T {
  return methods as unknown as T;
}

/**
 * The entities that belong to project-1, as MUTABLE per-test fixtures.
 *
 * The reference repositories answer per id from these sets rather than with a
 * fixed `mockResolvedValue`, so "this status is this project's" and "this status
 * is another project's" are two different facts a test states instead of one
 * shape that satisfies every id. Reset in `beforeEach`.
 */
const projectStatuses = new Map<string, string>();
const projectSprints = new Map<string, string>();
const projectTaskTypes = new Set<string>();
const projectMembers = new Set<string>();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    number: 1,
    typeId: 'type-1',
    title: 'Test Task',
    description: null,
    statusId: 'status-1',
    priorityLevel: 1,
    reporterId: 'user-1',
    reporterSnapshot: { displayName: 'Reporter' },
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'user-1',
    createdBySnapshot: { displayName: 'Creator' },
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskService', () => {
  let taskRepo: TaskRepository;
  let counterService: CounterService;
  let projectRepo: ProjectRepository;
  let projectMemberRepo: ProjectMemberRepository;
  let statusRepo: StatusRepository;
  let taskTypeRepo: TaskTypeRepository;
  let userRepo: TaskServiceUserRepo;
  let sprintRepo: TaskServiceSprintRepo;
  let commentRepo: TaskServiceCommentRepo;
  let relationshipRepo: TaskServiceRelationshipRepo;
  let auditService: AuditService;
  let tenantMemberRepo: TaskServiceTenantMemberRepo;
  let labelRepo: TaskServiceLabelRepo;
  let service: TaskService;

  beforeEach(() => {
    // The entities that DO belong to project-1. Every reference check resolves
    // against these, so "valid" and "foreign" are two facts about the fixture
    // rather than two different mock shapes — and a test cannot accidentally
    // pass because a repository double ignored the id it was handed.
    projectStatuses.clear();
    projectStatuses.set('status-1', 'Todo');
    projectStatuses.set('status-2', 'Todo');
    projectSprints.clear();
    projectSprints.set('sprint-1', 'Sprint 1');
    projectTaskTypes.clear();
    projectTaskTypes.add('type-1');
    projectMembers.clear();
    projectMembers.add('user-1');

    taskRepo = createMock<TaskRepository>({
      findById: vi.fn(),
      findByProject: vi.fn(),
      create: vi.fn(),
      updateWithVersion: vi.fn(),
      bulkUpdateWithVersion: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      countByStatus: vi.fn(),
      updateManyByStatus: vi.fn(),
      search: vi.fn(),
      removeLabelFromAll: vi.fn(),
    });

    counterService = createMock<CounterService>({
      getNextTaskNumber: vi.fn().mockResolvedValue(1),
    });

    projectRepo = createMock<ProjectRepository>({
      findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }),
    });

    projectMemberRepo = createMock<ProjectMemberRepository>({
      findByUserAndProject: vi.fn().mockResolvedValue({ role: 'EDITOR' }),
      // The identity seam resolves a user THROUGH their membership of the
      // project, so it answers per project: an id with a membership in
      // project-1 resolves, and anything else is `null` — which is exactly what
      // makes a cross-project assignee a 404 rather than a name disclosure.
      findUserIdentityByProject: vi.fn((userId: string, projectId: string) =>
        Promise.resolve(
          projectId === 'project-1' && projectMembers.has(userId)
            ? { userId, displayName: `${userId} in project-1` }
            : null,
        ),
      ),
    });

    statusRepo = createMock<StatusRepository>({
      findById: vi.fn().mockResolvedValue({ id: 'status-1', projectId: 'project-1', name: 'Todo' }),
      // Id-AWARE: each id resolves to its own row, and only for the project it
      // belongs to. A blanket `mockResolvedValue` would let a test assert a
      // name for an id that owns none — which is the defect under test, and it
      // would keep passing for the wrong reason.
      findByIds: vi.fn((ids: string[]) =>
        Promise.resolve(
          ids
            .filter((id) => projectStatuses.has(id))
            .map((id) => ({ id, projectId: 'project-1', name: projectStatuses.get(id) as string })),
        ),
      ),
    });

    taskTypeRepo = createMock<TaskTypeRepository>({
      findById: vi.fn().mockResolvedValue({ id: 'type-1', projectId: 'project-1' }),
      findByIds: vi.fn((ids: string[]) =>
        Promise.resolve(ids.filter((id) => projectTaskTypes.has(id)).map((id) => ({ id, projectId: 'project-1' }))),
      ),
    });

    userRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Test User', email: 'test@test.com' }),
    };

    sprintRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'sprint-1', projectId: 'project-1', name: 'Sprint 1' }),
      findByIds: vi.fn((ids: string[]) =>
        Promise.resolve(
          ids
            .filter((id) => projectSprints.has(id))
            .map((id) => ({ id, projectId: 'project-1', name: projectSprints.get(id) as string })),
        ),
      ),
    };

    commentRepo = {
      deleteByTask: vi.fn().mockResolvedValue(undefined),
    };

    relationshipRepo = {
      deleteByTask: vi.fn().mockResolvedValue(undefined),
    };

    auditService = createMock<AuditService>({
      log: vi.fn().mockResolvedValue({}),
      // TOP-3 №2: batched audit writes
      logMany: vi.fn().mockResolvedValue(undefined),
      queryByProject: vi.fn(),
      queryByTenant: vi.fn(),
    });

    // The default world is "one ACTIVE, never-expiring membership in
    // tenant-1", and project-1 belongs to tenant-1 — so a test that never
    // touches this seam behaves exactly as it did before. The cases that matter
    // override these two mocks.
    tenantMemberRepo = createMock<TaskServiceTenantMemberRepo>({
      findByUser: vi.fn().mockResolvedValue([{ tenantId: 'tenant-1', status: 'ACTIVE', expiresAt: null }]),
    });

    labelRepo = createMock<TaskServiceLabelRepo>({
      findByProject: vi.fn().mockResolvedValue([{ id: 'label-1' }]),
    });

    service = new TaskService(
      taskRepo,
      counterService,
      projectRepo,
      projectMemberRepo,
      statusRepo,
      taskTypeRepo,
      userRepo,
      sprintRepo,
      commentRepo,
      relationshipRepo,
      auditService,
      undefined,
      tenantMemberRepo,
      labelRepo,
    );
  });

  /**
   * The caller context every project-scoped method now
   * REQUIRES. `ctx` is the caller's own tenant; `foreignCtx` points at a
   * DIFFERENT tenant and must yield 404 (never 403) on every read path.
   */
  const ctx = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };
  const foreignCtx = { tenantId: 'tenant-OTHER', userId: 'user-1', userRole: 'MEMBER' };

  describe('getTasksByProject', () => {
    it('returns paginated tasks', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [makeTask()],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

      const result = await service.getTasksByProject('project-1', {}, ctx);

      expect(result.data).toHaveLength(1);
    });

    it('throws NOT_FOUND for a project of another tenant', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [makeTask()],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

      await expect(service.getTasksByProject('project-1', {}, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.findByProject).not.toHaveBeenCalled();
    });

    /**
     * The service must forward the sprint filter UNCHANGED — the semantics
     * live in the schema + repository, so any rewriting here would silently
     * break the contract the Sprints page relies on.
     */
    it('F7: forwards hasSprint unchanged to the repository', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 1, total: 0, totalPages: 0 },
      });

      await service.getTasksByProject('project-1', { hasSprint: false, limit: 1 }, ctx);

      expect(taskRepo.findByProject).toHaveBeenCalledWith('project-1', { hasSprint: false, limit: 1 });
    });

    it('F7: forwards a sprint uuid unchanged to the repository', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });

      await service.getTasksByProject('project-1', { sprintId: 'sprint-1' }, ctx);

      expect(taskRepo.findByProject).toHaveBeenCalledWith('project-1', { sprintId: 'sprint-1' });
    });

    it('F7: the board projection path forwards hasSprint too', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [makeTask()],
        pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
      });

      await service.getBoardTasks('project-1', { hasSprint: false }, ctx);

      expect(taskRepo.findByProject).toHaveBeenCalledWith('project-1', { hasSprint: false, view: 'board' });
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      await expect(service.getTasksByProject('project-1', {}, undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getStatusSummary', () => {
    it('returns the per-status counts for a project in the caller tenant', async () => {
      taskRepo.countByStatusGrouped = vi.fn().mockResolvedValue([{ statusId: 'status-1', count: 3 }]);

      const result = await service.getStatusSummary('project-1', ctx);

      expect(result).toEqual([{ statusId: 'status-1', count: 3 }]);
    });

    it('throws NOT_FOUND for a project of another tenant', async () => {
      taskRepo.countByStatusGrouped = vi.fn();

      await expect(service.getStatusSummary('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.countByStatusGrouped).not.toHaveBeenCalled();
    });
  });

  describe('getBoardTasks', () => {
    it('maps the projected result to the exact BoardTask DTO — no description/reporter/timestamp leakage', async () => {
      taskRepo.findByProject = vi.fn().mockResolvedValue({
        data: [makeTask()],
        pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
      });

      const result = await service.getBoardTasks('project-1', {}, ctx);
      const [boardTask] = result.data;

      expect(taskRepo.findByProject).toHaveBeenCalledWith('project-1', { view: 'board' });
      expect(boardTask).toEqual({
        id: expect.any(String),
        number: expect.any(Number),
        title: expect.any(String),
        typeId: expect.any(String),
        statusId: expect.any(String),
        priorityLevel: expect.any(Number),
        assigneeId: null,
        assigneeSnapshot: null,
        version: 1,
      });
      // Explicit no-leakage proof: the serialized DTO carries exactly the card fields
      expect(Object.keys(boardTask ?? {}).sort()).toEqual([
        'assigneeId',
        'assigneeSnapshot',
        'id',
        'number',
        'priorityLevel',
        'statusId',
        'title',
        'typeId',
        'version',
      ]);
    });
  });

  describe('getTask', () => {
    it('returns task when found', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());

      const result = await service.getTask('task-1', ctx);

      expect(result.title).toBe('Test Task');
    });

    it('throws NOT_FOUND when not found', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.getTask('missing', ctx)).rejects.toThrow('Task not found');
    });

    it('throws NOT_FOUND (not 403) when the task belongs to another tenant (M-02)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.getTask('task-1', ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());

      await expect(service.getTask('task-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('resolveTaskId — the ONE resolution of the `:taskId` path parameter', () => {
    beforeEach(() => {
      projectRepo.findByTenantAndKey = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1' });
      taskRepo.findByProjectAndNumber = vi.fn().mockResolvedValue(makeTask({ id: 'task-42', number: 42 }));
    });

    it('passes a bare UUID through untouched, without a lookup', async () => {
      await expect(service.resolveTaskId('task-1', ctx)).resolves.toBe('task-1');
      expect(projectRepo.findByTenantAndKey).not.toHaveBeenCalled();
      expect(taskRepo.findByProjectAndNumber).not.toHaveBeenCalled();
    });

    it('resolves KEY-NUMBER to the task id WITHIN the caller tenant', async () => {
      await expect(service.resolveTaskId('PRO-42', ctx)).resolves.toBe('task-42');
      expect(projectRepo.findByTenantAndKey).toHaveBeenCalledWith('tenant-1', 'PRO');
      expect(taskRepo.findByProjectAndNumber).toHaveBeenCalledWith('project-1', 42);
    });

    /**
     * The key is only unique WITHIN a tenant, so a project key that belongs to
     * another tenant must resolve to nothing — otherwise a caller could act on a
     * foreign task by addressing it through its key while its id is refused.
     */
    it('404s a key whose project belongs to another tenant, and never reaches the task lookup', async () => {
      projectRepo.findByTenantAndKey = vi.fn().mockResolvedValue(null);

      await expect(service.resolveTaskId('OTHER-1', ctx)).rejects.toMatchObject({ statusCode: 404 });
      expect(taskRepo.findByProjectAndNumber).not.toHaveBeenCalled();
    });

    it('404s a key that resolves to no task number', async () => {
      taskRepo.findByProjectAndNumber = vi.fn().mockResolvedValue(null);

      await expect(service.resolveTaskId('PRO-999', ctx)).rejects.toThrow('Task not found');
    });

    it('fails closed (401) without a caller context — the key lookup must be tenant-scoped', async () => {
      await expect(service.resolveTaskId('PRO-42', undefined as never)).rejects.toMatchObject({ statusCode: 401 });
      expect(projectRepo.findByTenantAndKey).not.toHaveBeenCalled();
    });
  });

  describe('getTaskByKey (S-04)', () => {
    it('resolves the project within the caller tenant and returns the task', async () => {
      projectRepo.findByTenantAndKey = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1' });
      taskRepo.findByProjectAndNumber = vi.fn().mockResolvedValue(makeTask({ number: 7 }));

      const result = await service.getTaskByKey(ctx, 'PRO', 7);

      expect(projectRepo.findByTenantAndKey).toHaveBeenCalledWith('tenant-1', 'PRO');
      expect(result.number).toBe(7);
    });

    it('throws NOT_FOUND when the key belongs to a project of another tenant (S-04)', async () => {
      projectRepo.findByTenantAndKey = vi.fn().mockResolvedValue(null);
      taskRepo.findByProjectAndNumber = vi.fn();

      await expect(service.getTaskByKey(ctx, 'OTHER', 1)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.findByProjectAndNumber).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when no task matches the number', async () => {
      projectRepo.findByTenantAndKey = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1' });
      taskRepo.findByProjectAndNumber = vi.fn().mockResolvedValue(null);

      await expect(service.getTaskByKey(ctx, 'PRO', 999)).rejects.toThrow('Task not found');
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      await expect(service.getTaskByKey(undefined as never, 'PRO', 1)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  // The `getTaskByNumber` block moved with the method — it was dead code
  // (the canonical task route is `/tasks/:taskId`).

  describe('createTask', () => {
    it('creates a task with sequential number and snapshots', async () => {
      taskRepo.create = vi.fn().mockResolvedValue(makeTask());

      const result = await service.createTask(
        'project-1',
        {
          typeId: 'type-1',
          title: 'New Task',
          statusId: 'status-1',
          priorityLevel: 1,
        },
        { ...ctx, userRole: 'OWNER' },
      );

      expect(result.title).toBe('Test Task');
      expect(counterService.getNextTaskNumber).toHaveBeenCalledWith('project-1');
    });

    it('M-14: resolves refs with ONE batched findByIds per repo (no sequential findById)', async () => {
      taskRepo.create = vi.fn().mockResolvedValue(makeTask());

      await service.createTask(
        'project-1',
        {
          typeId: 'type-1',
          title: 'New Task',
          statusId: 'status-1',
          priorityLevel: 1,
          sprintId: 'sprint-1',
        },
        { ...ctx, userRole: 'OWNER' },
      );

      expect(taskTypeRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(taskTypeRepo.findByIds).toHaveBeenCalledWith(['type-1']);
      expect(statusRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(statusRepo.findByIds).toHaveBeenCalledWith(['status-1']);
      expect(sprintRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(sprintRepo.findByIds).toHaveBeenCalledWith(['sprint-1']);
      expect(taskTypeRepo.findById).not.toHaveBeenCalled();
      expect(statusRepo.findById).not.toHaveBeenCalled();
      expect(sprintRepo.findById).not.toHaveBeenCalled();
    });

    it('creates audit event on task creation', async () => {
      taskRepo.create = vi.fn().mockResolvedValue(makeTask());

      await service.createTask(
        'project-1',
        {
          typeId: 'type-1',
          title: 'New Task',
          statusId: 'status-1',
          priorityLevel: 1,
        },
        { ...ctx, userRole: 'OWNER' },
      );

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          entityType: 'TASK',
          entityId: 'task-1',
          action: 'CREATED',
          actorId: 'user-1',
        }),
      );
    });

    it('throws NOT_FOUND for a project of another tenant', async () => {
      taskRepo.create = vi.fn();

      await expect(
        service.createTask(
          'project-1',
          { typeId: 'type-1', title: 'New Task', statusId: 'status-1', priorityLevel: 1 },
          { ...ctx, userRole: 'OWNER', tenantId: 'tenant-OTHER' },
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(taskRepo.create).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      taskRepo.create = vi.fn();

      await expect(
        service.createTask(
          'project-1',
          { typeId: 'type-1', title: 'New Task', statusId: 'status-1', priorityLevel: 1 },
          undefined as never,
        ),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(taskRepo.create).not.toHaveBeenCalled();
    });

    it('denies a VIEWOR (project VIEWER cannot create a task)', async () => {
      taskRepo.create = vi.fn();
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(
        service.createTask(
          'project-1',
          { typeId: 'type-1', title: 'New Task', statusId: 'status-1', priorityLevel: 1 },
          ctx,
        ),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      expect(taskRepo.create).not.toHaveBeenCalled();
    });
  });

  /**
   * The bounded retry of the `tasks {projectId, number}` uniqueness race.
   *
   * The number normally comes from an atomic counter, so a collision is the
   * exceptional case (counter behind the stored maximum). What these specs pin is
   * the RECOVERY contract: re-allocate and try again, up to a fixed bound, and
   * never let the driver error — or any other unique index — escape.
   */
  describe('createTask: task-numbering race (F24)', () => {
    /** The exact `E11000` the unique `tasks {projectId, number}` index raises. */
    function numberCollision() {
      return Object.assign(new Error('E11000 duplicate key error collection: tasks index: projectId_1_number_-1'), {
        code: 11000,
        codeName: 'DuplicateKey',
        keyPattern: { projectId: 1, number: -1 },
      });
    }

    /** A DIFFERENT unique index on the same insert — must never be retried. */
    function otherUniqueViolation() {
      return Object.assign(new Error('E11000 duplicate key error collection: tasks index: id_1'), {
        code: 11000,
        codeName: 'DuplicateKey',
        keyPattern: { id: 1 },
      });
    }

    // Typed as `CreateTask` so `priorityLevel` keeps its `0 | 1 | 2 | 3` union
    // instead of widening to `number` on a shared const.
    const BODY: CreateTask = { typeId: 'type-1', title: 'New Task', statusId: 'status-1', priorityLevel: 1 };

    it('a collision on the first attempt re-allocates a number and succeeds', async () => {
      const create = vi
        .fn()
        .mockRejectedValueOnce(numberCollision())
        .mockResolvedValueOnce(makeTask({ number: 2 }));

      taskRepo.create = create;
      counterService.getNextTaskNumber = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const result = await service.createTask('project-1', BODY, { ...ctx, userRole: 'OWNER' });

      expect(result.number).toBe(2);
      expect(create).toHaveBeenCalledTimes(2);
      // The retry must insert a DIFFERENT number — reusing the conflicting one
      // would collide again by construction.
      expect(create.mock.calls[0]?.[0]).toMatchObject({ number: 1 });
      expect(create.mock.calls[1]?.[0]).toMatchObject({ number: 2 });
      expect(counterService.getNextTaskNumber).toHaveBeenCalledTimes(2);
    });

    it('stops at the bound and reports a retryable 503 instead of the driver error', async () => {
      const create = vi.fn().mockRejectedValue(numberCollision());

      taskRepo.create = create;
      counterService.getNextTaskNumber = vi.fn().mockResolvedValue(1);

      const err = await service.createTask('project-1', BODY, { ...ctx, userRole: 'OWNER' }).catch((e: Error) => e);

      expect(err).toMatchObject({ statusCode: 503, code: 'TASK_NUMBER_UNAVAILABLE' });
      expect(create).toHaveBeenCalledTimes(3);
      expect(counterService.getNextTaskNumber).toHaveBeenCalledTimes(3);
      // Nothing about the index, the collection or E11000 may reach the client.
      expect((err as Error).message).not.toContain('E11000');
      expect((err as Error).message).not.toContain('tasks');
      expect((err as Error).message).not.toContain('index');
    });

    it('does NOT retry a different unique violation — it escapes on the first attempt', async () => {
      const raw = otherUniqueViolation();
      const create = vi.fn().mockRejectedValue(raw);

      taskRepo.create = create;

      await expect(service.createTask('project-1', BODY, { ...ctx, userRole: 'OWNER' })).rejects.toBe(raw);
      expect(create).toHaveBeenCalledTimes(1);
      expect(counterService.getNextTaskNumber).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry when the driver error carries no keyPattern (cannot prove which index fired)', async () => {
      const raw = Object.assign(new Error('E11000 duplicate key error collection: tasks'), {
        code: 11000,
        codeName: 'DuplicateKey',
      });
      const create = vi.fn().mockRejectedValue(raw);

      taskRepo.create = create;

      await expect(service.createTask('project-1', BODY, { ...ctx, userRole: 'OWNER' })).rejects.toBe(raw);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('writes exactly one audit event even when the insert was retried', async () => {
      taskRepo.create = vi.fn().mockRejectedValueOnce(numberCollision()).mockResolvedValueOnce(makeTask());
      counterService.getNextTaskNumber = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await service.createTask('project-1', BODY, { ...ctx, userRole: 'OWNER' });

      expect(auditService.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateTask', () => {
    it('updates task with matching version', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.updateWithVersion = vi.fn().mockResolvedValue(makeTask({ title: 'Updated', version: 2 }));

      const result = await service.updateTask('task-1', { title: 'Updated', version: 1 }, ctx);

      expect(result.title).toBe('Updated');
    });

    it('throws TASK_VERSION_CONFLICT on version mismatch', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());

      await expect(service.updateTask('task-1', { title: 'X', version: 999 }, ctx)).rejects.toThrow('concurrently');
    });

    it('creates audit event on task update with changes', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.updateWithVersion = vi.fn().mockResolvedValue(makeTask({ title: 'Updated', version: 2 }));

      await service.updateTask('task-1', { title: 'Updated', version: 1 }, ctx);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'TASK',
          action: 'UPDATED',
          actorId: 'user-1',
          changes: expect.arrayContaining([
            expect.objectContaining({ field: 'title', oldValue: 'Test Task', newValue: 'Updated' }),
          ]),
        }),
      );
    });
  });

  /**
   * Every reference a task write carries must resolve inside the caller's own
   * project, on the single-update path AND on the bulk path.
   *
   * These used to be written unchecked: a PATCH could set `statusId`,
   * `typeId`, `sprintId` or `assigneeId` to an entity of another project (or
   * another tenant) and got a 200 back, because the denormalized name was read
   * through a repository `findById` that never compared projects. The write
   * landed AND the response and audit record carried the foreign entity's
   * display name — a cross-tenant read delivered through a 200.
   *
   * The contract pinned here: a foreign reference is a 404, never a 403, so it
   * is indistinguishable from an id that does not exist at all; nothing is
   * written; and no foreign name reaches the result or the audit trail.
   */
  describe('cross-project references are rejected on every task write', () => {
    beforeEach(() => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask({ version: 1 }));
      taskRepo.updateWithVersion = vi.fn().mockResolvedValue(makeTask({ version: 2 }));
      taskRepo.findByIds = vi.fn().mockResolvedValue([makeTask({ id: 't1', version: 1 })]);
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([]);
    });

    /** No foreign name may appear anywhere in the audit call, serialized. */
    function auditText(): string {
      return JSON.stringify([
        ...(auditService.log as ReturnType<typeof vi.fn>).mock.calls,
        ...(auditService.logMany as ReturnType<typeof vi.fn>).mock.calls,
      ]);
    }

    describe('updateTask', () => {
      it('rejects a statusId belonging to ANOTHER project with 404 and writes nothing', async () => {
        // The status EXISTS — in project-2. The response must not reveal that,
        // and must not name it.
        await expect(
          service.updateTask('task-1', { statusId: 'status-foreign', version: 1 }, ctx),
        ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
        expect(auditText()).not.toContain('Foreign');
      });

      it('rejects a sprintId belonging to ANOTHER project with 404 and writes nothing', async () => {
        await expect(
          service.updateTask('task-1', { sprintId: 'sprint-foreign', version: 1 }, ctx),
        ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
      });

      it('rejects a typeId belonging to ANOTHER project with 404 and writes nothing', async () => {
        await expect(service.updateTask('task-1', { typeId: 'type-foreign', version: 1 }, ctx)).rejects.toMatchObject({
          statusCode: 404,
          code: 'NOT_FOUND',
        });
        expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
      });

      it('rejects an assigneeId that is not a member of this project with 404 and names nobody', async () => {
        // The strongest case: the foreign user is a real member of ANOTHER
        // tenant, and the global user lookup would happily return their name.
        // The identity seam must be consulted instead, so no name is read at
        // all — `userRepo.findById` (the caller's own snapshot) is not the seam
        // for an assignee and must not be used as one.
        const err = await service
          .updateTask('task-1', { assigneeId: 'user-foreign', version: 1 }, ctx)
          .then(() => null)
          .catch((e: Error) => e);

        expect(err).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect((err as Error).message).not.toContain('Foreign');
        expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
        expect(userRepo.findById).not.toHaveBeenCalledWith('user-foreign');
      });

      it('still accepts references of its own project and denormalizes the right names', async () => {
        projectStatuses.set('status-ok', 'In Progress');
        projectSprints.set('sprint-ok', 'Sprint 7');
        projectMembers.add('user-ok');

        await service.updateTask(
          'task-1',
          { statusId: 'status-ok', sprintId: 'sprint-ok', assigneeId: 'user-ok', typeId: 'type-1', version: 1 },
          ctx,
        );

        expect(taskRepo.updateWithVersion).toHaveBeenCalledWith(
          'task-1',
          1,
          expect.objectContaining({
            statusId: 'status-ok',
            // The names come from the SAME lookups that proved ownership, so
            // they cannot be a foreign entity's.
            statusName: 'In Progress',
            sprintName: 'Sprint 7',
            assigneeId: 'user-ok',
            assigneeSnapshot: { displayName: 'user-ok in project-1' },
          }),
        );
      });

      it('treats assigneeId: null as UNASSIGN — cleared, not a missing reference', async () => {
        // `null` is how the schema says "unassign". It must not be run through
        // the ownership check as if it named somebody, and it must clear the
        // snapshot rather than leave a stale display name on the task.
        await service.updateTask('task-1', { assigneeId: null, version: 1 }, ctx);

        expect(taskRepo.updateWithVersion).toHaveBeenCalledWith(
          'task-1',
          1,
          expect.objectContaining({ assigneeId: null, assigneeSnapshot: null }),
        );
      });

      it('treats sprintId: null as "move to backlog" and nulls the denormalized name', async () => {
        await service.updateTask('task-1', { sprintId: null, version: 1 }, ctx);

        expect(taskRepo.updateWithVersion).toHaveBeenCalledWith(
          'task-1',
          1,
          expect.objectContaining({ sprintId: null, sprintName: null }),
        );
      });

      it('rejects the foreign reference BEFORE writing any other changed field', async () => {
        await expect(
          service.updateTask('task-1', { title: 'legit', statusId: 'status-foreign', version: 1 }, ctx),
        ).rejects.toMatchObject({ statusCode: 404 });
        // A partial write would leave the task updated but the request failed.
        expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it('leaves the denormalized name ALONE when the status is not being changed', async () => {
        await service.updateTask('task-1', { title: 'Just a title', version: 1 }, ctx);

        expect(taskRepo.updateWithVersion).toHaveBeenCalledWith(
          'task-1',
          1,
          expect.not.objectContaining({ statusName: expect.anything() }),
        );
      });
    });

    describe('bulkUpdateTasks', () => {
      it('rejects a foreign statusId with 404 and bulk-writes NOTHING', async () => {
        await expect(
          service.bulkUpdateTasks('project-1', ['t1'], { statusId: 'status-foreign' }, ctx),
        ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
        expect(auditService.logMany).not.toHaveBeenCalled();
      });

      it('rejects a foreign sprintId with 404 and bulk-writes NOTHING', async () => {
        await expect(
          service.bulkUpdateTasks('project-1', ['t1'], { sprintId: 'sprint-foreign' }, ctx),
        ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
      });

      it('rejects a foreign assigneeId with 404, names nobody and bulk-writes NOTHING', async () => {
        const err = await service
          .bulkUpdateTasks('project-1', ['t1'], { assigneeId: 'user-foreign' }, ctx)
          .then(() => null)
          .catch((e: Error) => e);

        expect(err).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect((err as Error).message).not.toContain('Foreign');
        expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
        expect(auditText()).not.toContain('Foreign');
      });

      it('rejects the WHOLE request, not just the offending task — no partial bulk write', async () => {
        // `t1` is a perfectly valid task of project-1. A per-id skip would let
        // it be updated while the caller is told the request failed, which is
        // how a rejected request still mutates data.
        taskRepo.findByIds = vi
          .fn()
          .mockResolvedValue([makeTask({ id: 't1', version: 1 }), makeTask({ id: 't2', version: 1 })]);

        await expect(
          service.bulkUpdateTasks('project-1', ['t1', 't2'], { statusId: 'status-foreign' }, ctx),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
        expect(auditService.logMany).not.toHaveBeenCalled();
      });

      it('still denormalizes the correct name for a status of its own project', async () => {
        projectStatuses.set('status-ok', 'Done');

        await service.bulkUpdateTasks('project-1', ['t1'], { statusId: 'status-ok' }, ctx);

        expect(taskRepo.bulkUpdateWithVersion).toHaveBeenCalledWith([{ id: 't1', version: 1 }], {
          statusId: 'status-ok',
          statusName: 'Done',
        });
      });

      it('still unassigns in bulk when assigneeId is null', async () => {
        await service.bulkUpdateTasks('project-1', ['t1'], { assigneeId: null }, ctx);

        expect(taskRepo.bulkUpdateWithVersion).toHaveBeenCalledWith([{ id: 't1', version: 1 }], {
          assigneeId: null,
          assigneeSnapshot: null,
        });
      });
    });

    describe('no cross-tenant displayName reaches the audit trail', () => {
      it('the VALID path audits ids only — never a name from an unscoped lookup', async () => {
        projectStatuses.set('status-ok', 'In Progress');

        await service.updateTask('task-1', { statusId: 'status-ok', version: 1 }, ctx);

        const text = auditText();

        // The audit change records the id, which the caller supplied; it must
        // not carry a display name resolved outside the caller's project.
        expect(text).toContain('status-ok');
        expect(text).not.toContain('In Progress');
      });

      it('the audit trail of a REJECTED write is empty — a refused change leaves no trace of a foreign id', async () => {
        await service
          .updateTask('task-1', { assigneeId: 'user-foreign', sprintId: 'sprint-foreign', version: 1 }, ctx)
          .catch(() => undefined);

        expect(auditService.log).not.toHaveBeenCalled();
        expect(auditText()).not.toContain('user-foreign');
        expect(auditText()).not.toContain('sprint-foreign');
      });
    });
  });

  describe('deleteTask', () => {
    // `delete_task` is PROJECT_ADMIN-only, so the shared MEMBER context is not
    // sufficient here — a tenant OWNER is used to keep the assertions focused
    // on the cascade/audit behaviour rather than on the role gate.
    const adminCtx = { ...ctx, userRole: 'OWNER' };

    it('cascades delete (comments, relationships, then task)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.delete = vi.fn().mockResolvedValue(true);

      await service.deleteTask('task-1', adminCtx);

      expect(commentRepo.deleteByTask).toHaveBeenCalledWith('task-1');
      expect(relationshipRepo.deleteByTask).toHaveBeenCalledWith('task-1');
      expect(taskRepo.delete).toHaveBeenCalledWith('task-1');
    });

    it('creates audit event before task deletion', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.delete = vi.fn().mockResolvedValue(true);

      await service.deleteTask('task-1', adminCtx);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'TASK',
          action: 'DELETED',
          actorId: 'user-1',
        }),
      );

      // Audit should be called before delete
      const auditCallOrder = (auditService.log as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const deleteCallOrder = (taskRepo.delete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.NaN;

      expect(auditCallOrder).toBeLessThan(deleteCallOrder);
    });
  });

  // ── V2-4: project RBAC enforcement on id-based mutations ─────────────────

  describe('project RBAC enforcement (V2-4)', () => {
    it('denies updateTask for a project VIEWER even with a valid version', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(service.updateTask('task-1', { version: 1, title: 'hacked' }, ctx)).rejects.toThrow('edit_task');
      expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('allows updateTask for a project EDITOR', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.updateWithVersion = vi.fn().mockResolvedValue(makeTask({ title: 'Updated' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      const result = await service.updateTask('task-1', { version: 1, title: 'Updated' }, ctx);

      expect(result.title).toBe('Updated');
    });

    it('bypasses the project role for a tenant OWNER (no membership needed)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.updateWithVersion = vi.fn().mockResolvedValue(makeTask({ title: 'Admin edit' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue(null);

      const result = await service.updateTask(
        'task-1',
        { version: 1, title: 'Admin edit' },
        { ...ctx, userRole: 'OWNER' },
      );

      expect(result.title).toBe('Admin edit');
    });

    it('denies deleteTask for a project EDITOR', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      await expect(service.deleteTask('task-1', ctx)).rejects.toThrow('delete_task');
      expect(taskRepo.delete).not.toHaveBeenCalled();
    });

    it('allows deleteTask for a project PROJECT_ADMIN', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      taskRepo.delete = vi.fn().mockResolvedValue(true);
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' });

      await service.deleteTask('task-1', ctx);

      expect(taskRepo.delete).toHaveBeenCalledWith('task-1');
    });
  });

  /**
   * The tenant assertion that the fail-open guards used to
   * skip. The production incident was a cross-tenant DELETE/PATCH of a task
   * addressed by its bare id; the checks below pin 404 + "no write happened".
   */
  describe('cross-tenant guardrails on the id-based write paths', () => {
    it('deleteTask: a task of another tenant yields 404 and deletes nothing', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.deleteTask('task-1', ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.delete).not.toHaveBeenCalled();
      expect(commentRepo.deleteByTask).not.toHaveBeenCalled();
      expect(relationshipRepo.deleteByTask).not.toHaveBeenCalled();
    });

    it('updateTask: a task of another tenant yields 404 and writes nothing', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.updateTask('task-1', { title: 'hacked', version: 1 }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('updateTask: a missing caller context yields 401 and writes nothing (fail closed)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());

      await expect(
        service.updateTask('task-1', { title: 'hacked', version: 1 }, undefined as never),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('deleteTask: a missing caller context yields 401 and deletes nothing (fail closed)', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());

      await expect(service.deleteTask('task-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(taskRepo.delete).not.toHaveBeenCalled();
    });

    it('deleteTask: a project EDITOR is denied (delete_task is PROJECT_ADMIN only) and deletes nothing', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask());
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      await expect(service.deleteTask('task-1', ctx)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(taskRepo.delete).not.toHaveBeenCalled();
      expect(commentRepo.deleteByTask).not.toHaveBeenCalled();
    });

    it('bulkUpdateTasks: a project of another tenant yields 404 and bulk-writes nothing', async () => {
      taskRepo.findByIds = vi.fn().mockResolvedValue([makeTask()]);

      await expect(
        service.bulkUpdateTasks('project-1', ['task-1'], { statusId: 'status-2' }, foreignCtx),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
    });

    it('bulkUpdateTasks: a missing caller context yields 401 and bulk-writes nothing (fail closed)', async () => {
      taskRepo.findByIds = vi.fn().mockResolvedValue([makeTask()]);

      await expect(
        service.bulkUpdateTasks('project-1', ['task-1'], { statusId: 'status-2' }, undefined as never),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
    });

    it('bulkUpdateTasks: a project VIEWER is denied (403) and bulk-writes nothing', async () => {
      taskRepo.findByIds = vi.fn().mockResolvedValue([makeTask()]);
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(
        service.bulkUpdateTasks('project-1', ['task-1'], { statusId: 'status-2' }, ctx),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      expect(taskRepo.bulkUpdateWithVersion).not.toHaveBeenCalled();
    });
  });

  // ─── TOP-3 №1: bulkUpdateTasks via ONE bulkWrite ──────────────────────────

  describe('bulkUpdateTasks (TOP-3 №1: single bulkWrite)', () => {
    function makeAssignedTask(id: string, version: number) {
      return makeTask({ id, version, statusId: 'status-old' });
    }

    it('updates several tasks via one bulkWrite and reports per-task success', async () => {
      const t1 = makeAssignedTask('t1', 1);
      const t2 = makeAssignedTask('t2', 3);

      taskRepo.findByIds = vi.fn().mockResolvedValue([t1, t2]);
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([
        { ...t1, version: 2, statusId: 'status-2', statusName: 'Done' },
        { ...t2, version: 4, statusId: 'status-2', statusName: 'Done' },
      ]);

      const result = await service.bulkUpdateTasks('project-1', ['t1', 't2'], { statusId: 'status-2' }, ctx);

      expect(result.updated).toBe(2);
      expect(result.failed).toBeUndefined();
      // TOP-2 semantics preserved: the denormalized name travels with the change
      expect(taskRepo.bulkUpdateWithVersion).toHaveBeenCalledWith(
        [
          { id: 't1', version: 1 },
          { id: 't2', version: 3 },
        ],
        { statusId: 'status-2', statusName: 'Todo' },
      );
    });

    it('reports VERSION_CONFLICT per task when the version did not match', async () => {
      const t1 = makeAssignedTask('t1', 1);
      const t2 = makeAssignedTask('t2', 5);

      taskRepo.findByIds = vi.fn().mockResolvedValue([t1, t2]);
      // bulkWrite applies only matching versions → t2 is absent from the result
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([{ ...t1, version: 2, statusId: 'status-2' }]);

      const result = await service.bulkUpdateTasks('project-1', ['t1', 't2'], { statusId: 'status-2' }, ctx);

      expect(result.updated).toBe(1);
      expect(result.failed).toEqual([{ taskId: 't2', reason: 'VERSION_CONFLICT' }]);
    });

    it('keeps TASK_NOT_FOUND and TASK_NOT_IN_PROJECT per-id failures', async () => {
      // belongs to another project → must be rejected as TASK_NOT_IN_PROJECT
      const foreign = { ...makeAssignedTask('t-foreign', 1), projectId: 'project-other' };

      taskRepo.findByIds = vi.fn().mockResolvedValue([foreign, makeAssignedTask('t1', 1)]);
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([{ ...makeAssignedTask('t1', 1), version: 2 }]);

      const result = await service.bulkUpdateTasks(
        'project-1',
        ['t-missing', 't-foreign', 't1'],
        { statusId: 'status-2' },
        ctx,
      );

      expect(result.updated).toBe(1);
      expect(result.failed).toEqual([
        { taskId: 't-missing', reason: 'TASK_NOT_FOUND' },
        { taskId: 't-foreign', reason: 'TASK_NOT_IN_PROJECT' },
      ]);
    });

    it('keeps the sprint denormalized name in the payload and nulls it when clearing', async () => {
      const t1 = makeAssignedTask('t1', 1);

      taskRepo.findByIds = vi.fn().mockResolvedValue([t1]);
      taskRepo.bulkUpdateWithVersion = vi
        .fn()
        .mockResolvedValue([{ ...t1, version: 2, sprintId: 'sprint-1', sprintName: 'Sprint 1' }]);

      await service.bulkUpdateTasks('project-1', ['t1'], { sprintId: 'sprint-1' }, ctx);

      expect(taskRepo.bulkUpdateWithVersion).toHaveBeenCalledWith([{ id: 't1', version: 1 }], {
        sprintId: 'sprint-1',
        sprintName: 'Sprint 1',
      });

      await service.bulkUpdateTasks('project-1', ['t1'], { sprintId: null }, ctx);

      expect(taskRepo.bulkUpdateWithVersion).toHaveBeenLastCalledWith([{ id: 't1', version: 1 }], {
        sprintId: null,
        sprintName: null,
      });
    });

    it('TOP-3 №2: persists audit events as ONE batch (logMany), not per-task log()', async () => {
      const t1 = makeAssignedTask('t1', 1);
      const t2 = makeAssignedTask('t2', 2);

      taskRepo.findByIds = vi.fn().mockResolvedValue([t1, t2]);
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([
        { ...t1, version: 2, statusId: 'status-2' },
        { ...t2, version: 3, statusId: 'status-2' },
      ]);

      await service.bulkUpdateTasks('project-1', ['t1', 't2'], { statusId: 'status-2' }, ctx);

      expect(auditService.log).not.toHaveBeenCalled();
      expect(auditService.logMany).toHaveBeenCalledTimes(1);
      expect(auditService.logMany).toHaveBeenCalledWith('user-1', [
        expect.objectContaining({
          projectId: 'project-1',
          entityType: 'TASK',
          entityId: 't1',
          action: 'UPDATED',
          changes: [{ field: 'statusId', oldValue: 'status-old', newValue: 'status-2' }],
        }),
        expect.objectContaining({
          entityId: 't2',
          changes: [{ field: 'statusId', oldValue: 'status-old', newValue: 'status-2' }],
        }),
      ]);
    });

    it('TOP-3 №2: creates no audit event for a task that was not updated (version conflict)', async () => {
      const t1 = makeAssignedTask('t1', 1);
      const t2 = makeAssignedTask('t2', 5);

      taskRepo.findByIds = vi.fn().mockResolvedValue([t1, t2]);
      // t2 conflicts — absent from the bulkWrite result
      taskRepo.bulkUpdateWithVersion = vi.fn().mockResolvedValue([{ ...t1, version: 2, statusId: 'status-2' }]);

      await service.bulkUpdateTasks('project-1', ['t1', 't2'], { statusId: 'status-2' }, ctx);

      const logManyMock = auditService.logMany as unknown as ReturnType<typeof vi.fn>;
      const events = (logManyMock.mock.calls.at(0)?.[1] ?? []) as {
        entityId: string;
      }[];

      expect(events).toHaveLength(1);
      expect(events[0]?.entityId).toBe('t1');
    });
  });

  describe('getBoardPages (one HTTP request, bounded-parallel column queries)', () => {
    const COL_A = '550e8400-e29b-41d4-a716-4466554400a1';
    const COL_B = '550e8400-e29b-41d4-a716-4466554400b2';

    /**
     * The board fan-out is BOUNDED, and this asserts the bound rather than the
     * intent.
     *
     * A board can hold `MAX_IDS_PER_DOCUMENT` (500) columns and an initial load
     * fetches EVERY one of them. Issued unbounded, one request asks the driver
     * for up to ~500 concurrent checkouts against a pool of `maxPoolSize: 5` —
     * which queues rather than fails, so nothing breaks, but the request becomes
     * a head-of-line blocker for everything else sharing the Worker's pool. The
     * repository mock therefore counts how many `findBoardPage` calls are in
     * flight AT ONCE, and the peak must never exceed the configured width.
     *
     * The mock settles only on an explicit release, so an unbounded
     * implementation is observed at FULL width (peak === column count) and
     * cannot pass by accident.
     */
    it('never exceeds the configured column concurrency, whatever the column count', async () => {
      const COLUMN_COUNT = 40;
      let inFlight = 0;
      let peak = 0;
      const releases: (() => void)[] = [];

      taskRepo.findBoardPage = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            releases.push(() => {
              inFlight -= 1;
              resolve({ tasks: [], hasMore: false, nextCursor: null });
            });
          }),
      );

      const columns = Array.from({ length: COLUMN_COUNT }, (_unused, index) => ({
        id: `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`,
        statusIds: [`status-${index}`],
        position: index,
      }));
      const wideBoard: BoardConfig = {
        projectId: 'project-1',
        columns,
        version: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      const pending = boardService(wideBoard).getBoardPages('project-1', {}, ctx);

      // Release one drained generation per tick, so the next query only starts
      // once a slot is genuinely free — which is what makes the peak meaningful
      // rather than an artefact of releasing everything at once.
      for (let tick = 0; tick < COLUMN_COUNT; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        releases.splice(0).forEach((release) => release());
      }

      const page = await pending;

      // The bound must not be met by dropping columns, nor by serialising the
      // whole board — every column is still fetched, several at a time.
      expect(taskRepo.findBoardPage).toHaveBeenCalledTimes(COLUMN_COUNT);
      expect(Object.keys(page)).toHaveLength(COLUMN_COUNT);
      expect(peak, 'the board fan-out must stay within its configured width').toBeLessThanOrEqual(
        BOARD_COLUMN_CONCURRENCY,
      );
      expect(peak, 'the fan-out must still run several columns at a time').toBeGreaterThan(1);
    });

    function makeBoard(): BoardConfig {
      return {
        projectId: 'project-1',
        columns: [
          { id: COL_A, statusIds: ['status-1', 'status-2'], position: 0 },
          { id: COL_B, statusIds: ['status-2'], position: 1 },
        ],
        version: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
    }

    function boardService(board: BoardConfig | null) {
      const boardRepo = createMock<TaskServiceBoardRepo>({
        findByProject: vi.fn().mockResolvedValue(board),
      });

      // Default (tests that need data assign their own mock first).
      if (!taskRepo.findBoardPage) taskRepo.findBoardPage = vi.fn();

      return new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        boardRepo,
        tenantMemberRepo,
        labelRepo,
      );
    }

    it('loads the first page of every column on initial load with exclusive statuses', async () => {
      taskRepo.findBoardPage = vi
        .fn()
        .mockResolvedValueOnce({
          tasks: [makeTask({ id: 't1', statusId: 'status-1', number: 1 })],
          hasMore: true,
          nextCursor: { priorityLevel: 1, number: 1 },
        })
        .mockResolvedValueOnce({ tasks: [], hasMore: false, nextCursor: null });

      const page = await boardService(makeBoard()).getBoardPages('project-1', {}, ctx);

      // COL_B owns status-2 (most specific column wins — V4-12 parity), so
      // COL_A is queried with the exclusive remainder only.
      expect(taskRepo.findBoardPage).toHaveBeenCalledTimes(2);
      expect(taskRepo.findBoardPage).toHaveBeenCalledWith('project-1', {
        statusIds: ['status-1'],
        cursor: null,
        sprintId: undefined,
        assigneeId: undefined,
        priorityLevel: undefined,
      });
      expect(taskRepo.findBoardPage).toHaveBeenCalledWith('project-1', {
        statusIds: ['status-2'],
        cursor: null,
        sprintId: undefined,
        assigneeId: undefined,
        priorityLevel: undefined,
      });
      expect(Object.keys(page).sort()).toEqual([COL_A, COL_B].sort());
      // Exact BoardTask DTO shape — no description/reporter/timestamp leakage.
      expect(page[COL_A]?.tasks[0]).toEqual({
        id: 't1',
        number: 1,
        title: 'Test Task',
        typeId: 'type-1',
        statusId: 'status-1',
        priorityLevel: 1,
        assigneeId: null,
        assigneeSnapshot: null,
        version: 1,
      });
      expect(page[COL_A]?.hasMore).toBe(true);
      expect(decodeBoardCursor(page[COL_A]?.nextCursor)).toEqual({ priorityLevel: 1, number: 1 });
      expect(page[COL_B]).toEqual({ tasks: [], hasMore: false, nextCursor: null });
    });

    it('loads only the requested columns on follow-up pages and forwards filters', async () => {
      taskRepo.findBoardPage = vi.fn().mockResolvedValue({ tasks: [], hasMore: false, nextCursor: null });

      await boardService(makeBoard()).getBoardPages(
        'project-1',
        {
          cursors: { [COL_B]: { priorityLevel: 2, number: 184 } },
          sprintId: 'sprint-1',
          assigneeId: 'user-2',
          priorityLevel: 3,
        },
        ctx,
      );

      expect(taskRepo.findBoardPage).toHaveBeenCalledTimes(1);
      expect(taskRepo.findBoardPage).toHaveBeenCalledWith('project-1', {
        statusIds: ['status-2'],
        cursor: { priorityLevel: 2, number: 184 },
        sprintId: 'sprint-1',
        assigneeId: 'user-2',
        priorityLevel: 3,
      });
    });

    it('throws NOT_FOUND when the project has no board', async () => {
      await expect(boardService(null).getBoardPages('project-1', {}, ctx)).rejects.toThrow(NotFoundError);
    });

    it('throws NOT_FOUND for a project of another tenant and never queries the board', async () => {
      const boardRepo = createMock<TaskServiceBoardRepo>({ findByProject: vi.fn() });
      const service = new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        boardRepo,
        tenantMemberRepo,
        labelRepo,
      );

      await expect(service.getBoardPages('project-1', {}, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(boardRepo.findByProject).not.toHaveBeenCalled();
    });

    it('BoardTask response does not contain projectId or description', async () => {
      taskRepo.findBoardPage = vi.fn().mockResolvedValue({
        tasks: [makeTask({ description: 'should never leak' })],
        hasMore: false,
        nextCursor: null,
      });

      const page = await boardService(makeBoard()).getBoardPages('project-1', {}, ctx);
      const card = page[COL_A]?.tasks[0] ?? {};

      expect('projectId' in card).toBe(false);
      expect('description' in card).toBe(false);
      expect(Object.keys(card).sort()).toEqual([
        'assigneeId',
        'assigneeSnapshot',
        'id',
        'number',
        'priorityLevel',
        'statusId',
        'title',
        'typeId',
        'version',
      ]);
    });

    it('throws a 400 ValidationError for unknown column ids (no statusIds injection)', async () => {
      await expect(
        boardService(makeBoard()).getBoardPages(
          'project-1',
          {
            cursors: { '550e8400-e29b-41d4-a716-446655440099': { priorityLevel: 1, number: 1 } },
          },
          ctx,
        ),
      ).rejects.toThrow(ValidationError);

      expect(taskRepo.findBoardPage).not.toHaveBeenCalled();
    });
  });
  /**
   * `GET /api/tasks/my` is membership-scoped.
   *
   * The property: a read scoped by a user id ALONE is not reachable. The
   * vocabulary the suite lacked is "the caller used to be allowed" — a
   * membership that is revoked, expired, or absent must remove the tenant from
   * the scope, and the query must never run on the caller's word alone.
   */
  describe('getMyTasks (D-17: membership scope)', () => {
    const asTask = (projectId: string) => makeTask({ id: `task-${projectId}`, projectId });

    function withMemberships(
      memberships: { tenantId: string; status: string; expiresAt: string | null }[],
      tasks: Task[] = [],
    ): TaskService {
      tenantMemberRepo = createMock<TaskServiceTenantMemberRepo>({
        findByUser: vi.fn().mockResolvedValue(memberships),
      });
      taskRepo.findAssignedTo = vi.fn().mockResolvedValue(tasks);
      service = new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        undefined,
        tenantMemberRepo,
        labelRepo,
      );

      return service;
    }

    it('scopes the query to the projects of the caller ACTIVE memberships', async () => {
      projectRepo.findByTenant = vi.fn((tenantId: string) =>
        Promise.resolve([{ id: `project-of-${tenantId}` }] as unknown as Awaited<
          ReturnType<ProjectRepository['findByTenant']>
        >),
      );

      const svc = withMemberships(
        [
          { tenantId: 'tenant-1', status: 'ACTIVE', expiresAt: null },
          { tenantId: 'tenant-2', status: 'ACTIVE', expiresAt: null },
        ],
        [asTask('project-of-tenant-1')],
      );
      const result = await svc.getMyTasks({ userId: 'user-1' });

      expect(result).toHaveLength(1);
      expect(taskRepo.findAssignedTo).toHaveBeenCalledWith(
        'user-1',
        ['project-of-tenant-1', 'project-of-tenant-2'],
        50,
      );
    });

    it('returns nothing after the membership is REVOKED — the caller used to be allowed', async () => {
      projectRepo.findByTenant = vi.fn((tenantId: string) =>
        Promise.resolve([{ id: `project-of-${tenantId}` }] as unknown as Awaited<
          ReturnType<ProjectRepository['findByTenant']>
        >),
      );

      const svc = withMemberships([{ tenantId: 'tenant-1', status: 'ACCESS_REVOKED', expiresAt: null }]);

      expect(await svc.getMyTasks({ userId: 'user-1' })).toEqual([]);
      // The closed door is a closed door: no query is issued at all.
      expect(taskRepo.findAssignedTo).not.toHaveBeenCalled();
    });

    it('returns nothing once the membership has EXPIRED (DEC-055 lazy expiry)', async () => {
      projectRepo.findByTenant = vi.fn((tenantId: string) =>
        Promise.resolve([{ id: `project-of-${tenantId}` }] as unknown as Awaited<
          ReturnType<ProjectRepository['findByTenant']>
        >),
      );

      const svc = withMemberships([
        { tenantId: 'tenant-1', status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000).toISOString() },
      ]);

      expect(await svc.getMyTasks({ userId: 'user-1' })).toEqual([]);
      expect(taskRepo.findAssignedTo).not.toHaveBeenCalled();
    });

    it('keeps a membership that expires in the future', async () => {
      projectRepo.findByTenant = vi.fn((tenantId: string) =>
        Promise.resolve([{ id: `project-of-${tenantId}` }] as unknown as Awaited<
          ReturnType<ProjectRepository['findByTenant']>
        >),
      );

      const svc = withMemberships([
        { tenantId: 'tenant-1', status: 'ACTIVE', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      ]);

      await svc.getMyTasks({ userId: 'user-1' });

      expect(taskRepo.findAssignedTo).toHaveBeenCalledWith('user-1', ['project-of-tenant-1'], 50);
    });

    it('returns nothing when the caller has no membership at all', async () => {
      const svc = withMemberships([]);

      expect(await svc.getMyTasks({ userId: 'user-1' })).toEqual([]);
      expect(taskRepo.findAssignedTo).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller identity is missing (fail closed, not "no scope")', async () => {
      const svc = withMemberships([{ tenantId: 'tenant-1', status: 'ACTIVE', expiresAt: null }]);

      await expect(svc.getMyTasks({ userId: '' })).rejects.toThrow(UnauthorizedError);
      expect(taskRepo.findAssignedTo).not.toHaveBeenCalled();
    });
  });

  /**
   * The labelIds half — a task may only carry labels of its own project.
   */
  describe('labelIds are project-scoped (D-13)', () => {
    const createInput = (labelIds: string[]) =>
      ({
        projectId: 'project-1',
        number: 1,
        typeId: 'type-1',
        title: 'T',
        description: null,
        statusId: 'status-1',
        priorityLevel: 1,
        labelIds,
      }) as unknown as CreateTask;

    beforeEach(() => {
      taskRepo.create = vi.fn().mockResolvedValue(makeTask());
    });

    it('accepts labels that belong to the project', async () => {
      labelRepo = createMock<TaskServiceLabelRepo>({
        findByProject: vi.fn().mockResolvedValue([{ id: 'label-1' }, { id: 'label-2' }]),
      });
      service = new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        undefined,
        tenantMemberRepo,
        labelRepo,
      );

      await expect(service.createTask('project-1', createInput(['label-1', 'label-2']), ctx)).resolves.toBeDefined();
      expect(taskRepo.create).toHaveBeenCalled();
    });

    it('rejects a label from ANOTHER project with 404, so a foreign id is indistinguishable from a missing one', async () => {
      labelRepo = createMock<TaskServiceLabelRepo>({
        // The label exists — in project-2.
        findByProject: vi.fn().mockResolvedValue([{ id: 'label-own' }]),
      });
      service = new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        undefined,
        tenantMemberRepo,
        labelRepo,
      );

      await expect(service.createTask('project-1', createInput(['label-foreign']), ctx)).rejects.toThrow(NotFoundError);
      expect(taskRepo.create).not.toHaveBeenCalled();
    });

    it('rejects the same foreign label on the UPDATE path (PATCH was the bypass)', async () => {
      labelRepo = createMock<TaskServiceLabelRepo>({
        findByProject: vi.fn().mockResolvedValue([{ id: 'label-own' }]),
      });
      taskRepo.findById = vi.fn().mockResolvedValue(makeTask({ version: 1 }));
      service = new TaskService(
        taskRepo,
        counterService,
        projectRepo,
        projectMemberRepo,
        statusRepo,
        taskTypeRepo,
        userRepo,
        sprintRepo,
        commentRepo,
        relationshipRepo,
        auditService,
        undefined,
        tenantMemberRepo,
        labelRepo,
      );

      await expect(
        service.updateTask('task-1', { version: 1, labelIds: ['label-foreign'] } as never, ctx),
      ).rejects.toThrow(NotFoundError);
      expect(taskRepo.updateWithVersion).not.toHaveBeenCalled();
    });
  });
});
