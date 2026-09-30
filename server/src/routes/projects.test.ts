/**
 * Tests for project CRUD and member management HTTP routes.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createProjectRoutes } from './projects.js';
import { ProjectService } from '../services/project.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { ForbiddenError, NotFoundError } from '../errors/app-error.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({
    insertOne: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  })),
}));

const mockProject = {
  id: '550e8400-e29b-41d4-a716-446655440010',
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  key: 'TEST',
  name: 'Test Project',
  description: null,
  status: 'ACTIVE',
  defaultStatusId: 'status-1',
  archiveReason: null,
  deletionScheduledAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const mockProjectMember = {
  id: '550e8400-e29b-41d4-a716-446655440011',
  userId: '550e8400-e29b-41d4-a716-446655440002',
  projectId: '550e8400-e29b-41d4-a716-446655440010',
  role: 'PROJECT_ADMIN',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

vi.mock('../services/project.service.js', () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    listProjects: vi.fn().mockResolvedValue([mockProject]),
    // Simulates the real service-level enforcement (requireTenantAdmin)
    createProject: vi
      .fn()
      .mockImplementation((_tenantId: string, _userId: string, userRole: string) =>
        userRole === 'OWNER' || userRole === 'ADMIN'
          ? Promise.resolve(mockProject)
          : Promise.reject(new ForbiddenError('Only owner or admin can perform this action')),
      ),
    getProject: vi.fn().mockResolvedValue(mockProject),
    updateProject: vi.fn().mockResolvedValue(mockProject),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    archiveProject: vi.fn().mockResolvedValue(undefined),
    restoreProject: vi.fn().mockResolvedValue(undefined),
    cancelDeletion: vi.fn().mockResolvedValue(undefined),
    getProjectMembers: vi.fn().mockResolvedValue([mockProjectMember]),
    addMember: vi.fn().mockResolvedValue(mockProjectMember),
    updateMemberRole: vi.fn().mockResolvedValue(mockProjectMember),
    removeMember: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440002';
const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const FOREIGN_TENANT_ID = '550e8400-e29b-41d4-a716-4466554400ff';

/**
 * A fully controllable `ProjectService` double. Used by the
 * guardrail specs to assert WHAT the route forwards (the caller context) and
 * to simulate the service's 404/403 answers.
 */
function createProjectsDouble(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([mockProject]),
    createProject: vi.fn().mockResolvedValue(mockProject),
    getProject: vi.fn().mockResolvedValue(mockProject),
    getProjectByKey: vi.fn().mockResolvedValue(mockProject),
    updateProject: vi.fn().mockResolvedValue(mockProject),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    archiveProject: vi.fn().mockResolvedValue(undefined),
    restoreProject: vi.fn().mockResolvedValue(undefined),
    cancelDeletion: vi.fn().mockResolvedValue(undefined),
    getProjectMembers: vi.fn().mockResolvedValue([mockProjectMember]),
    addMember: vi.fn().mockResolvedValue(mockProjectMember),
    updateMemberRole: vi.fn().mockResolvedValue(mockProjectMember),
    removeMember: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** The tenant roster `requireActiveTenantMember` reads through `TenantMemberService`. */
function createTenantMembersDouble(members: { userId: string; status: string }[] = []) {
  return {
    getTenantMembers: vi.fn().mockResolvedValue(members.map((m) => ({ id: 'm-1', ...m, role: 'MEMBER' }))),
  };
}

interface TestAppOptions {
  projects?: ReturnType<typeof createProjectsDouble>;
  tenantMembers?: ReturnType<typeof createTenantMembersDouble>;
  tenantId?: string;
}

function createTestApp(tenantRole = 'OWNER', options: TestAppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    const MockProjects = ProjectService as unknown as new () => InstanceType<typeof ProjectService>;

    c.set('userId', VALID_UUID);
    c.set('tenantId', options.tenantId ?? TENANT_ID);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('svc', {
      projects: options.projects ?? new MockProjects(),
      tenantMembers: options.tenantMembers ?? createTenantMembersDouble([{ userId: VALID_UUID, status: 'ACTIVE' }]),
    } as never);
    await next();
  });

  app.route('/api/projects', createProjectRoutes());

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

