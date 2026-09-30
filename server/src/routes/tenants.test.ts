/**
 * Tests for tenant CRUD and lifecycle HTTP routes.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTenantRoutes } from './tenants.js';
import { TenantService } from '../services/tenant.service.js';
import { TenantMemberService } from '../services/tenant-member.service.js';
import { ConflictError, ForbiddenError } from '../errors/app-error.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({})),
}));

/** Mutable return value for the mocked isSlugAvailable — controlled per test. */
let slugAvailabilityResult = true;
const mockTenant = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Test Tenant',
  description: null,
  status: 'ACTIVE',
  deletionScheduledAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const mockMember = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  userId: '550e8400-e29b-41d4-a716-446655440002',
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  role: 'OWNER',
  status: 'ACTIVE',
  invitation: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
// An invited-but-unaccepted membership is ACCESS_REVOKED + invitation PENDING
const mockInvitedMember = {
  ...mockMember,
  id: '550e8400-e29b-41d4-a716-446655440003',
  userId: '550e8400-e29b-41d4-a716-446655440004',
  role: 'MEMBER',
  status: 'ACCESS_REVOKED',
  invitation: {
    status: 'PENDING',
    tokenHash: 'hash',
    invitedBy: '550e8400-e29b-41d4-a716-446655440002',
    invitedOn: '2025-01-01T00:00:00.000Z',
  },
};

vi.mock('../services/tenant.service.js', () => ({
  TenantService: vi.fn().mockImplementation(() => ({
    listTenantsWithRole: vi.fn().mockResolvedValue([{ ...mockTenant, role: 'OWNER' }]),
    createTenant: vi.fn().mockResolvedValue(mockTenant),
    getTenant: vi.fn().mockResolvedValue(mockTenant),
    getTenantForUser: vi.fn().mockResolvedValue(mockTenant),
    updateTenant: vi.fn().mockResolvedValue(mockTenant),
    deleteTenant: vi.fn().mockResolvedValue(undefined),
    archiveTenant: vi.fn().mockResolvedValue(undefined),
    restoreTenant: vi.fn().mockResolvedValue(undefined),
    cancelDeletion: vi.fn().mockResolvedValue(undefined),
    isSlugAvailable: vi.fn().mockImplementation(() => Promise.resolve(slugAvailabilityResult)),
  })),
}));

// V2-7: shared spies for the membership lifecycle routes
const mockUpdateMember = vi.fn().mockResolvedValue(mockMember);
const mockRevokeAccess = vi.fn().mockResolvedValue(undefined);
const mockRestoreMembership = vi.fn().mockResolvedValue(undefined);
const mockReinviteUser = vi.fn().mockResolvedValue(undefined);
const mockRevokeInvitation = vi.fn().mockResolvedValue(undefined);
const mockHardDeleteMember = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/tenant-member.service.js', () => ({
  TenantMemberService: vi.fn().mockImplementation(() => ({
    getTenantMembers: vi.fn().mockResolvedValue([mockMember, mockInvitedMember]),
    inviteUser: vi.fn().mockResolvedValue(mockInvitedMember),
    updateMember: mockUpdateMember,
    removeMember: vi.fn().mockResolvedValue(undefined),
    revokeAccess: mockRevokeAccess,
    restoreMembership: mockRestoreMembership,
    reinviteUser: mockReinviteUser,
    revokeInvitation: mockRevokeInvitation,
    hardDeleteMember: mockHardDeleteMember,
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

function createTestApp() {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    const MockTenants = TenantService as unknown as new () => InstanceType<typeof TenantService>;
    const MockMembers = TenantMemberService as unknown as new () => InstanceType<typeof TenantMemberService>;

    c.set('svc', { tenants: new MockTenants(), tenantMembers: new MockMembers() } as never);
    await next();
  });

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    c.set('userId', '550e8400-e29b-41d4-a716-446655440002');
    await next();
  });

  app.route('/api/tenants', createTenantRoutes());

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

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('GET /api/tenants/slug-available (DEC-032)', () => {
  it('returns { available: true } for a free slug', async () => {
    const app = createTestApp();
    const res = await getJson(app, '/api/tenants/slug-available?slug=free-slug');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { available: boolean } };

    expect(body.data.available).toBe(true);
  });

  it('returns { available: false } for a taken slug', async () => {
    slugAvailabilityResult = false;

    const app = createTestApp();
    const res = await getJson(app, '/api/tenants/slug-available?slug=taken-slug');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { available: boolean } };

    expect(body.data.available).toBe(false);

    slugAvailabilityResult = true;
  });

  it('returns 400 when the slug query parameter is missing', async () => {
    const app = createTestApp();
    const res = await getJson(app, '/api/tenants/slug-available');

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not leak tenant info beyond the boolean (enumeration-safe)', async () => {
    const app = createTestApp();
    const res = await getJson(app, '/api/tenants/slug-available?slug=some-slug');
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.data).toEqual({ available: expect.any(Boolean) });
  });
});

