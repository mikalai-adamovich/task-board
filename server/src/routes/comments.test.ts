/**
 * Tests for comment HTTP routes.
 *
 * Follows the established route-test pattern (see labels.test.ts):
 * - `vi.mock` for the service layer
 * - `createTestApp()` injects a fake `svc` via middleware
 *
 * The create route used to build its own audit context
 * (`{ tenantId, projectId }`) and pass `userRole` as an OPTIONAL trailing
 * argument, so the service's `if (userRole) { …ensurePermission… }` guard could
 * be skipped entirely. These tests pin that every comment route now forwards
 * the single required caller context, and that the route no longer resolves the
 * task itself (the service derives the tenant/project from the asserted task).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { COMMENT_PAGE_SIZE, encodeCommentCursor } from '@task-board/shared';
import { createCommentRoutes } from './comments.js';
import { CommentService } from '../services/comment.service.js';
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
const TASK_ID = '550e8400-e29b-41d4-a716-446655440020';
const COMMENT_ID = '550e8400-e29b-41d4-a716-446655440050';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const mockComment = {
  id: COMMENT_ID,
  taskId: TASK_ID,
  authorId: USER_ID,
  authorSnapshot: { displayName: 'Author' },
  body: 'Hello',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
/** One page of the thread, as `CommentService` now returns it. */
const mockCommentPage = {
  comments: [mockComment],
  hasMore: true,
  nextCursor: encodeCommentCursor({ createdAtMs: Date.parse(mockComment.createdAt), objectId: 'b'.repeat(24) }),
  limit: COMMENT_PAGE_SIZE,
};

interface MockCommentService {
  getCommentsByTask: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  updateComment: ReturnType<typeof vi.fn>;
  deleteComment: ReturnType<typeof vi.fn>;
}

vi.mock('../services/comment.service.js', () => ({
  CommentService: vi.fn().mockImplementation(() => ({
    getCommentsByTask: vi.fn().mockResolvedValue(mockCommentPage),
    createComment: vi.fn().mockResolvedValue(mockComment),
    updateComment: vi
      .fn()
      .mockImplementation((id: string) =>
        id === 'ffffffff-0000-4000-8000-0000000000ff'
          ? Promise.reject(new NotFoundError('Comment not found'))
          : Promise.resolve(mockComment),
      ),
    deleteComment: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

function createTestApp(
  tenantRole = 'OWNER',
  projectRole: string | null = null,
  sink: { svc?: MockCommentService } = {},
) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockComments = CommentService as unknown as new () => MockCommentService;
    const svc = new MockComments();

    sink.svc = svc;
    c.set('userId', USER_ID);
    c.set('tenantId', TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('projectRole', projectRole as never);
    // The task routes resolve `:taskId` through the shared task-service
    // resolver before the comment service sees it, so the graph carries both.
    c.set('svc', { comments: svc, tasks: createMockTaskResolver() } as never);
    await next();
  });

  app.route('/api', createCommentRoutes());

  return app;
}

/**
 * Models `TaskService.resolveTaskId`: a bare id passes through, `KEY-NUMBER`
 * resolves to the task. A comment route that skipped the resolver would hand the
 * comment service the literal `PRO-1`, which the assertions below would catch.
 */
function createMockTaskResolver() {
  return {
    resolveTaskId: vi
      .fn()
      .mockImplementation((ref: string) =>
        /^[A-Z][A-Z0-9]*-[0-9]{1,10}$/.test(ref) ? Promise.resolve(TASK_ID) : Promise.resolve(ref),
      ),
  };
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

  it('GET /tasks/:taskId/comments forwards tenantId + userId + role with the page window', async () => {
    const sink: { svc?: MockCommentService } = {};

    await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}/comments`, 'GET');

    // The page window travels with the context: the service is handed what the
    // query validated, and never reads a bound from the URL itself.
    expect(sink.svc?.getCommentsByTask).toHaveBeenCalledWith(
      TASK_ID,
      { limit: COMMENT_PAGE_SIZE, cursor: undefined },
      expected,
    );
  });

  it('POST /tasks/:taskId/comments forwards the context as ONE argument (no optional trailing userRole)', async () => {
    const sink: { svc?: MockCommentService } = {};
    const res = await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}/comments`, 'POST', {
      body: 'Hello',
    });

    expect(res.status).toBe(201);
    expect(sink.svc?.createComment).toHaveBeenCalledWith(TASK_ID, { body: 'Hello' }, expected);
  });

  it('PATCH /comments/:commentId forwards the context', async () => {
    const sink: { svc?: MockCommentService } = {};
    const res = await request(createTestApp('OWNER', null, sink), `/api/comments/${COMMENT_ID}`, 'PATCH', {
      body: 'Edited',
    });

    expect(res.status).toBe(200);
    expect(sink.svc?.updateComment).toHaveBeenCalledWith(COMMENT_ID, { body: 'Edited' }, expected);
  });

  it('DELETE /comments/:commentId forwards the context', async () => {
    const sink: { svc?: MockCommentService } = {};
    const res = await request(createTestApp('OWNER', null, sink), `/api/comments/${COMMENT_ID}`, 'DELETE');

    expect(res.status).toBe(200);
    expect(sink.svc?.deleteComment).toHaveBeenCalledWith(COMMENT_ID, expected);
  });

  it('never derives the tenant from the path or the body', async () => {
    const sink: { svc?: MockCommentService } = {};
    const app = createTestApp('OWNER', null, sink);

    await request(app, `/api/tasks/${TASK_ID}/comments`, 'POST', { body: 'Hello', tenantId: OTHER_TENANT_ID });

    const [, , context] = (sink.svc?.createComment.mock.calls[0] ?? []) as [string, unknown, { tenantId: string }];

    expect(context.tenantId).toBe(TENANT_ID);
  });

  it('propagates the role verbatim, so the service gate cannot be bypassed by a missing role', async () => {
    const sink: { svc?: MockCommentService } = {};

    await request(createTestApp('MEMBER', 'EDITOR', sink), `/api/comments/${COMMENT_ID}`, 'DELETE');

    expect(sink.svc?.deleteComment).toHaveBeenCalledWith(COMMENT_ID, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      userRole: 'MEMBER',
    });
  });
});

