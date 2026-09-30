import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tenantContextMiddleware } from './tenant-context.js';
import { errorHandler } from './error-handler.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockMemberFindOne = vi.fn();
const mockMemberUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockTenantFindOne = vi.fn();
const mockProjectMemberFindOne = vi.fn();

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn((name: string) => {
    if (name === 'tenants') return { findOne: mockTenantFindOne };
    if (name === 'project_members') return { findOne: mockProjectMemberFindOne };

    return { findOne: mockMemberFindOne, updateOne: mockMemberUpdateOne };
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  // Simulate auth middleware setting userId
  app.use('/tenant-protected/*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.use('/tenant-protected/*', tenantContextMiddleware);

  app.get('/tenant-protected/resource', (c) => {
    return c.json({
      tenantId: c.get('tenantId'),
      tenantRole: c.get('tenantRole'),
    });
  });

  return app;
}

function createTestAppWithoutAuth() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use('/tenant-protected/*', tenantContextMiddleware);

  app.get('/tenant-protected/resource', (c) => {
    return c.json({ tenantId: c.get('tenantId') });
  });

  return app;
}

const TEST_ENV = {
  JWT_SECRET: 'test-secret',
  MONGODB_URI: 'mongodb://localhost:27017/test',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tenantContextMiddleware', () => {
  beforeEach(() => {
    mockMemberFindOne.mockReset();
    mockTenantFindOne.mockReset();
    mockProjectMemberFindOne.mockReset();
    mockMemberUpdateOne.mockClear();
  });

  // ── Resolution by slug (backward compatible with id) ─────────────────────

  it('resolves the tenant context by slug when the header value is not a tenant id', async () => {
    mockMemberFindOne
      .mockResolvedValueOnce(null) // no membership for the raw value
      .mockResolvedValueOnce({ userId: 'user-1', tenantId: 'tenant-1', role: 'MEMBER', status: 'ACTIVE' });
    mockTenantFindOne.mockResolvedValue({ id: 'tenant-1', slug: 'my-workspace' });

    const app = createTestApp();
    const res = await app.request(
      '/tenant-protected/resource',
      { headers: { 'X-Tenant-Id': 'my-workspace' } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as { tenantId: string; tenantRole: string };

    expect(body.tenantId).toBe('tenant-1');
    expect(body.tenantRole).toBe('MEMBER');
    expect(mockMemberFindOne).toHaveBeenNthCalledWith(2, { userId: 'user-1', tenantId: 'tenant-1' });
  });

  it('returns 403 when the slug resolves to a tenant the user is not a member of', async () => {
    mockMemberFindOne.mockResolvedValue(null);
    mockTenantFindOne.mockResolvedValue({ id: 'tenant-9', slug: 'other-workspace' });

    const app = createTestApp();
    const res = await app.request(
      '/tenant-protected/resource',
      { headers: { 'X-Tenant-Id': 'other-workspace' } },
      TEST_ENV,
    );

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('You are not a member of this tenant');
  });

  it('does not query tenants by slug when the id path matches a membership (backward compatible)', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'OWNER',
      status: 'ACTIVE',
    });

    const app = createTestApp();
    const res = await app.request(
      '/tenant-protected/resource',
      { headers: { 'X-Tenant-Id': '550e8400-e29b-41d4-a716-446655440000' } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(mockTenantFindOne).not.toHaveBeenCalled();
  });

  it('S-14: probes the raw value and resolves the slug concurrently on the slug path', async () => {
    mockMemberFindOne
      .mockResolvedValueOnce(null) // raw-value probe misses
      .mockResolvedValueOnce({ userId: 'user-1', tenantId: 'tenant-1', role: 'MEMBER', status: 'ACTIVE' });
    mockTenantFindOne.mockResolvedValue({ id: 'tenant-1', slug: 'my-workspace' });

    const app = createTestApp();
    const res = await app.request(
      '/tenant-protected/resource',
      { headers: { 'X-Tenant-Id': 'my-workspace' } },
      TEST_ENV,
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as { tenantId: string };

    expect(body.tenantId).toBe('tenant-1');
    // both the raw-value membership probe and the slug lookup fired (in parallel)
    expect(mockMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', tenantId: 'my-workspace' });
    expect(mockTenantFindOne).toHaveBeenCalledWith({ slug: 'my-workspace' });
    // membership is still verified against the resolved tenant id
    expect(mockMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', tenantId: 'tenant-1' });
  });

  it('returns 403 when neither an id nor a slug matches', async () => {
    mockMemberFindOne.mockResolvedValue(null);
    mockTenantFindOne.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'nope' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string } };

    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 when X-Tenant-Id header is missing', async () => {
    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', {}, TEST_ENV);

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.message).toBe('Missing X-Tenant-Id header');
  });

  it('returns 403 when userId is not set (no auth)', async () => {
    const app = createTestAppWithoutAuth();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('Authentication required for tenant context');
  });

  it('returns 403 when user is not a member of the tenant', async () => {
    mockMemberFindOne.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('You are not a member of this tenant');
  });

  it('returns 403 when membership status is ACCESS_REVOKED', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'ACCESS_REVOKED',
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('Your access to this tenant has been revoked');
  });

  // An ACTIVE membership past its expiresAt is treated as revoked at
  // access time (lazy evaluation) and the stored status is flipped.
  it('returns 403 for an ACTIVE membership whose expiresAt has passed and flips the stored status', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000),
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('Your membership has expired');
    expect(mockMemberUpdateOne).toHaveBeenCalledWith(
      { userId: 'user-1', tenantId: 'tenant-1' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'ACCESS_REVOKED' }) }),
    );
  });

  it('allows an ACTIVE membership whose expiresAt is in the future', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(200);
    expect(mockMemberUpdateOne).not.toHaveBeenCalled();
  });

  // An invited-but-unaccepted member is stored as ACCESS_REVOKED + invitation PENDING;
  // the status gate alone must block them — no special-casing of "ACTIVE but pending invitation".
  it('blocks a member whose invitation is still PENDING (status ACCESS_REVOKED)', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'ACCESS_REVOKED',
      invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when membership status is unknown/non-active', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'disabled',
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toBe('Your membership is not active');
  });

  it('sets tenantId and tenantRole for ACTIVE membership', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { tenantId: string; tenantRole: string };

    expect(body.tenantId).toBe('tenant-1');
    expect(body.tenantRole).toBe('ADMIN');
  });

  it('queries tenant_members collection with correct filter', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-42',
      role: 'OWNER',
      status: 'ACTIVE',
    });

    const app = createTestApp();

    await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-42' } }, TEST_ENV);

    expect(mockMemberFindOne).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-42',
    });
  });

  it('sets correct tenantRole for OWNER', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'OWNER',
      status: 'ACTIVE',
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { tenantRole: string };

    expect(body.tenantRole).toBe('OWNER');
  });

  it('sets correct tenantRole for MEMBER', async () => {
    mockMemberFindOne.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    const app = createTestApp();
    const res = await app.request('/tenant-protected/resource', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { tenantRole: string };

    expect(body.tenantRole).toBe('MEMBER');
  });

  it('exposes the resolved membership on the context for service reuse', async () => {
    const app = new Hono<AppEnv>();

    app.onError(errorHandler);
    app.use('/tenant-protected/*', async (c, next) => {
      c.set('userId', 'user-1');
      await next();
    });
    app.use('/tenant-protected/*', tenantContextMiddleware);
    app.get('/tenant-protected/resource', (c) => c.json({ membership: c.get('tenantMembership') }));

    mockMemberFindOne.mockResolvedValue({
      id: 'member-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'OWNER',
      status: 'ACTIVE',
      expiresAt: null,
      invitation: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.request('/tenant-protected/resource', {
      headers: { 'X-Tenant-Id': 'tenant-1' },
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { membership: { userId: string; tenantId: string; role: string } };

    expect(body.membership).toMatchObject({ userId: 'user-1', tenantId: 'tenant-1', role: 'OWNER' });
  });

  // ── The project_members lookup runs for EVERY verb, GET included ──
  //
  // F3 ("perf audit #2") restricted it to non-GET/HEAD on the assumption that no
  // read route consumes `projectRole`. That assumption is false: `GET
  // /projects/:projectId/audit` gates on `requirePermission('view_audit_events',
  // true)`, so on a GET the project-level permission was always evaluated with
  // `projectRole === null` — i.e. reads silently fell back to the coarse tenant
  // role. Reads and writes must see the same authorization context.

  function createProjectScopedTestApp() {
    const app = new Hono<AppEnv>();

    app.onError(errorHandler);
    app.use('/api/*', async (c, next) => {
      c.set('userId', 'user-1');
      await next();
    });
    app.use('/api/*', tenantContextMiddleware);

    const echoRole = (c: { get: (key: 'projectRole') => string | undefined }) => c.get('projectRole');

    app.get('/api/projects/:projectId/tasks', (c) => c.json({ projectRole: echoRole(c) ?? null }));
    app.post('/api/projects/:projectId/tasks', (c) => c.json({ projectRole: echoRole(c) ?? null }));
    // A tenant-scoped route with NO project in the path: the pre-existing
    // behaviour (no project lookup) must be preserved verbatim.
    app.get('/api/tasks/:taskId', (c) => c.json({ projectRole: echoRole(c) ?? null }));

    return app;
  }

  const ACTIVE_MEMBER = { userId: 'user-1', tenantId: 'tenant-1', role: 'MEMBER', status: 'ACTIVE' };

  describe('F5: project role lookup on read requests', () => {
    it('resolves the project role for a MEMBER GET on a project-scoped path', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue({ userId: 'user-1', projectId: 'p1', role: 'EDITOR' });

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/projects/p1/tasks', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'p1' });

      const body = (await res.json()) as { projectRole: string | null };

      expect(body.projectRole).toBe('EDITOR');
    });

    it('resolves the project role for a HEAD request too', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue({ userId: 'user-1', projectId: 'p1', role: 'VIEWER' });

      const app = createProjectScopedTestApp();
      const res = await app.request(
        '/api/projects/p1/tasks',
        { method: 'HEAD', headers: { 'X-Tenant-Id': 'tenant-1' } },
        TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'p1' });
    });

    it('a project ADMIN gets PROJECT_ADMIN on a GET — the case the audit route needs', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue({ userId: 'user-1', projectId: 'p1', role: 'PROJECT_ADMIN' });

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/projects/p1/tasks', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { projectRole: string | null };

      expect(body.projectRole).toBe('PROJECT_ADMIN');
    });

    it('leaves the role unset for a tenant MEMBER who is NOT a project member (GET)', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue(null);

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/projects/p1/tasks', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'p1' });

      const body = (await res.json()) as { projectRole: string | null };

      // Authorization is left to requirePermission downstream — unchanged.
      expect(body.projectRole).toBeNull();
    });

    it('performs NO project lookup when the route has no :projectId (GET)', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/tasks/t1', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).not.toHaveBeenCalled();

      const body = (await res.json()) as { projectRole: string | null };

      expect(body.projectRole).toBeNull();
    });

    it('does not look up project membership for a tenant ADMIN GET (RBAC bypass, unchanged)', async () => {
      mockMemberFindOne.mockResolvedValue({ ...ACTIVE_MEMBER, role: 'ADMIN' });

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/projects/p1/tasks', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    });

    it('does not look up project membership for a tenant OWNER GET (RBAC bypass, unchanged)', async () => {
      mockMemberFindOne.mockResolvedValue({ ...ACTIVE_MEMBER, role: 'OWNER' });

      const app = createProjectScopedTestApp();
      const res = await app.request('/api/projects/p1/tasks', { headers: { 'X-Tenant-Id': 'tenant-1' } }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    });
  });

  describe('F3 (write requests) — unchanged', () => {
    it('performs the project_members lookup for a MEMBER POST and exposes the role', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue({ userId: 'user-1', projectId: 'p1', role: 'EDITOR' });

      const app = createProjectScopedTestApp();
      const res = await app.request(
        '/api/projects/p1/tasks',
        { method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' } },
        TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'p1' });

      const body = (await res.json()) as { projectRole: string | null };

      expect(body.projectRole).toBe('EDITOR');
    });

    it('keeps the current behavior for a MEMBER POST without project membership (role stays unset)', async () => {
      mockMemberFindOne.mockResolvedValue(ACTIVE_MEMBER);
      mockProjectMemberFindOne.mockResolvedValue(null);

      const app = createProjectScopedTestApp();
      const res = await app.request(
        '/api/projects/p1/tasks',
        { method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' } },
        TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'p1' });

      const body = (await res.json()) as { projectRole: string | null };

      // Authorization is left to requirePermission downstream — unchanged.
      expect(body.projectRole).toBeNull();
    });

    it('does not look up project membership for a tenant ADMIN POST (RBAC bypass, unchanged)', async () => {
      mockMemberFindOne.mockResolvedValue({ ...ACTIVE_MEMBER, role: 'ADMIN' });

      const app = createProjectScopedTestApp();
      const res = await app.request(
        '/api/projects/p1/tasks',
        { method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' } },
        TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    });

    it('does not look up project membership for a tenant OWNER POST (RBAC bypass, unchanged)', async () => {
      mockMemberFindOne.mockResolvedValue({ ...ACTIVE_MEMBER, role: 'OWNER' });

      const app = createProjectScopedTestApp();
      const res = await app.request(
        '/api/projects/p1/tasks',
        { method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' } },
        TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    });
  });
  /**
   * `X-Tenant-Id` crosses a schema boundary, and the "not a member"
   * answer does not distinguish an unknown tenant from a known one.
   *
   * The property: an externally-supplied value is parsed by the same shared
   * validators every path parameter uses, and a malformed one is refused BEFORE
   * it reaches a query; and a caller cannot tell "no such workspace" from "not
   * your workspace".
   */
  describe('D-26: the X-Tenant-Id header is validated and answers indistinguishably', () => {
    async function request(tenantRef: string | null) {
      const app = createTestApp();

      return app.request(
        '/tenant-protected/resource',
        { headers: tenantRef === null ? {} : { 'X-Tenant-Id': tenantRef } },
        TEST_ENV,
      );
    }

    it('rejects a MALFORMED header with 400 before any query runs', async () => {
      // The absent-input path: an unvalidated header used to travel into two
      // indexed queries as an arbitrary string, and be refused 10 lines later.
      for (const bad of ['../../etc', 'a'.repeat(200), 'has space', 'DROP TABLE', '-1']) {
        mockMemberFindOne.mockClear();
        mockTenantFindOne.mockClear();

        const res = await request(bad);

        expect(res.status, bad).toBe(400);
        expect(mockMemberFindOne, bad).not.toHaveBeenCalled();
        expect(mockTenantFindOne, bad).not.toHaveBeenCalled();
      }
    });

    it('accepts both shapes the resolver understands (id and slug)', async () => {
      mockMemberFindOne.mockResolvedValue({
        id: 'm1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'OWNER',
        status: 'ACTIVE',
        expiresAt: null,
      });
      mockTenantFindOne.mockResolvedValue(null);

      expect((await request('550e8400-e29b-41d4-a716-446655440099')).status).toBe(200);
      expect((await request('acme-workspace')).status).toBe(200);
    });

    it('answers an UNKNOWN tenant and a FOREIGN one identically', async () => {
      // The slug-enumeration oracle: a caller must not be able to learn which
      // workspace slugs exist by reading the error.
      mockMemberFindOne.mockResolvedValue(null);
      mockTenantFindOne.mockResolvedValue(null);

      const unknown = await (await request('no-such-workspace')).text();

      mockMemberFindOne.mockResolvedValue(null);
      mockTenantFindOne.mockResolvedValue({ id: 'tenant-2', slug: 'other-workspace' });

      const foreign = await (await request('other-workspace')).text();

      expect(unknown).toBe(foreign);
    });

    it('still refuses a missing header', async () => {
      expect((await request(null)).status).toBe(400);
    });
  });
});