describe('GET /api/tenants', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/tenants');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });
});

describe('POST /api/tenants', () => {
  const app = createTestApp();

  it('should return 201 for valid tenant creation', async () => {
    const res = await postJson(app, '/api/tenants', { name: 'New Tenant' });

    expect(res.status).toBe(201);
  });

  it('should return 422 for empty name', async () => {
    const res = await postJson(app, '/api/tenants', { name: '' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing body', async () => {
    const res = await postJson(app, '/api/tenants', {});

    expect(res.status).toBe(400);
  });
});

describe('GET /api/tenants/:tenantId', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });
});

describe('PATCH /api/tenants/:tenantId', () => {
  const app = createTestApp();

  it('should return 200 for valid partial update', async () => {
    const res = await patchJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000', { name: 'Updated' });

    expect(res.status).toBe(200);
  });

  it('should return 422 for empty name', async () => {
    const res = await patchJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000', { name: '' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tenants/:tenantId', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await deleteJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });
});

describe('POST /api/tenants/:tenantId/archive', () => {
  const app = createTestApp();

  it('should return 200', async () => {
    const res = await postJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/archive', {});

    expect(res.status).toBe(200);
  });
});

describe('POST /api/tenants/:tenantId/restore', () => {
  const app = createTestApp();

  it('should return 200', async () => {
    const res = await postJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/restore', {});

    expect(res.status).toBe(200);
  });
});

describe('GET /api/tenants/:tenantId/members', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope', async () => {
    const res = await getJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/members');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe('POST /api/tenants/:tenantId/members/invite', () => {
  const app = createTestApp();

  it('should return 201 for valid invite', async () => {
    const res = await postJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/members/invite', {
      email: 'new@test.com',
      role: 'MEMBER',
    });

    expect(res.status).toBe(201);
  });

  it('returns the invited membership as ACCESS_REVOKED with a PENDING invitation (DEC-018)', async () => {
    const res = await postJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/members/invite', {
      email: 'new@test.com',
      role: 'MEMBER',
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: { status: string; invitation: { status: string } | null } };

    expect(body.data.status).toBe('ACCESS_REVOKED');
    expect(body.data.invitation?.status).toBe('PENDING');
  });
});

describe('GET /api/tenants/:tenantId/members includes invited members', () => {
  const app = createTestApp();

  it('lists invited members alongside active ones', async () => {
    const res = await getJson(app, '/api/tenants/550e8400-e29b-41d4-a716-446655440000/members');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { status: string }[] };

    expect(body.data).toHaveLength(2);
    expect(body.data.some((m) => m.status === 'ACCESS_REVOKED')).toBe(true);
  });
});

// ─── Member update (role / expiration / profile) ─────────────────────────────

