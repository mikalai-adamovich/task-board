/**
 * Tests for user preferences HTTP routes (global + project-scoped).
 *
 * Follows the established route-test pattern (see projects.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 * - Real `authMiddleware` exercises the 401 path
 *
 * These routes have no `requirePermission` gate — preferences are strictly
 * per-user, so authorization is implicit (userId comes from the JWT).
 *
 * The project-scoped pair lives in its own factory
 * (`createProjectPreferencesRoutes`) because it is mounted INSIDE the
 * tenant-scoped sub-app; it additionally asserts project ownership.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { createProjectPreferencesRoutes, createUserPreferencesRoutes } from './user-preferences.js';
import { UserPreferencesService } from '../services/user-preferences.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { authMiddleware } from '../middleware/auth.js';
import { NotFoundError } from '../errors/app-error.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  })),
}));

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const mockGlobalSettings = {
  userId: USER_ID,
  zoom: 100,
  theme: 'system',
  themeMode: 'auto',
  lightTheme: null,
  darkTheme: null,
  language: 'en',
  pageSize: 0,
  dateFormat: 'YYYY-MM-DD',
  timeFormat: 'AUTO',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const mockProjectPreference = {
  userId: USER_ID,
  projectId: PROJECT_ID,
  taskTableColumns: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

vi.mock('../services/user-preferences.service.js', () => ({
  UserPreferencesService: vi.fn().mockImplementation(() => ({
    getGlobalSettings: vi.fn().mockResolvedValue(mockGlobalSettings),
    updateGlobalSettings: vi.fn().mockResolvedValue(mockGlobalSettings),
    getPreferences: vi.fn().mockResolvedValue(mockProjectPreference),
    updatePreferences: vi.fn().mockResolvedValue(mockProjectPreference),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };
const VALID_UUID = USER_ID;

function createTestApp(getProject: () => Promise<unknown> = () => Promise.resolve({ id: PROJECT_ID })) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockPrefs = UserPreferencesService as unknown as new () => InstanceType<typeof UserPreferencesService>;

    c.set('userId', VALID_UUID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', 'OWNER' as const);
    c.set('svc', {
      preferences: new MockPrefs(),
      // The project-scoped PATCH now resolves the project through the
      // WRITE seam, so the double exposes it. It delegates to the same lookup
      // the GET uses, which keeps the 404-on-foreign-project case intact.
      projects: { getProject: vi.fn(getProject), assertProjectWritable: vi.fn(getProject) },
    } as never);
    await next();
  });

  app.route('/api', createUserPreferencesRoutes());
  app.route('/api', createProjectPreferencesRoutes());

  return app;
}

/** App with real authMiddleware — used for 401 coverage. */
function createAuthTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockPrefs = UserPreferencesService as unknown as new () => InstanceType<typeof UserPreferencesService>;

    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', 'OWNER' as const);
    c.set('svc', {
      preferences: new MockPrefs(),
      auth: { findActiveUser: vi.fn().mockResolvedValue({ id: USER_ID }) },
    } as never);
    await next();
  });
  app.use('/api/*', authMiddleware);

  app.route('/api', createUserPreferencesRoutes());

  return app;
}

async function getJson(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: 'GET' }, TEST_ENV);
}

async function putJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'PUT',
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

// ─── GET /api/preferences ────────────────────────────────────────────────────

describe('GET /api/preferences', () => {
  const app = createTestApp();

  it('returns 200 with { data } envelope containing global settings', async () => {
    const res = await getJson(app, '/api/preferences');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { userId: string } };

    expect(body.data.userId).toBe(USER_ID);
  });
});

// ─── PUT /api/preferences ────────────────────────────────────────────────────

describe('PUT /api/preferences', () => {
  it('returns 200 with the updated global settings', async () => {
    const app = createTestApp();
    const res = await putJson(app, '/api/preferences', { zoom: 120, language: 'de' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { userId: string } };

    expect(body.data.userId).toBe(USER_ID);
  });

  it('returns 400 when no preference field is provided', async () => {
    const app = createTestApp();
    const res = await putJson(app, '/api/preferences', {});

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an out-of-range zoom value', async () => {
    const app = createTestApp();
    const res = await putJson(app, '/api/preferences', { zoom: 500 });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an invalid themeMode value', async () => {
    const app = createTestApp();
    const res = await putJson(app, '/api/preferences', { themeMode: 'sepia' });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a pageSize that is neither 0 nor >= 5', async () => {
    const app = createTestApp();
    const res = await putJson(app, '/api/preferences', { pageSize: 3 });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── GET /api/projects/:projectId/preferences ────────────────────────────────

describe('GET /api/projects/:projectId/preferences', () => {
  const app = createTestApp();

  it('returns 200 with { data } envelope containing project preferences', async () => {
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/preferences`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { projectId: string } };

    expect(body.data.projectId).toBe(PROJECT_ID);
  });
});

// ─── PATCH /api/projects/:projectId/preferences ──────────────────────────────

describe('PATCH /api/projects/:projectId/preferences (taskTableColumns only — single-board model)', () => {
  it('returns 200 with the updated project preferences', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/preferences`, {
      taskTableColumns: ['key', 'title', 'status'],
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { projectId: string } };

    expect(body.data.projectId).toBe(PROJECT_ID);
  });

  it('returns 200 when clearing taskTableColumns with null', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/preferences`, { taskTableColumns: null });

    expect(res.status).toBe(200);
  });

  // The project id is now validated against the caller's tenant.
  it('returns 404 when the project belongs to another tenant', async () => {
    const app = createTestApp(() => Promise.reject(new NotFoundError('Project not found')));
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/preferences`);

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 on PATCH when the project belongs to another tenant', async () => {
    const app = createTestApp(() => Promise.reject(new NotFoundError('Project not found')));
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/preferences`, { taskTableColumns: null });

    expect(res.status).toBe(404);
  });

  it('returns 400 when no preference field is provided', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/preferences`, {});

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an unknown column key', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/projects/${PROJECT_ID}/preferences`, { taskTableColumns: ['bogus'] });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── Auth (401) ──────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 with error envelope when no Authorization header is present', async () => {
    const app = createAuthTestApp();
    const res = await getJson(app, '/api/preferences');

    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an invalid token', async () => {
    const app = createAuthTestApp();
    const res = await app.request(
      '/api/preferences',
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
      '/api/preferences',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
  });
});
