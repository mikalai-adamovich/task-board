/**
 * Tests for task HTTP routes.
 *
 * Follows the established route-test pattern (see labels.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 * - Real `requirePermission` middleware exercises the RBAC matrix (403 paths)
 *
 * The production incident was a cross-tenant
 * `DELETE /tasks/<tenant B task>` and `PATCH /tasks/<tenant B task>` returning
 * 200, because the service's `if (userId && userRole) { …ensurePermission… }`
 * guard SKIPPED the check when the call site forwarded nothing. These tests pin
 * that EVERY task route now forwards the full caller context (tenantId + userId
 * + role) taken from the request context — never from the path or the body — and
 * that the cross-tenant result is a 404 with no write.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTaskRoutes } from './tasks.js';
import { TaskService } from '../services/task.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { NotFoundError } from '../errors/app-error.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    updateMany: vi.fn(),
  })),
}));

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TENANT_ID = '550e8400-e29b-41d4-a716-4466554400ff';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440020';
const STATUS_ID = '550e8400-e29b-41d4-a716-446655440030';
const TYPE_ID = '550e8400-e29b-41d4-a716-446655440040';
const mockTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 1,
  typeId: TYPE_ID,
  title: 'Test Task',
  description: null,
  statusId: STATUS_ID,
  priorityLevel: 1,
  reporterId: USER_ID,
  reporterSnapshot: { displayName: 'Reporter' },
  assigneeId: null,
  assigneeSnapshot: null,
  sprintId: null,
  labelIds: [],
  createdById: USER_ID,
  createdBySnapshot: { displayName: 'Reporter' },
  version: 1,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const page = { data: [mockTask], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };

interface MockTaskService {
  getTasksByProject: ReturnType<typeof vi.fn>;
  getBoardTasks: ReturnType<typeof vi.fn>;
  getStatusSummary: ReturnType<typeof vi.fn>;
  getBoardPages: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  getTaskByKey: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  bulkUpdateTasks: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  getMyTasks: ReturnType<typeof vi.fn>;
}

vi.mock('../services/task.service.js', () => ({
  TaskService: vi.fn().mockImplementation(() => ({
    getTasksByProject: vi.fn().mockResolvedValue(page),
    getBoardTasks: vi.fn().mockResolvedValue(page),
    getStatusSummary: vi.fn().mockResolvedValue([{ statusId: STATUS_ID, count: 1 }]),
    getBoardPages: vi.fn().mockResolvedValue({}),
    createTask: vi.fn().mockResolvedValue(mockTask),
    getTask: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'eeeeeeee-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Task not found'))
          : Promise.resolve(mockTask),
      ),
    getTaskByKey: vi.fn().mockResolvedValue(mockTask),
    updateTask: vi.fn().mockResolvedValue({ ...mockTask, title: 'Updated', version: 2 }),
    bulkUpdateTasks: vi.fn().mockResolvedValue({ updated: 1 }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getMyTasks: vi.fn().mockResolvedValue([mockTask]),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

/**
 * @param sink receives the service mock instance created for the request, so
 *             the forwarded context can be asserted on.
 */
function createTestApp(tenantRole = 'OWNER', projectRole: string | null = null, sink: { svc?: MockTaskService } = {}) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockTasks = TaskService as unknown as new () => MockTaskService;
    const svc = new MockTasks();

    sink.svc = svc;
    c.set('userId', USER_ID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    c.set('svc', { tasks: svc } as never);
    await next();
  });

  app.route('/api', createTaskRoutes());

  return app;
}
async function request(app: Hono<AppEnv>, path: string, method: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    TEST_ENV,
  );
}

const VALID_TASK_BODY = { title: 'New Task', typeId: TYPE_ID, statusId: STATUS_ID, priorityLevel: 1 };
const VALID_BULK_BODY = { taskIds: [TASK_ID], data: { statusId: STATUS_ID } };

// ─── The caller context is always forwarded ──────────────────────────────────

