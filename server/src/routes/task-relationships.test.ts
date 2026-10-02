/**
 * Tests for task-relationship HTTP routes.
 *
 * Follows the established route-test pattern (see labels.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 *
 * The routes used to pass a separate `userId` + `userRole`
 * pair, and the service's `if (!userId || !userRole) return;` guard silently
 * skipped `manage_task_relationships` whenever a call site forwarded nothing.
 * These tests pin that every relationship route now forwards the single
 * required caller context.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTaskRelationshipRoutes } from './task-relationships.js';
import { TaskRelationshipService } from '../services/task-relationship.service.js';
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
const TARGET_TASK_ID = '550e8400-e29b-41d4-a716-446655440021';
const RELATIONSHIP_ID = '550e8400-e29b-41d4-a716-446655440060';
const mockRelationship = {
  id: RELATIONSHIP_ID,
  projectId: PROJECT_ID,
  sourceTaskId: TASK_ID,
  targetTaskId: TARGET_TASK_ID,
  type: 'BLOCKS',
  createdById: USER_ID,
  createdAt: '2025-01-01T00:00:00.000Z',
};

interface MockRelationshipService {
  getRelationshipsByTask: ReturnType<typeof vi.fn>;
  createRelationship: ReturnType<typeof vi.fn>;
  deleteRelationship: ReturnType<typeof vi.fn>;
}

vi.mock('../services/task-relationship.service.js', () => ({
  TaskRelationshipService: vi.fn().mockImplementation(() => ({
    getRelationshipsByTask: vi.fn().mockResolvedValue([mockRelationship]),
    createRelationship: vi.fn().mockResolvedValue(mockRelationship),
    deleteRelationship: vi
      .fn()
      .mockImplementation((id: string) =>
        id === '99999999-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Task relationship not found'))
          : Promise.resolve(undefined),
      ),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

/** Models `TaskService.resolveTaskId` — a bare id passes through unchanged. */
function createMockTaskResolver() {
  return { resolveTaskId: vi.fn().mockImplementation((ref: string) => Promise.resolve(ref)) };
}

function createTestApp(
  tenantRole = 'OWNER',
  projectRole: string | null = null,
  sink: { svc?: MockRelationshipService } = {},
) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockRelationships = TaskRelationshipService as unknown as new () => MockRelationshipService;
    const svc = new MockRelationships();

    sink.svc = svc;
    c.set('userId', USER_ID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    // The `:taskId` is resolved through the shared task-service resolver before
    // the relationship service sees it, so the graph carries both.
    c.set('svc', { relationships: svc, tasks: createMockTaskResolver() } as never);
    await next();
  });

  app.route('/api', createTaskRelationshipRoutes());

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

// ─── The caller context is always forwarded ──────────────────────────────────

describe('caller context forwarding (M-001/M-006/M-034)', () => {
  const expected = { tenantId: TENANT_ID, userId: USER_ID, userRole: 'OWNER' };

  it('GET /tasks/:taskId/relationships forwards tenantId + userId + role', async () => {
    const sink: { svc?: MockRelationshipService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}/relationships`, 'GET');

    expect(sink.svc?.getRelationshipsByTask).toHaveBeenCalledWith(TASK_ID, expected);
  });

  it('POST /tasks/:taskId/relationships forwards the context (no separate userId arg)', async () => {
    const sink: { svc?: MockRelationshipService } = {};
    const body = { targetTaskId: TARGET_TASK_ID, type: 'BLOCKS' };
    const res = await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}/relationships`, 'POST', body);

    expect(res.status).toBe(201);
    expect(sink.svc?.createRelationship).toHaveBeenCalledWith(TASK_ID, body, expected);
  });

  it('DELETE /task-relationships/:relationshipId forwards the context', async () => {
    const sink: { svc?: MockRelationshipService } = {};
    const res = await request(
      createTestApp('OWNER', null, sink),
      `/api/task-relationships/${RELATIONSHIP_ID}`,
      'DELETE',
    );

    expect(res.status).toBe(200);
    expect(sink.svc?.deleteRelationship).toHaveBeenCalledWith(RELATIONSHIP_ID, expected);
  });

  it('never derives the tenant from the path or the body', async () => {
    const sink: { svc?: MockRelationshipService } = {};
    const app = createTestApp('OWNER', null, sink);

    await request(app, `/api/tasks/${TASK_ID}/relationships`, 'POST', {
      targetTaskId: TARGET_TASK_ID,
      type: 'BLOCKS',
      tenantId: OTHER_TENANT_ID,
    });

    const [, , context] = (sink.svc?.createRelationship.mock.calls[0] ?? []) as [string, unknown, { tenantId: string }];

    expect(context.tenantId).toBe(TENANT_ID);
  });

  it('propagates the role verbatim, so the service gate cannot be bypassed by a missing role', async () => {
    const sink: { svc?: MockRelationshipService } = {};

    await request(createTestApp('MEMBER', 'EDITOR', sink), `/api/task-relationships/${RELATIONSHIP_ID}`, 'DELETE');

    expect(sink.svc?.deleteRelationship).toHaveBeenCalledWith(RELATIONSHIP_ID, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      userRole: 'MEMBER',
    });
  });
});

// ─── Happy paths (envelope / status codes) ───────────────────────────────────

describe('task relationship routes', () => {
  const app = createTestApp();

  it('GET /tasks/:taskId/relationships returns 200 with the { data } envelope', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/relationships`, 'GET');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string }[] };

    expect(body.data[0]?.id).toBe(RELATIONSHIP_ID);
  });

  it('POST /tasks/:taskId/relationships returns 201', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/relationships`, 'POST', {
      targetTaskId: TARGET_TASK_ID,
      type: 'BLOCKS',
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe(RELATIONSHIP_ID);
  });

  it('POST /tasks/:taskId/relationships returns 400 for a self-relationship body shape', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/relationships`, 'POST', { targetTaskId: '', type: 'NOPE' });

    expect(res.status).toBe(400);
  });

  it('DELETE /task-relationships/:relationshipId returns 404 for a nonexistent relationship', async () => {
    const res = await request(app, '/api/task-relationships/99999999-0000-4000-8000-0000000000ff', 'DELETE');

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE /task-relationships/:relationshipId returns 200 with a success envelope', async () => {
    const res = await request(app, `/api/task-relationships/${RELATIONSHIP_ID}`, 'DELETE');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });
});
