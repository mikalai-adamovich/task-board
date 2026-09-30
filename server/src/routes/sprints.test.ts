/**
 * Tests for sprint CRUD HTTP routes.
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
import { createSprintRoutes } from './sprints.js';
import { SprintService } from '../services/sprint.service.js';
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
const mockSprint = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  projectId: PROJECT_ID,
  name: 'Sprint 1',
  goal: null,
  status: 'PLANNED',
  startDate: '2025-01-01',
  endDate: '2025-01-15',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

vi.mock('../services/sprint.service.js', () => ({
  SprintService: vi.fn().mockImplementation(() => ({
    getSprintsByProject: vi.fn().mockResolvedValue([mockSprint]),
    createSprint: vi.fn().mockResolvedValue(mockSprint),
    getSprint: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'aaaaaaaa-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Sprint not found'))
          : Promise.resolve(mockSprint),
      ),
    updateSprint: vi.fn().mockResolvedValue(mockSprint),
    deleteSprint: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'aaaaaaaa-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Sprint not found'))
          : Promise.resolve(undefined),
      ),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };
const VALID_UUID = USER_ID;

interface MockSprintService {
  getSprintsByProject: ReturnType<typeof vi.fn>;
  createSprint: ReturnType<typeof vi.fn>;
  getSprint: ReturnType<typeof vi.fn>;
  updateSprint: ReturnType<typeof vi.fn>;
  deleteSprint: ReturnType<typeof vi.fn>;
}

/**
 * @param sink receives the service mock instance created for the request, so
 *             the forwarded caller context can be asserted on.
 */
function createTestApp(
  tenantRole = 'OWNER',
  projectRole: string | null = null,
  sink: { svc?: MockSprintService } = {},
) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockSprints = SprintService as unknown as new () => MockSprintService;
    const svc = new MockSprints();

    sink.svc = svc;
    c.set('userId', VALID_UUID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    c.set('svc', { sprints: svc } as never);
    await next();
  });

  app.route('/api', createSprintRoutes());

  return app;
}

/** App with real authMiddleware — used for 401 coverage. */
function createAuthTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockSprints = SprintService as unknown as new () => InstanceType<typeof SprintService>;

    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', 'OWNER' as const);
    c.set('svc', {
      sprints: new MockSprints(),
      auth: { findActiveUser: vi.fn().mockResolvedValue({ id: USER_ID }) },
    } as never);
    await next();
  });
  app.use('/api/*', authMiddleware);

  app.route('/api', createSprintRoutes());

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

async function deleteJson(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: 'DELETE' }, TEST_ENV);
}

const validCreateBody = { name: 'Sprint 1', startDate: '2025-01-01', endDate: '2025-01-15' };

// ─── GET /api/projects/:projectId/sprints ────────────────────────────────────

describe('GET /api/projects/:projectId/sprints', () => {
  const app = createTestApp();

  it('returns 200 with { data } envelope containing sprints', async () => {
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/sprints`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as { name: string }[])[0]?.name).toBe('Sprint 1');
  });
});

// ─── POST /api/projects/:projectId/sprints ───────────────────────────────────

describe('POST /api/projects/:projectId/sprints', () => {
  it('returns 201 with the created sprint for an owner', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/sprints`, validCreateBody);

    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect((body.data as { name: string }).name).toBe('Sprint 1');
  });

  it('returns 201 for a project admin (project-level permission)', async () => {
    const app = createTestApp('MEMBER', 'PROJECT_ADMIN');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/sprints`, validCreateBody);

    expect(res.status).toBe(201);
  });

  it('returns 403 for a member without a project role (requirePermission gate)', async () => {
    const app = createTestApp('MEMBER', null);
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/sprints`, validCreateBody);

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 when endDate is before startDate', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/sprints`, {
      name: 'Backwards Sprint',
      startDate: '2025-01-15',
      endDate: '2025-01-01',
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when name is missing', async () => {
    const app = createTestApp('OWNER');
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/sprints`, { startDate: '2025-01-01' });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── GET /api/sprints/:sprintId ──────────────────────────────────────────────

describe('GET /api/sprints/:sprintId', () => {
  const app = createTestApp();

  it('returns 200 with the sprint', async () => {
    const res = await getJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('returns 404 with error envelope when the sprint does not exist', async () => {
    const res = await getJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-0000000000ff');

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── PATCH /api/sprints/:sprintId ────────────────────────────────────────────

describe('PATCH /api/sprints/:sprintId', () => {
  const app = createTestApp();

  it('returns 200 with the updated sprint', async () => {
    const res = await patchJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001', { name: 'Renamed Sprint' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { name: string } };

    expect(body.data.name).toBe('Sprint 1');
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await patchJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001', { status: 'NOT_A_STATUS' });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── DELETE /api/sprints/:sprintId ───────────────────────────────────────────

describe('DELETE /api/sprints/:sprintId', () => {
  const app = createTestApp();

  it('returns 200 with success envelope', async () => {
    const res = await deleteJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });

  it('returns 404 when the sprint does not exist', async () => {
    const res = await deleteJson(app, '/api/sprints/aaaaaaaa-0000-4000-8000-0000000000ff');

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── Auth (401) ──────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 with error envelope when no Authorization header is present', async () => {
    const app = createAuthTestApp();
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/sprints`);

    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an invalid token', async () => {
    const app = createAuthTestApp();
    const res = await app.request(
      `/api/projects/${PROJECT_ID}/sprints`,
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
      `/api/projects/${PROJECT_ID}/sprints`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
  });
});

// ─── Caller context forwarding ────────────────────────────────────────────────

describe('caller context forwarding (M-001/M-006/M-034)', () => {
  const expected = { tenantId: TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' };

  it('forwards tenantId + userId + role on every sprint route', async () => {
    const create = {} as { svc?: MockSprintService };

    await postJson(createTestApp('OWNER', null, create), `/api/projects/${PROJECT_ID}/sprints`, { name: 'Sprint 1' });
    expect(create.svc?.createSprint).toHaveBeenCalledWith(PROJECT_ID, { name: 'Sprint 1' }, expected);

    const list = {} as { svc?: MockSprintService };

    await getJson(createTestApp('OWNER', null, list), `/api/projects/${PROJECT_ID}/sprints`);
    expect(list.svc?.getSprintsByProject).toHaveBeenCalledWith(PROJECT_ID, expected);

    const one = {} as { svc?: MockSprintService };

    await getJson(createTestApp('OWNER', null, one), '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001');
    expect(one.svc?.getSprint).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', expected);

    const update = {} as { svc?: MockSprintService };

    await patchJson(createTestApp('OWNER', null, update), '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001', {
      name: 'Renamed',
    });
    expect(update.svc?.updateSprint).toHaveBeenCalledWith(
      'aaaaaaaa-0000-4000-8000-000000000001',
      { name: 'Renamed' },
      expected,
    );

    const remove = {} as { svc?: MockSprintService };

    await deleteJson(createTestApp('OWNER', null, remove), '/api/sprints/aaaaaaaa-0000-4000-8000-000000000001');
    expect(remove.svc?.deleteSprint).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', expected);
  });
});
