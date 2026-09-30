/**
 * Path parameter rejection tests.
 *
 * Proves the fix at the HTTP boundary, per route group, for the shapes the
 * defect report named: not-a-UUID, empty, over-long, wrong charset, and a
 * NoSQL operator payload (`$ne` / `$gt`) in both raw and percent-encoded form.
 * Also proves the "not everything is a UUID" case: `key` (a project key) and
 * `token` (an opaque invitation token) have their own schemas and still work.
 *
 * These tests mount the REAL route factories (so the real
 * `pathParamValidation()` middleware runs) with a fake `svc` injected the same
 * way the sibling specs do it, and assert the standard envelope:
 *   400 { error: { code: 'VALIDATION_ERROR', message, details, requestId } }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createProjectRoutes } from './projects.js';
import { createTaskRoutes } from './tasks.js';
import { createTenantRoutes } from './tenants.js';
import { createAuthRoutes } from './auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import type { AppEnv } from '../types/context.js';

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({})),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440020';
/** 32-byte hex, as produced by `randomBytes(32).toString('hex')`. */
const INVITATION_TOKEN = 'a'.repeat(64);
const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

interface ErrorEnvelope {
  error: { code: string; message: string; details?: { path: string; message: string }[]; requestId?: string };
}

/** Every service method the handlers below can reach; all resolve harmlessly. */
function createSvc() {
  return {
    projects: {
      getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
      getProjectByKey: vi.fn().mockResolvedValue({ id: PROJECT_ID, key: 'PROJ' }),
      listProjects: vi.fn().mockResolvedValue([]),
      getProjectMembers: vi.fn().mockResolvedValue([]),
      removeMember: vi.fn().mockResolvedValue(undefined),
    },
    tasks: {
      getTasksByProject: vi
        .fn()
        .mockResolvedValue({ data: [], pagination: { page: 1, limit: 30, total: 0, totalPages: 0 } }),
      getTask: vi.fn().mockResolvedValue({ id: TASK_ID }),
      getTaskByKey: vi.fn().mockResolvedValue({ id: TASK_ID }),
    },
    tenants: {
      getTenantForUser: vi.fn().mockResolvedValue({ id: TENANT_ID }),
      isSlugAvailable: vi.fn().mockResolvedValue(true),
    },
    tenantMembers: { getTenantMembers: vi.fn().mockResolvedValue([]) },
    auth: { getInvitationDetails: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
  };
}

/** Mount a real route factory behind the real error handler + request id. */
function createTestApp(factory: () => Hono<AppEnv>, prefix: string) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use('*', requestIdMiddleware);
  app.use('*', async (c, next) => {
    c.set('svc', createSvc() as never);
    c.set('userId', USER_ID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', 'OWNER' as never);
    await next();
  });
  app.route(prefix, factory());

  return app;
}

const projectsApp = () => createTestApp(createProjectRoutes, '/api/projects');
const tasksApp = () => createTestApp(createTaskRoutes, '/api');
const tenantsApp = () => createTestApp(createTenantRoutes, '/api/tenants');
const authApp = () => createTestApp(createAuthRoutes, '/api/auth');

/** Assert the standard envelope and return it. */
async function expectValidationError(res: Response, param: string): Promise<ErrorEnvelope> {
  expect(res.status).toBe(400);

  const body = (await res.json()) as ErrorEnvelope;

  expect(body.error.code).toBe('VALIDATION_ERROR');
  expect(body.error.message).toBe('Path parameter validation failed');
  // A correlation id rides on every error envelope.
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId).not.toBe('');
  expect(body.error.details?.map((d) => d.path)).toContain(param);

  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('F9 path parameter validation — project-scoped route', () => {
  const app = projectsApp();

  it('rejects a non-UUID projectId with 400 + the standard envelope', async () => {
    const res = await app.request(`/api/projects/not-a-uuid`, {}, TEST_ENV);

    await expectValidationError(res, 'projectId');
  });

  it('rejects an over-long projectId (512 chars)', async () => {
    const res = await app.request(`/api/projects/${'a'.repeat(512)}`, {}, TEST_ENV);

    await expectValidationError(res, 'projectId');
  });

  it('rejects a wrong-charset projectId (underscores / dots / spaces)', async () => {
    for (const bad of ['has_underscore', 'has.dot', 'has space', '../../etc/passwd']) {
      const res = await app.request(`/api/projects/${encodeURIComponent(bad)}`, {}, TEST_ENV);

      await expectValidationError(res, 'projectId');
    }
  });

  it('rejects a NoSQL operator payload, raw and percent-encoded', async () => {
    // Raw `$ne` — the classic `{ _id: { $ne: null } }` injection probe.
    const raw = await app.request(`/api/projects/$ne`, {}, TEST_ENV);

    await expectValidationError(raw, 'projectId');

    // Percent-encoded, so the middleware must decode before validating.
    const encoded = await app.request(`/api/projects/${encodeURIComponent('$gt')}`, {}, TEST_ENV);

    await expectValidationError(encoded, 'projectId');
  });

  it('accepts a valid UUID projectId and reaches the service', async () => {
    const local = projectsApp();
    const res = await local.request(`/api/projects/${PROJECT_ID}`, {}, TEST_ENV);

    expect(res.status).toBe(200);
  });

  it('validates the memberUserId of a nested member route', async () => {
    const res = await app.request(`/api/projects/${PROJECT_ID}/members/not-a-uuid`, { method: 'DELETE' }, TEST_ENV);

    await expectValidationError(res, 'memberUserId');
  });

  it('validates BOTH parameters of a two-parameter route', async () => {
    const res = await app.request(`/api/projects/bad/members/alsoBad`, { method: 'DELETE' }, TEST_ENV);
    const body = await expectValidationError(res, 'projectId');

    expect(body.error.details?.map((d) => d.path).sort()).toEqual(['memberUserId', 'projectId']);
  });

  it('accepts both parameters of the two-parameter route when both are valid', async () => {
    const local = projectsApp();
    const res = await local.request(`/api/projects/${PROJECT_ID}/members/${USER_ID}`, { method: 'DELETE' }, TEST_ENV);

    expect(res.status).toBe(200);
  });
});

describe('F9 path parameter validation — task-scoped route', () => {
  const app = tasksApp();

  it('rejects a non-UUID taskId with 400 + the standard envelope', async () => {
    const res = await app.request('/api/tasks/not-a-uuid', {}, TEST_ENV);

    await expectValidationError(res, 'taskId');
  });

  it('rejects a NoSQL operator payload in taskId', async () => {
    const res = await app.request(`/api/tasks/${encodeURIComponent('$ne')}`, {}, TEST_ENV);

    await expectValidationError(res, 'taskId');
  });

  it('accepts a UUID taskId', async () => {
    const local = tasksApp();
    const res = await local.request(`/api/tasks/${TASK_ID}`, {}, TEST_ENV);

    expect(res.status).toBe(200);
  });

  it('still accepts the documented KEY-NUMBER alias (PRO-1) — not everything is a UUID', async () => {
    const local = tasksApp();
    const res = await local.request('/api/tasks/PRO-1', {}, TEST_ENV);

    expect(res.status).toBe(200);
  });

  it('rejects a malformed KEY-NUMBER alias (lowercase key)', async () => {
    const res = await app.request('/api/tasks/pro-1', {}, TEST_ENV);

    await expectValidationError(res, 'taskId');
  });

  it('rejects a non-UUID projectId on a project-scoped task route', async () => {
    const res = await app.request('/api/projects/not-a-uuid/tasks', {}, TEST_ENV);

    await expectValidationError(res, 'projectId');
  });
});

describe('F9 path parameter validation — tenant-scoped route', () => {
  const app = tenantsApp();

  it('rejects a non-UUID tenantId with 400 + the standard envelope', async () => {
    const res = await app.request('/api/tenants/not-a-uuid', {}, TEST_ENV);

    await expectValidationError(res, 'tenantId');
  });

  it('rejects an over-long tenantId', async () => {
    const res = await app.request(`/api/tenants/${'0'.repeat(300)}`, {}, TEST_ENV);

    await expectValidationError(res, 'tenantId');
  });

  it('accepts a valid UUID tenantId', async () => {
    const local = tenantsApp();
    const res = await local.request(`/api/tenants/${TENANT_ID}`, {}, TEST_ENV);

    expect(res.status).toBe(200);
  });

  it('leaves the param-free /slug-available route untouched (no :param declared)', async () => {
    const local = tenantsApp();
    const res = await local.request('/api/tenants/slug-available?slug=acme', {}, TEST_ENV);

    // Reaches the handler (which has no slug param); the stub has no such
    // method, so a 500 proves validation did NOT reject the request first.
    expect(res.status).not.toBe(400);
  });
});

describe('F9 path parameter validation — non-UUID parameters (key / token)', () => {
  it('accepts a valid project key and rejects a malformed one', async () => {
    const app = projectsApp();
    const ok = await app.request('/api/projects/by-key/PROJ', {}, TEST_ENV);

    expect(ok.status).toBe(200);

    // Lowercase, too long, and a NoSQL payload must all be rejected — the key
    // has its own schema, it is NOT forced through uuid().
    for (const bad of ['proj', 'A'.repeat(11), encodeURIComponent('$ne')]) {
      const res = await app.request(`/api/projects/by-key/${bad}`, {}, TEST_ENV);

      await expectValidationError(res, 'key');
    }
  });

  it('accepts an opaque 64-hex invitation token and rejects a malformed one', async () => {
    const app = authApp();
    const ok = await app.request(`/api/auth/invitations/${INVITATION_TOKEN}`, {}, TEST_ENV);

    expect(ok.status).toBe(200);

    for (const bad of ['short', 'a'.repeat(200), encodeURIComponent('$ne'), 'has.dot', 'has space']) {
      const res = await app.request(`/api/auth/invitations/${bad}`, {}, TEST_ENV);

      await expectValidationError(res, 'token');
    }
  });
});

describe('F9 path parameter validation — unmatched routes are not affected', () => {
  it('an unknown path still 404s (NOT_FOUND), it is not turned into a 400', async () => {
    const app = projectsApp();
    const res = await app.request('/api/projects/a/b/c/d', {}, TEST_ENV);

    expect(res.status).toBe(404);
  });
});