// ─── Happy paths (envelope / status codes) ───────────────────────────────────

describe('comment routes', () => {
  const app = createTestApp();

  it('GET /tasks/:taskId/comments returns 200 with the { data, pagination } envelope', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/comments`, 'GET');

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { id: string }[];
      pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
    };

    expect(body.data[0]?.id).toBe(COMMENT_ID);
    expect(body.pagination).toEqual({
      limit: COMMENT_PAGE_SIZE,
      hasMore: true,
      nextCursor: mockCommentPage.nextCursor,
    });
  });

  it('GET /tasks/:taskId/comments decodes the cursor before the service sees it', async () => {
    const sink: { svc?: MockCommentService } = {};
    const cursor = encodeCommentCursor({ createdAtMs: 1_781_234_567_890, objectId: 'c'.repeat(24) });

    await request(createTestApp('OWNER', null, sink), `/api/tasks/${TASK_ID}/comments?cursor=${cursor}`, 'GET');

    expect(sink.svc?.getCommentsByTask).toHaveBeenCalledWith(
      TASK_ID,
      { limit: COMMENT_PAGE_SIZE, cursor: { createdAtMs: 1_781_234_567_890, objectId: 'c'.repeat(24) } },
      { tenantId: TENANT_ID, userId: USER_ID, userRole: 'OWNER' },
    );
  });

  it('GET /tasks/:taskId/comments returns 400 VALIDATION_ERROR for a malformed cursor', async () => {
    // A tampered query parameter is a client error, not a server fault: the
    // standard envelope, never a 500 from a decode that threw.
    const res = await request(app, `/api/tasks/${TASK_ID}/comments?cursor=not-a-cursor%21%21`, 'GET');

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('cursor');
  });

  it('GET /tasks/:taskId/comments returns 400 when the page size is above the maximum', async () => {
    // Rejected rather than silently capped, for the same reason the task list
    // rejects `limit > 200`: a capped response disagrees with the request, and
    // the client cannot tell it from a genuinely short page.
    const res = await request(app, `/api/tasks/${TASK_ID}/comments?limit=${COMMENT_PAGE_SIZE + 1}`, 'GET');

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string; details?: { path?: string }[] } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body.error.details)).toContain(String(COMMENT_PAGE_SIZE));
  });

  it('GET /tasks/:taskId/comments accepts the maximum page size and a smaller one', async () => {
    // One app per request: the graph is built per request, so the sink of the
    // second request is a different service instance than the first one's.
    const atMax: { svc?: MockCommentService } = {};
    const belowMax: { svc?: MockCommentService } = {};

    await request(
      createTestApp('OWNER', null, atMax),
      `/api/tasks/${TASK_ID}/comments?limit=${COMMENT_PAGE_SIZE}`,
      'GET',
    );
    await request(createTestApp('OWNER', null, belowMax), `/api/tasks/${TASK_ID}/comments?limit=5`, 'GET');

    expect(atMax.svc?.getCommentsByTask).toHaveBeenCalledWith(
      TASK_ID,
      { limit: COMMENT_PAGE_SIZE, cursor: undefined },
      expect.anything(),
    );
    expect(belowMax.svc?.getCommentsByTask).toHaveBeenCalledWith(
      TASK_ID,
      { limit: 5, cursor: undefined },
      expect.anything(),
    );
  });

  it('GET /tasks/:taskId/comments returns 400 for a non-numeric or zero page size', async () => {
    expect((await request(app, `/api/tasks/${TASK_ID}/comments?limit=abc`, 'GET')).status).toBe(400);
    expect((await request(app, `/api/tasks/${TASK_ID}/comments?limit=0`, 'GET')).status).toBe(400);
    expect((await request(app, `/api/tasks/${TASK_ID}/comments?limit=-1`, 'GET')).status).toBe(400);
  });

  it('POST /tasks/:taskId/comments returns 201', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/comments`, 'POST', { body: 'Hello' });

    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe(COMMENT_ID);
  });

  it('POST /tasks/:taskId/comments returns 400 for an empty body (Zod validation)', async () => {
    const res = await request(app, `/api/tasks/${TASK_ID}/comments`, 'POST', { body: '' });

    expect(res.status).toBe(400);
  });

  it('PATCH /comments/:commentId returns 404 for a nonexistent comment', async () => {
    const res = await request(app, '/api/comments/ffffffff-0000-4000-8000-0000000000ff', 'PATCH', { body: 'Edited' });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE /comments/:commentId returns 200 with a success envelope', async () => {
    const res = await request(app, `/api/comments/${COMMENT_ID}`, 'DELETE');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { success: boolean } };

    expect(body.data.success).toBe(true);
  });
});