describe('caller context forwarding (M-001/M-006/M-034)', () => {
  const expected = { tenantId: TENANT_ID, userId: USER_ID, userRole: 'OWNER' };

  it('GET /projects/:projectId/tasks forwards tenantId + userId + role', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/tasks`, 'GET');

    expect(sink.svc?.getTasksByProject).toHaveBeenCalledWith(PROJECT_ID, expect.anything(), expected);
  });

  it('GET /projects/:projectId/tasks?view=board forwards the context to getBoardTasks', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/tasks?view=board`, 'GET');

    expect(sink.svc?.getBoardTasks).toHaveBeenCalledWith(PROJECT_ID, expect.anything(), expected);
  });

  it('GET /projects/:projectId/tasks/status-summary forwards the context', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/tasks/status-summary`, 'GET');

    expect(sink.svc?.getStatusSummary).toHaveBeenCalledWith(PROJECT_ID, expected);
  });

  it('GET /projects/:projectId/tasks/board forwards the context', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/tasks/board`, 'GET');

    expect(sink.svc?.getBoardPages).toHaveBeenCalledWith(PROJECT_ID, expect.anything(), expected);
  });

  it('POST /projects/:projectId/tasks forwards the context (no separate userId/role/projectRole args)', async () => {
    const sink: { svc?: MockTaskService } = {};
    const res = await request(
      createTestApp('OWNER', 'EDITOR', sink),
      `/api/projects/${PROJECT_ID}/tasks`,
      'POST',
      VALID_TASK_BODY,
    );

    expect(res.status).toBe(201);
    expect(sink.svc?.createTask).toHaveBeenCalledWith(PROJECT_ID, VALID_TASK_BODY, expected);
  });

  it('GET /tasks/:taskId forwards the context to the id-based read', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}`, 'GET');

    expect(sink.svc?.getTask).toHaveBeenCalledWith(TASK_ID, expected);
  });

  it('GET /tasks/KEY-NUMBER forwards the context to getTaskByKey', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('OWNER', null, sink), '/api/tasks/PRO-1', 'GET');

    expect(sink.svc?.getTaskByKey).toHaveBeenCalledWith(expected, 'PRO', 1);
  });

  it('PATCH /tasks/:taskId forwards the context', async () => {
    const sink: { svc?: MockTaskService } = {};
    const res = await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}`, 'PATCH', {
      title: 'Updated',
      version: 1,
    });

    expect(res.status).toBe(200);
    expect(sink.svc?.updateTask).toHaveBeenCalledWith(TASK_ID, { title: 'Updated', version: 1 }, expected);
  });

  it('PATCH /projects/:projectId/tasks/bulk forwards the context', async () => {
    const sink: { svc?: MockTaskService } = {};
    const res = await request(
      createTestApp('OWNER', null, sink),
      `/api/projects/${PROJECT_ID}/tasks/bulk`,
      'PATCH',
      VALID_BULK_BODY,
    );

    expect(res.status).toBe(200);
    expect(sink.svc?.bulkUpdateTasks).toHaveBeenCalledWith(PROJECT_ID, [TASK_ID], { statusId: STATUS_ID }, expected);
  });

  it('DELETE /tasks/:taskId forwards the context (the production cross-tenant DELETE call site)', async () => {
    const sink: { svc?: MockTaskService } = {};
    const res = await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}`, 'DELETE');

    expect(res.status).toBe(200);
    expect(sink.svc?.deleteTask).toHaveBeenCalledWith(TASK_ID, expected);
  });

  it('never derives the tenant from the path or the body', async () => {
    const sink: { svc?: MockTaskService } = {};
    const app = createTestApp('OWNER', null, sink);

    // A body that smuggles another tenant id must not reach the service.
    await request(app, `/api/tasks/${TASK_ID}`, 'PATCH', { title: 'Updated', version: 1, tenantId: OTHER_TENANT_ID });

    const [, , context] = (sink.svc?.updateTask.mock.calls[0] ?? []) as [string, unknown, { tenantId: string }];

    expect(context.tenantId).toBe(TENANT_ID);
  });

  it('propagates the role verbatim, so the service gate cannot be bypassed by a missing role', async () => {
    const sink: { svc?: MockTaskService } = {};

    await request(createTestApp('MEMBER', 'EDITOR', sink), `/api/tasks/${TASK_ID}`, 'DELETE');

    expect(sink.svc?.deleteTask).toHaveBeenCalledWith(TASK_ID, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      userRole: 'MEMBER',
    });
  });
});

// ─── Happy paths (envelope / status codes) ───────────────────────────────────

describe('task routes', () => {
  const app = createTestApp();

  it('GET /projects/:projectId/tasks returns 200 with the { data } + pagination envelope', async () => {
    const res = await request(app, `/api/projects/${PROJECT_ID}/tasks`, 'GET');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string }[]; pagination: { total: number } };

    expect(body.data[0]?.id).toBe(TASK_ID);
    expect(body.pagination.total).toBe(1);
  });

  it('POST /projects/:projectId/tasks returns 201', async () => {
    const res = await request(app, `/api/projects/${PROJECT_ID}/tasks`, 'POST', VALID_TASK_BODY);

    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe(TASK_ID);
  });

  it('GET /tasks/:taskId returns 404 for a nonexistent task', async () => {
    const res = await request(app, '/api/tasks/eeeeeeee-0000-4000-8000-0000000000ff', 'GET');

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH /projects/:projectId/tasks returns 403 for an EDITOR (bulk edit_task is allowed, create is not)', async () => {
    const res = await request(
      createTestApp('MEMBER', 'VIEWER'),
      `/api/projects/${PROJECT_ID}/tasks`,
      'POST',
      VALID_TASK_BODY,
    );

    expect(res.status).toBe(403);
  });

  /**
   * The "no sprint" (backlog) filter over the real HTTP surface: query
   * string → Zod → `TaskQueryOptions` handed to the service. This is the
   * contract the Sprints page Backlog counter depends on.
   */
  describe('F7 — hasSprint query filter', () => {
    const SPRINT_UUID = '550e8400-e29b-41d4-a716-4466554400a1';

    it('?hasSprint=false reaches the service as hasSprint: false', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(
        createTestApp('OWNER', null, sink),
        `/api/projects/${PROJECT_ID}/tasks?hasSprint=false&limit=1`,
        'GET',
      );

      expect(res.status).toBe(200);
      expect(sink.svc?.getTasksByProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ hasSprint: false, limit: 1 }),
        expect.anything(),
      );
    });

    it('?hasSprint=true reaches the service as hasSprint: true', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(
        createTestApp('OWNER', null, sink),
        `/api/projects/${PROJECT_ID}/tasks?hasSprint=true`,
        'GET',
      );

      expect(res.status).toBe(200);
      expect(sink.svc?.getTasksByProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ hasSprint: true }),
        expect.anything(),
      );
    });

    it('an absent ?hasSprint leaves it undefined (no sprint filtering)', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/tasks`, 'GET');

      expect(res.status).toBe(200);
      expect(sink.svc?.getTasksByProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ hasSprint: undefined }),
        expect.anything(),
      );
    });

    it('?sprintId=<uuid> still passes sprintId through untouched', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(
        createTestApp('OWNER', null, sink),
        `/api/projects/${PROJECT_ID}/tasks?sprintId=${SPRINT_UUID}`,
        'GET',
      );

      expect(res.status).toBe(200);
      expect(sink.svc?.getTasksByProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ sprintId: SPRINT_UUID, hasSprint: undefined }),
        expect.anything(),
      );
    });

    it('?sprintId + ?hasSprint together return 400 VALIDATION_ERROR (mutually exclusive)', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(
        createTestApp('OWNER', null, sink),
        `/api/projects/${PROJECT_ID}/tasks?sprintId=${SPRINT_UUID}&hasSprint=false`,
        'GET',
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { code: string; details?: { path: string }[] } };

      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.path === 'hasSprint')).toBe(true);
      expect(sink.svc?.getTasksByProject).not.toHaveBeenCalled();
    });

    it('?hasSprint=1 (outside the enum) returns 400 — no loose coercion', async () => {
      const sink: { svc?: MockTaskService } = {};
      const res = await request(
        createTestApp('OWNER', null, sink),
        `/api/projects/${PROJECT_ID}/tasks?hasSprint=1`,
        'GET',
      );

      expect(res.status).toBe(400);
      expect(sink.svc?.getTasksByProject).not.toHaveBeenCalled();
    });

    it('?sprintId= (empty, the pre-F6 Sprints-page 400) is still rejected', async () => {
      const res = await request(createTestApp(), `/api/projects/${PROJECT_ID}/tasks?sprintId=`, 'GET');

      expect(res.status).toBe(400);
    });
  });

  it('POST /projects/:projectId/tasks returns 400 for an invalid body (Zod validation)', async () => {
    const res = await request(app, `/api/projects/${PROJECT_ID}/tasks`, 'POST', { title: '' });

    expect(res.status).toBe(400);
  });

  it('DELETE /tasks/:taskId returns 200 with a success envelope', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}`, 'DELETE');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });
});