// ─── GET /api/projects ────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/projects');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ─── POST /api/projects ───────────────────────────────────────────────────

describe('POST /api/projects', () => {
  const app = createTestApp();
  const validBody = { key: 'TEST', name: 'New Project', description: 'A new project' };

  it('should return 201 for valid project creation', async () => {
    const res = await postJson(app, '/api/projects', validBody);

    expect(res.status).toBe(201);
  });

  it('should return 201 without optional description', async () => {
    const res = await postJson(app, '/api/projects', { key: 'TEST', name: 'New Project' });

    expect(res.status).toBe(201);
  });

  // ── Key validation ──────────────────────────────────────────────────────

  it('should return 422 for missing key', async () => {
    const res = await postJson(app, '/api/projects', { name: 'New Project' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for lowercase key', async () => {
    const res = await postJson(app, '/api/projects', { key: 'abc', name: 'New Project' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for key starting with digit', async () => {
    const res = await postJson(app, '/api/projects', { key: '1ABC', name: 'New Project' });

    expect(res.status).toBe(400);
  });

  // ── Name validation ──────────────────────────────────────────────────────

  it('should return 422 for empty name', async () => {
    const res = await postJson(app, '/api/projects', { ...validBody, name: '' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for name exceeding 200 chars', async () => {
    const res = await postJson(app, '/api/projects', { ...validBody, name: 'a'.repeat(201) });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing name', async () => {
    const res = await postJson(app, '/api/projects', { key: 'TEST' });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/projects/:projectId ─────────────────────────────────────────

describe('GET /api/projects/:projectId', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });
});

// ─── PATCH /api/projects/:projectId ───────────────────────────────────────

describe('PATCH /api/projects/:projectId', () => {
  const app = createTestApp();

  it('should return 200 for valid partial update', async () => {
    const res = await patchJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010', {
      name: 'Updated Project',
    });

    expect(res.status).toBe(200);
  });

  it('should return 422 for empty name in update', async () => {
    const res = await patchJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010', { name: '' });

    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/projects/:projectId ──────────────────────────────────────

describe('DELETE /api/projects/:projectId', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await deleteJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });
});

// ─── GET /api/projects/:projectId/members ─────────────────────────────────

describe('GET /api/projects/:projectId/members', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010/members');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ─── POST /api/projects/:projectId/members ────────────────────────────────

describe('POST /api/projects/:projectId/members', () => {
  const app = createTestApp();

  it('should return 201 for valid member addition', async () => {
    const res = await postJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010/members', {
      userId: VALID_UUID,
      role: 'EDITOR',
    });

    expect(res.status).toBe(201);
  });

  it('should return 422 for invalid role', async () => {
    const res = await postJson(app, '/api/projects/550e8400-e29b-41d4-a716-446655440010/members', {
      userId: VALID_UUID,
      role: 'invalid-role',
    });

    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/projects/:projectId/members/:memberUserId ────────────────

describe('DELETE /api/projects/:projectId/members/:memberUserId', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await deleteJson(app, `/api/projects/550e8400-e29b-41d4-a716-446655440010/members/${VALID_UUID}`);

    expect(res.status).toBe(200);
  });
});

// ─── Per-action authorization on projects routes ──────────────────────────

describe('DEC-017 per-action authorization', () => {
  it('allows MEMBER to list projects', async () => {
    const res = await getJson(createTestApp('MEMBER'), '/api/projects');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });

  it('allows MEMBER to get a single project', async () => {
    const res = await getJson(createTestApp('MEMBER'), '/api/projects/550e8400-e29b-41d4-a716-446655440010');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });

  it('allows MEMBER to list project members', async () => {
    const res = await getJson(createTestApp('MEMBER'), '/api/projects/550e8400-e29b-41d4-a716-446655440010/members');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });

  it('denies MEMBER project creation with 403 (service-level check)', async () => {
    const res = await postJson(createTestApp('MEMBER'), '/api/projects', {
      key: 'TEST',
      name: 'New Project',
    });

    expect(res.status).toBe(403);

    const body = (await res.json()) as { error?: { code?: string } };

    expect(body.error?.code).toBe('FORBIDDEN');
  });

  it('still allows ADMIN project creation', async () => {
    const res = await postJson(createTestApp('ADMIN'), '/api/projects', {
      key: 'TEST',
      name: 'New Project',
    });

    expect(res.status).toBe(201);
  });
});

// ─── The route forwards the caller context, the service answers 404 ───────────

describe('M-002 tenant isolation of project object operations', () => {
  const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
  const expectedContext = { tenantId: TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' };

  it('GET forwards { tenantId, userId, userRole } taken from the request context', async () => {
    const projects = createProjectsDouble();
    const res = await getJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}`);

    expect(res.status).toBe(200);
    expect(projects.getProject).toHaveBeenCalledWith(PROJECT_ID, expectedContext);
  });

  it('PATCH forwards the context and the acting userId (M-006: the audit actor)', async () => {
    const projects = createProjectsDouble();
    const res = await patchJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}`, {
      name: 'Updated Project',
    });

    expect(res.status).toBe(200);
    expect(projects.updateProject).toHaveBeenCalledWith(PROJECT_ID, { name: 'Updated Project' }, expectedContext);
  });

  it('DELETE forwards the context and the acting userId (M-006)', async () => {
    const projects = createProjectsDouble();
    const res = await deleteJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}`);

    expect(res.status).toBe(200);
    expect(projects.deleteProject).toHaveBeenCalledWith(PROJECT_ID, expectedContext);
  });

  it('archive / restore / cancel-deletion forward the context too', async () => {
    const projects = createProjectsDouble();
    const app = createTestApp('OWNER', { projects });

    await postJson(app, `/api/projects/${PROJECT_ID}/archive`, {});
    await postJson(app, `/api/projects/${PROJECT_ID}/restore`, {});
    await postJson(app, `/api/projects/${PROJECT_ID}/cancel-deletion`, {});

    expect(projects.archiveProject).toHaveBeenCalledWith(PROJECT_ID, expectedContext);
    expect(projects.restoreProject).toHaveBeenCalledWith(PROJECT_ID, expectedContext);
    expect(projects.cancelDeletion).toHaveBeenCalledWith(PROJECT_ID, expectedContext);
  });

  it('GET of a foreign project answers 404 with the standard error envelope', async () => {
    const projects = createProjectsDouble({
      getProject: vi.fn().mockRejectedValue(new NotFoundError('Project not found')),
    });
    const res = await getJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}`);

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH of a foreign project answers 404 (no 200, no write)', async () => {
    const projects = createProjectsDouble({
      updateProject: vi.fn().mockRejectedValue(new NotFoundError('Project not found')),
    });
    const res = await patchJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}`, {
      name: 'PWNED BY ATTACKER',
    });

    expect(res.status).toBe(404);
  });

  it('member sub-routes answer 404 for a foreign project', async () => {
    const projects = createProjectsDouble({
      getProjectMembers: vi.fn().mockRejectedValue(new NotFoundError('Project not found')),
      updateMemberRole: vi.fn().mockRejectedValue(new NotFoundError('Project not found')),
      removeMember: vi.fn().mockRejectedValue(new NotFoundError('Project not found')),
    });
    const app = createTestApp('OWNER', { projects });

    expect((await getJson(app, `/api/projects/${PROJECT_ID}/members`)).status).toBe(404);
    expect((await patchJson(app, `/api/projects/${PROJECT_ID}/members/${VALID_UUID}`, { role: 'VIEWER' })).status).toBe(
      404,
    );
    expect((await deleteJson(app, `/api/projects/${PROJECT_ID}/members/${VALID_UUID}`)).status).toBe(404);
  });

  it('an insufficient role answers 403 — the role gate is independent of ownership', async () => {
    const projects = createProjectsDouble({
      updateProject: vi.fn().mockRejectedValue(new ForbiddenError('Only owner or admin can perform this action')),
    });
    const res = await patchJson(createTestApp('MEMBER', { projects }), `/api/projects/${PROJECT_ID}`, {
      name: 'Nope',
    });

    expect(res.status).toBe(403);
  });
});

// ─── addMember may only target an ACTIVE member of the caller ──
//
// The guard MOVED from this router into `ProjectService.addMember` (a
// direct service call used to bypass the route-level helper — the residual hole
// reported in F4 §8.1). These specs now assert the ROUTE half of the contract:
// it forwards the full caller context (which is what the service needs to resolve
// the target membership in the CALLER's tenant) and it does NOT read the tenant
// roster itself any more. The service half is covered in
// `services/project.service.test.ts` (that block).

describe('M-003 / G-02 addMember privilege escalation', () => {
  const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
  const ATTACKER_USER_ID = '550e8400-e29b-41d4-a716-4466554400aa';

  it('creates the membership for an ACTIVE member of the caller tenant', async () => {
    const projects = createProjectsDouble();
    const tenantMembers = createTenantMembersDouble([{ userId: VALID_UUID, status: 'ACTIVE' }]);
    const res = await postJson(
      createTestApp('OWNER', { projects, tenantMembers }),
      `/api/projects/${PROJECT_ID}/members`,
      { userId: VALID_UUID, role: 'EDITOR' },
    );

    expect(res.status).toBe(201);
    expect(projects.addMember).toHaveBeenCalledWith(
      PROJECT_ID,
      { userId: VALID_UUID, role: 'EDITOR' },
      { tenantId: TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' },
    );
  });

  it("no longer reads the tenant roster: the membership check is the service's job (G-02)", async () => {
    const projects = createProjectsDouble();
    const tenantMembers = createTenantMembersDouble([{ userId: VALID_UUID, status: 'ACTIVE' }]);
    const res = await postJson(
      createTestApp('OWNER', { projects, tenantMembers }),
      `/api/projects/${PROJECT_ID}/members`,
      { userId: VALID_UUID, role: 'EDITOR' },
    );

    expect(res.status).toBe(201);
    expect(tenantMembers.getTenantMembers).not.toHaveBeenCalled();
  });

  it('rejects a userId that is not a member of the caller tenant (404) and creates nothing', async () => {
    // The service is the guard now, so the double models its 404 answer and the
    // route must surface it unchanged (no row created, standard error envelope).
    const projects = createProjectsDouble({
      addMember: vi.fn().mockRejectedValue(new NotFoundError('User is not a member of this tenant')),
    });
    const res = await postJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}/members`, {
      userId: ATTACKER_USER_ID,
      role: 'PROJECT_ADMIN',
    });

    expect(res.status).toBe(404);
    expect(projects.addMember).toHaveBeenCalledWith(
      PROJECT_ID,
      { userId: ATTACKER_USER_ID, role: 'PROJECT_ADMIN' },
      { tenantId: TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' },
    );

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a userId whose membership exists but is not ACTIVE', async () => {
    const projects = createProjectsDouble({
      addMember: vi.fn().mockRejectedValue(new NotFoundError('User is not a member of this tenant')),
    });
    const res = await postJson(createTestApp('OWNER', { projects }), `/api/projects/${PROJECT_ID}/members`, {
      userId: ATTACKER_USER_ID,
      role: 'PROJECT_ADMIN',
    });

    expect(res.status).toBe(404);
  });

  it('verifies the membership in the CALLER tenant, not in an arbitrary one', async () => {
    const projects = createProjectsDouble();
    const res = await postJson(
      createTestApp('OWNER', { projects, tenantId: FOREIGN_TENANT_ID }),
      `/api/projects/${PROJECT_ID}/members`,
      { userId: VALID_UUID, role: 'PROJECT_ADMIN' },
    );

    expect(res.status).toBe(201);
    // The tenant the service will look the membership up in comes from the request
    // context, never from a path or body value.
    expect(projects.addMember).toHaveBeenCalledWith(
      PROJECT_ID,
      { userId: VALID_UUID, role: 'PROJECT_ADMIN' },
      { tenantId: FOREIGN_TENANT_ID, userId: VALID_UUID, userRole: 'OWNER' },
    );
  });
});
