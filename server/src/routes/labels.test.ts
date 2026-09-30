/**
 * Tests for label HTTP routes.
 *
 * Follows the established route-test pattern (see statuses.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 * - Real `requirePermission` middleware exercises the RBAC matrix (403 paths)
 *
 * The production hijack happened because `POST
 * /projects/:projectId/labels` called `createLabel(projectId, body)` with NO
 * context at all, so the service's `if (!userId || !userRole) return;` guard
 * silently skipped authorization. These tests pin that EVERY route now
 * forwards the full caller context (tenantId + userId + role) taken from the
 * request context — never from the path or the body.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createLabelRoutes } from './labels.js';
import { LabelService } from '../services/label.service.js';
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
const mockLabel = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  projectId: PROJECT_ID,
  name: 'bug',
  color: '#ff0000',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

interface MockLabelService {
  getLabelsByProject: ReturnType<typeof vi.fn>;
  createLabel: ReturnType<typeof vi.fn>;
  updateLabel: ReturnType<typeof vi.fn>;
  deleteLabel: ReturnType<typeof vi.fn>;
}

vi.mock('../services/label.service.js', () => ({
  LabelService: vi.fn().mockImplementation(() => ({
    getLabelsByProject: vi.fn().mockResolvedValue([mockLabel]),
    createLabel: vi.fn().mockResolvedValue(mockLabel),
    updateLabel: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'cccccccc-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Label not found'))
          : Promise.resolve(mockLabel),
      ),
    deleteLabel: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'cccccccc-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Label not found'))
          : Promise.resolve(undefined),
      ),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

/**
 * @param sink receives the service mock instance created for the request, so
 *             the forwarded context can be asserted on.
 */
function createTestApp(tenantRole = 'OWNER', projectRole: string | null = null, sink: { svc?: MockLabelService } = {}) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockLabels = LabelService as unknown as new () => MockLabelService;
    const svc = new MockLabels();

    sink.svc = svc;
    c.set('userId', USER_ID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    c.set('svc', { labels: svc } as never);
    await next();
  });

  app.route('/api', createLabelRoutes());

  return app;
}

async function getJson(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: 'GET' }, TEST_ENV);
}

async function postJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    TEST_ENV,
  );
}

async function patchJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    TEST_ENV,
  );
}

async function deleteJson(app: Hono<AppEnv>, path: string) {
  return app.request(path, { method: 'DELETE' }, TEST_ENV);
}

// ─── Happy paths (envelope / status codes) ───────────────────────────────────

describe('label routes', () => {
  const app = createTestApp();

  it('GET /projects/:projectId/labels returns 200 with the { data } envelope', async () => {
    const res = await getJson(app, `/api/projects/${PROJECT_ID}/labels`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string }[] };

    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]?.id).toBe('cccccccc-0000-4000-8000-000000000001');
  });

  it('POST /projects/:projectId/labels returns 201 for an owner', async () => {
    const res = await postJson(app, `/api/projects/${PROJECT_ID}/labels`, { name: 'Bug' });

    expect(res.status).toBe(201);
  });

  it('POST /projects/:projectId/labels returns 403 for a member without a project role', async () => {
    const res = await postJson(createTestApp('MEMBER', null), `/api/projects/${PROJECT_ID}/labels`, {
      name: 'Bug',
    });

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('PATCH /labels/:labelId returns 404 when the label does not exist', async () => {
    const res = await patchJson(app, '/api/labels/cccccccc-0000-4000-8000-0000000000ff', { name: 'Defect' });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE /labels/:labelId returns 200 with a success envelope', async () => {
    const res = await deleteJson(app, '/api/labels/cccccccc-0000-4000-8000-000000000001');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });
});

// ─── The caller context is always forwarded ──────────────────────────────────

describe('caller context forwarding (M-001/M-006/M-034)', () => {
  const expected = { tenantId: TENANT_ID, userId: USER_ID, userRole: 'OWNER' };
  const memberCtx = { tenantId: TENANT_ID, userId: USER_ID, userRole: 'MEMBER' };

  it('POST /projects/:projectId/labels forwards tenantId + userId + role (the hijack call site)', async () => {
    const sink: { svc?: MockLabelService } = {};
    const res = await postJson(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/labels`, {
      name: 'Bug',
    });

    expect(res.status).toBe(201);
    expect(sink.svc?.createLabel).toHaveBeenCalledWith(PROJECT_ID, { name: 'Bug' }, expected);
  });

  it('GET /projects/:projectId/labels forwards tenantId + userId + role', async () => {
    const sink: { svc?: MockLabelService } = {};

    await getJson(createTestApp('OWNER', null, sink), `/api/projects/${PROJECT_ID}/labels`);

    expect(sink.svc?.getLabelsByProject).toHaveBeenCalledWith(PROJECT_ID, expected);
  });

  it('PATCH /labels/:labelId forwards tenantId + userId + role', async () => {
    const sink: { svc?: MockLabelService } = {};

    await patchJson(
      createTestApp('MEMBER', 'PROJECT_ADMIN', sink),
      '/api/labels/cccccccc-0000-4000-8000-000000000001',
      { name: 'Defect' },
    );

    expect(sink.svc?.updateLabel).toHaveBeenCalledWith(
      'cccccccc-0000-4000-8000-000000000001',
      { name: 'Defect' },
      memberCtx,
    );
  });

  it('DELETE /labels/:labelId forwards tenantId + userId + role', async () => {
    const sink: { svc?: MockLabelService } = {};

    await deleteJson(
      createTestApp('MEMBER', 'PROJECT_ADMIN', sink),
      '/api/labels/cccccccc-0000-4000-8000-000000000001',
    );

    expect(sink.svc?.deleteLabel).toHaveBeenCalledWith('cccccccc-0000-4000-8000-000000000001', memberCtx);
  });

  it('never derives the tenant from the path or the body', async () => {
    const sink: { svc?: MockLabelService } = {};
    const app = createTestApp('OWNER', null, sink);

    // A body that smuggles another tenant id must not reach the service.
    await postJson(app, `/api/projects/${PROJECT_ID}/labels`, {
      name: 'Bug',
      tenantId: OTHER_TENANT_ID,
    });

    const [, , context] = (sink.svc?.createLabel.mock.calls[0] ?? []) as [string, unknown, { tenantId: string }];

    expect(context.tenantId).toBe(TENANT_ID);
  });
});
