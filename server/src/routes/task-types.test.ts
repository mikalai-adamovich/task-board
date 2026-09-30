/**
 * Tests for task-type CRUD + reorder HTTP routes.
 *
 * Follows the established route-test pattern (see projects.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 * - Real `requirePermission` middleware exercises the RBAC matrix (403 paths)
 * - Real `authMiddleware` exercises the 401 path
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { createTaskTypeRoutes } from './task-types.js';
import { TaskTypeService } from '../services/task-type.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { authMiddleware } from '../middleware/auth.js';
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
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const mockTaskType = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  projectId: PROJECT_ID,
  key: 'BUG',
  name: 'Bug',
  icon: '📋',
  position: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

vi.mock('../services/task-type.service.js', () => ({
  TaskTypeService: vi.fn().mockImplementation(() => ({
    getTaskTypesByProject: vi.fn().mockResolvedValue([mockTaskType]),
    createTaskType: vi.fn().mockResolvedValue(mockTaskType),
    reorder: vi.fn().mockResolvedValue([mockTaskType]),
    updateTaskType: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'dddddddd-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Task type not found'))
          : Promise.resolve(mockTaskType),
      ),
    deleteTaskType: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'dddddddd-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Task type not found'))
          : Promise.resolve(undefined),
      ),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };
const VALID_UUID = USER_ID;

interface MockTaskTypeService {
  getTaskTypesByProject: ReturnType<typeof vi.fn>;
  createTaskType: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
  updateTaskType: ReturnType<typeof vi.fn>;
  deleteTaskType: ReturnType<typeof vi.fn>;
}

/**
 * @param sink receives the service mock instance created for the request, so
 *             the forwarded caller context can be asserted on.
 */
function createTestApp(
  tenantRole = 'OWNER',
  projectRole: string | null = null,
  sink: { svc?: MockTaskTypeService } = {},
) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockTaskTypes = TaskTypeService as unknown as new () => MockTaskTypeService;
    const svc = new MockTaskTypes();

    sink.svc = svc;
    c.set('userId', VALID_UUID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    c.set('svc', { taskTypes: svc } as never);
    await next();
  });

  app.route('/api', createTaskTypeRoutes());

  return app;
}

/** App with real authMiddleware — used for 401 coverage. */
function createAuthTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockTaskTypes = TaskTypeService as unknown as new () => InstanceType<typeof TaskTypeService>;

    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', 'OWNER' as const);
    c.set('svc', {
      taskTypes: new MockTaskTypes(),
      auth: { findActiveUser: vi.fn().mockResolvedValue({ id: USER_ID }) },
    } as never);
    await next();
  });
  app.use('/api/*', authMiddleware);

  app.route('/api', createTaskTypeRoutes());

  return app;
}

async function getJson(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: 'GET' }, TEST_ENV);
}

async function postJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
    TEST_ENV,
  );
}

async function patchJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
    TEST_ENV,
  );
}

async function deleteJson(app: Hono<AppEnv>, path: string, body?: unknown) {
  // `RequestInit` keys are `exactOptionalPropertyTypes` — an absent header
  // must be an absent KEY, not `headers: undefined` (which is a different type).
  const init: RequestInit =
    body === undefined
      ? { method: 'DELETE' }
      : {
          method: 'DELETE',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        };

  return app.request(path, init, TEST_ENV);
}

// ─── GET /api/projects/:projectId/task-types ─────────────────────────────────

