/**
 * V2-4 integration tests — project RBAC enforcement through the real
 * production middleware chain:
 *
 *   auth stub → services stub → tenantContextMiddleware (resolves projectRole)
 *   → requirePermission route guards → thin handlers
 *
 * MongoDB collections are mocked at the driver boundary so the middleware's
 * membership lookups run against configurable fixtures while every other layer
 * (RBAC matrix, guards, validation, envelope) is the real production code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tenantContextMiddleware } from '../middleware/tenant-context.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTaskRoutes } from './tasks.js';
import { createStatusRoutes } from './statuses.js';
import type { AppEnv } from '../types/context.js';
import type { Services } from '../container.js';

// ─── Driver-level collection mocks (configured per test) ─────────────────────

const mockCollections: Record<string, { findOne: ReturnType<typeof vi.fn> }> = {};

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn((name: string) => {
    if (!mockCollections[name]) {
      throw new Error(`Unexpected collection access in test: ${name}`);
    }
    return mockCollections[name];
  }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER_ID = 'user-1';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TYPE_ID = '22222222-2222-4222-8222-222222222222';
const STATUS_ID = '33333333-3333-4333-8333-333333333333';

function setupMemberships(tenantRole: string, projectRole?: string | null) {
  mockCollections['tenant_members'] = {
    findOne: vi.fn().mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID, role: tenantRole, status: 'ACTIVE' }),
  };
  // Slug fallback lookup — not hit when the raw value matches a membership id.
  mockCollections['tenants'] = { findOne: vi.fn().mockResolvedValue(null) };
  mockCollections['project_members'] = {
    findOne: vi
      .fn()
      .mockResolvedValue(
        projectRole === null || projectRole === undefined
          ? null
          : { userId: USER_ID, projectId: PROJECT_ID, role: projectRole },
      ),
  };
}

function buildApp(svcOverrides: Record<string, unknown>) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use('/api/*', async (c, next) => {
    c.set('userId', USER_ID);
    await next();
  });
  app.use('/api/*', async (c, next) => {
    c.set('svc', svcOverrides as unknown as Services);
    await next();
  });

  // Mirror index.ts: tenant-scoped sub-app with tenantContextMiddleware only.
  const tenantScoped = new Hono<AppEnv>();

  tenantScoped.use('*', tenantContextMiddleware);
  tenantScoped.route('/', createTaskRoutes());
  tenantScoped.route('/', createStatusRoutes());
  app.route('/api', tenantScoped);

  return app;
}

const CREATE_TASK_BODY = {
  typeId: TYPE_ID,
  statusId: STATUS_ID,
  title: 'New task',
  priorityLevel: 1,
};
const CREATE_STATUS_BODY = { name: 'In Review', position: 5 };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Project RBAC enforcement (V2-4)', () => {
  let svc: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = {
      tasks: { createTask: vi.fn().mockResolvedValue({ id: 'task-1' }) },
      statuses: { createStatus: vi.fn().mockResolvedValue({ id: 'status-new' }) },
    };
  });

  it('VIEWER cannot create a task (403 before validation)', async () => {
    setupMemberships('MEMBER', 'VIEWER');

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_TASK_BODY),
    });

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('FORBIDDEN');
    expect((svc.tasks as { createTask: ReturnType<typeof vi.fn> }).createTask).not.toHaveBeenCalled();
  });

  it('EDITOR can create a task — projectRole resolved by middleware reaches the handler', async () => {
    setupMemberships('MEMBER', 'EDITOR');

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_TASK_BODY),
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe('task-1');
    // The route now forwards the single required caller
    // context object instead of loose userId/role/projectRole arguments. The
    // projectRole is resolved server-side inside the service (fine-grained
    // re-check); the coarse gate above still runs in the middleware.
    expect((svc.tasks as { createTask: ReturnType<typeof vi.fn> }).createTask).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ title: 'New task' }),
      { tenantId: TENANT_ID, userId: USER_ID, userRole: 'MEMBER' },
    );
  });

  it('a tenant MEMBER without a project role cannot create a task', async () => {
    setupMemberships('MEMBER', null);

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_TASK_BODY),
    });

    expect(res.status).toBe(403);
    expect((svc.tasks as { createTask: ReturnType<typeof vi.fn> }).createTask).not.toHaveBeenCalled();
  });

  it('EDITOR cannot manage statuses (403)', async () => {
    setupMemberships('MEMBER', 'EDITOR');

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_STATUS_BODY),
    });

    expect(res.status).toBe(403);
    expect((svc.statuses as { createStatus: ReturnType<typeof vi.fn> }).createStatus).not.toHaveBeenCalled();
  });

  it('PROJECT_ADMIN can manage statuses (200/201)', async () => {
    setupMemberships('MEMBER', 'PROJECT_ADMIN');

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_STATUS_BODY),
    });

    expect(res.status).toBe(201);
    // The service always receives the full caller context
    // (tenant + actor + role) — it is a required argument, never derived from
    // the path/body, so a foreign tenant id can never be smuggled in.
    expect((svc.statuses as { createStatus: ReturnType<typeof vi.fn> }).createStatus).toHaveBeenCalledWith(
      PROJECT_ID,
      CREATE_STATUS_BODY,
      { tenantId: TENANT_ID, userId: USER_ID, userRole: 'MEMBER' },
    );
  });

  it('tenant ADMIN bypasses project-level checks even without a project role', async () => {
    setupMemberships('ADMIN', null);

    const app = buildApp(svc);
    const res = await app.request(`/api/projects/${PROJECT_ID}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
      body: JSON.stringify(CREATE_STATUS_BODY),
    });

    expect(res.status).toBe(201);
    expect(mockCollections['project_members']?.findOne).not.toHaveBeenCalled();
  });
});