describe('PATCH /api/tenants/:tenantId/members/:memberUserId (DEC-055)', () => {
  it('passes expiresAt through to the service and returns the member', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}`, {
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string } };

    expect(body.data.id).toBe(mockMember.id);
    expect(mockUpdateMember).toHaveBeenCalledWith(expect.any(String), T, UID, {
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('accepts a combined role + expiresAt + profile update', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}`, {
      role: 'ADMIN',
      expiresAt: null,
      name: 'New Name',
      email: 'new@test.com',
    });

    expect(res.status).toBe(200);
    expect(mockUpdateMember).toHaveBeenCalledWith(expect.any(String), T, UID, {
      role: 'ADMIN',
      expiresAt: null,
      name: 'New Name',
      email: 'new@test.com',
    });
  });

  it('returns 400 for an invalid expiresAt value', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}`, { expiresAt: 'not-a-date' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid role', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}`, { role: 'OWNER' });

    expect(res.status).toBe(400);
  });

  it('propagates the owner-expiration ForbiddenError as 403', async () => {
    mockUpdateMember.mockRejectedValueOnce(new ForbiddenError('Cannot set an expiration date on the workspace owner'));

    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}`, { expiresAt: '2030-01-01T00:00:00.000Z' });

    expect(res.status).toBe(403);
  });
});

// ─── V2-7: membership lifecycle routes ───────────────────────────────────────

const T = '550e8400-e29b-41d4-a716-446655440000';
const UID = '550e8400-e29b-41d4-a716-446655440004';

describe('PATCH /api/tenants/:tenantId/members/:memberUserId/revoke (V2-7)', () => {
  it('returns 200 and calls revokeAccess with the userId', async () => {
    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}/revoke`, {});

    expect(res.status).toBe(200);
    expect(mockRevokeAccess).toHaveBeenCalledWith(expect.any(String), T, UID);
  });
});

describe('POST /api/tenants/:tenantId/members/:memberUserId/restore (V2-7)', () => {
  it('returns 200 and calls restoreMembership with the userId', async () => {
    mockRestoreMembership.mockClear();

    const app = createTestApp();
    const res = await postJson(app, `/api/tenants/${T}/members/${UID}/restore`, {});

    expect(res.status).toBe(200);
    expect(mockRestoreMembership).toHaveBeenCalledWith(expect.any(String), T, UID);
  });

  it('propagates BR-036 conflicts from the service', async () => {
    mockRestoreMembership.mockRejectedValueOnce(
      new ConflictError('Cannot restore a membership with a pending invitation'),
    );

    const app = createTestApp();
    const res = await postJson(app, `/api/tenants/${T}/members/${UID}/restore`, {});

    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('CONFLICT');
  });
});

describe('POST /api/tenants/:tenantId/members/:memberUserId/reinvite (V2-7)', () => {
  it('returns 200 and calls reinviteUser with the userId', async () => {
    mockReinviteUser.mockClear();

    const app = createTestApp();
    const res = await postJson(app, `/api/tenants/${T}/members/${UID}/reinvite`, {});

    expect(res.status).toBe(200);
    expect(mockReinviteUser).toHaveBeenCalledWith(expect.any(String), T, UID);
  });
});

describe('PATCH /api/tenants/:tenantId/members/:memberUserId/resend (V2-7)', () => {
  it('aliases reinvite for pending invitations', async () => {
    mockReinviteUser.mockClear();

    const app = createTestApp();
    const res = await patchJson(app, `/api/tenants/${T}/members/${UID}/resend`, {});

    expect(res.status).toBe(200);
    expect(mockReinviteUser).toHaveBeenCalledWith(expect.any(String), T, UID);
  });
});

describe('POST /api/tenants/:tenantId/members/:memberUserId/invitation/revoke (V2-7)', () => {
  it('returns 200 and calls revokeInvitation with the userId', async () => {
    mockRevokeInvitation.mockClear();

    const app = createTestApp();
    const res = await postJson(app, `/api/tenants/${T}/members/${UID}/invitation/revoke`, {});

    expect(res.status).toBe(200);
    expect(mockRevokeInvitation).toHaveBeenCalledWith(expect.any(String), T, UID);
  });
});

describe('DELETE /api/tenants/:tenantId/members/:memberUserId/hard (V2-7)', () => {
  it('returns 200 and calls hardDeleteMember with the userId', async () => {
    mockHardDeleteMember.mockClear();

    const app = createTestApp();
    const res = await deleteJson(app, `/api/tenants/${T}/members/${UID}/hard`);

    expect(res.status).toBe(200);
    expect(mockHardDeleteMember).toHaveBeenCalledWith(expect.any(String), T, UID);
  });
});