describe('GET /api/projects/:projectId/task-types', () => {
  const app = createTestApp();

  it('returns 200 with { data } envelope containing task types', async () => {
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/task-types`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as { key: string }[])[0]?.key).toBe('BUG');
  });
});

// ─── POST /api/projects/:projectId/task-types ────────────────────────────────

describe('POST /api/projects/:projectId/task-types', () => {
  const validCreateBody = { key: 'FEATURE', name: 'Feature', position: 1 };

  it('returns 201 with the created task type for an owner', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/task-types`, validCreateBody);

    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect((body.data as { key: string }).key).toBe('BUG');
  });

  it('returns 201 for a project admin (project-level permission)', async () => {
    const app = createTestApp('MEMBER', 'PROJECT_ADMIN');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/task-types`, validCreateBody);

    expect(res.status).toBe(201);
  });

  it('returns 403 for an editor (edit_project_config is PROJECT_ADMIN-only)', async () => {
    const app = createTestApp('MEMBER', 'EDITOR');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/task-types`, validCreateBody);

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for a lowercase key (regex violation)', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/task-types`, {
      key: 'feature',
      name: 'Feature',
      position: 1,
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a key longer than 20 characters', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/task-types`, {
      key: 'THIS_KEY_IS_WAY_TOO_LONG',
      name: 'Feature',
      position: 1,
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── PATCH /api/projects/:projectId/task-types/reorder ───────────────────────

describe('PATCH /api/projects/:projectId/task-types/reorder', () => {
  const validReorderBody = { items: [{ id: '550e8400-e29b-41d4-a716-446655440091', position: 0 }] };

  it('returns 200 with the reordered task types', async () => {
    const app = createTestApp('OWNER');
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/task-types/reorder`, validReorderBody);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown[] };

    expect(Array.isArray(body.data)).toBe(true);
  });

  it('returns 403 for a member without a project role', async () => {
    const app = createTestApp('MEMBER', null);
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/task-types/reorder`, validReorderBody);

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for an empty items array', async () => {
    const app = createTestApp('OWNER');
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/task-types/reorder`, { items: [] });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── PATCH /api/task-types/:taskTypeId ───────────────────────────────────────

describe('PATCH /api/task-types/:taskTypeId', () => {
  const app = createTestApp();

  it('returns 200 with the updated task type', async () => {
    const res = await patchJson(app, '/api/task-types/dddddddd-0000-4000-8000-000000000001', { name: 'Defect' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe('dddddddd-0000-4000-8000-000000000001');
  });

  it('returns 404 when the task type does not exist', async () => {
    const res = await patchJson(app, '/api/task-types/dddddddd-0000-4000-8000-0000000000ff', { name: 'Defect' });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for a negative position', async () => {
    const res = await patchJson(app, '/api/task-types/dddddddd-0000-4000-8000-000000000001', { position: -5 });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── DELETE /api/task-types/:taskTypeId ──────────────────────────────────────

describe('DELETE /api/task-types/:taskTypeId', () => {
  const app = createTestApp();

  it('returns 200 with success envelope (no replacement)', async () => {
    const res = await deleteJson(app, '/api/task-types/dddddddd-0000-4000-8000-000000000001', {});

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });

  it('returns 200 with a replacement type id', async () => {
    const res = await deleteJson(app, '/api/task-types/dddddddd-0000-4000-8000-000000000001', {
      replacementTypeId: '550e8400-e29b-41d4-a716-446655440099',
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });

  it('returns 404 when the task type does not exist', async () => {
    const res = await deleteJson(app, '/api/task-types/dddddddd-0000-4000-8000-0000000000ff', {});

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an invalid replacement id', async () => {
    const res = await deleteJson(app, '/api/task-types/dddddddd-0000-4000-8000-000000000001', {
      replacementTypeId: 'not-a-uuid',
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── Auth (401) ──────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 with error envelope when no Authorization header is present', async () => {
    const app = createAuthTestApp();
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/task-types`);

    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an invalid token', async () => {
    const app = createAuthTestApp();
    const res = await app.request(
      `/api/projects/${PROJECT_ID}/task-types`,
      { method: 'GET', headers: { Authorization: 'Bearer not-a-jwt' } },
      TEST_ENV,
    );

    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows requests with a valid Bearer token', async () => {
    const app = createAuthTestApp();
    const token = await sign(
      { sub: USER_ID, email: 'user@test.dev', exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-secret',
    );
    const res = await app.request(
      `/api/projects/${PROJECT_ID}/task-types`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
  });
});

// ─── Caller context forwarding ────────────────────────────────────────────────

describe('caller context forwarding (M-001/M-006/M-034)', () => {
  const expected = { tenantId: TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' };

  it('forwards tenantId + userId + role on every task-type route', async () => {
    const create = {} as { svc?: MockTaskTypeService };

    await postJson(createTestApp('OWNER', null, create), `/api/projects/${PROJECT_ID}/task-types`, {
      key: 'BUG',
      name: 'Bug',
      position: 0,
    });
    expect(create.svc?.createTaskType).toHaveBeenCalledWith(
      PROJECT_ID,
      { key: 'BUG', name: 'Bug', icon: '📋', position: 0 },
      expected,
    );

    const list = {} as { svc?: MockTaskTypeService };

    await getJson(createTestApp('OWNER', null, list), `/api/projects/${PROJECT_ID}/task-types`);
    expect(list.svc?.getTaskTypesByProject).toHaveBeenCalledWith(PROJECT_ID, expected);

    const reorder = {} as { svc?: MockTaskTypeService };

    await patchJson(createTestApp('OWNER', null, reorder), `/api/projects/${PROJECT_ID}/task-types/reorder`, {
      items: [{ id: '550e8400-e29b-41d4-a716-446655440091', position: 0 }],
    });
    expect(reorder.svc?.reorder).toHaveBeenCalledWith(
      PROJECT_ID,
      [{ id: '550e8400-e29b-41d4-a716-446655440091', position: 0 }],
      expected,
    );

    const update = {} as { svc?: MockTaskTypeService };

    await patchJson(createTestApp('OWNER', null, update), '/api/task-types/dddddddd-0000-4000-8000-000000000001', {
      name: 'Defect',
    });
    expect(update.svc?.updateTaskType).toHaveBeenCalledWith(
      'dddddddd-0000-4000-8000-000000000001',
      { name: 'Defect' },
      expected,
    );

    const remove = {} as { svc?: MockTaskTypeService };

    await deleteJson(createTestApp('OWNER', null, remove), '/api/task-types/dddddddd-0000-4000-8000-000000000001', {});
    expect(remove.svc?.deleteTaskType).toHaveBeenCalledWith(
      'dddddddd-0000-4000-8000-000000000001',
      undefined,
      expected,
    );
  });
});
