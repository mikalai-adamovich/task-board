/**
 * Tests for invitation HTTP routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createInvitationRoutes } from './invitations.js';
import { errorHandler } from '../middleware/error-handler.js';
import { ForbiddenError } from '../errors/app-error.js';
import { TenantService } from '../services/tenant.service.js';
import { TenantMemberService } from '../services/tenant-member.service.js';
import { AuthService } from '../services/auth.service.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({})),
}));

vi.mock('../middleware/auth.js', () => ({
  // The stub stands in for the REAL middleware, so it must cost what the real one
  // costs: one user lookup per authentication, plus the context it sets. A
  // pass-through stub would make a SECOND authentication free to add and
  // invisible to the suite (that was exactly this).
  authMiddleware: vi.fn().mockImplementation(async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const svc = c.get('svc') as { auth?: { findActiveUser?: (id: string) => Promise<unknown> } } | undefined;

    if (svc?.auth?.findActiveUser) {
      c.set('user', (await svc.auth.findActiveUser(c.get('userId') ?? 'user-1')) as never);
    }

    await next();
  }),
}));

// An unaccepted membership is ACCESS_REVOKED while its invitation is PENDING
const mockGetMyInvitations = vi.fn().mockResolvedValue([
  {
    id: 'member-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'MEMBER',
    status: 'ACCESS_REVOKED',
    invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: '2025-01-01T00:00:00.000Z' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
]);
const mockAcceptInvitation = vi.fn().mockResolvedValue(undefined);
const mockDeclineInvitation = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/tenant-member.service.js', () => ({
  TenantMemberService: vi.fn().mockImplementation(() => ({
    getMyInvitations: mockGetMyInvitations,
    acceptInvitation: mockAcceptInvitation,
    declineInvitation: mockDeclineInvitation,
  })),
}));

vi.mock('../services/auth.service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    me: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      avatarUrl: null,
      deletedAt: null,
    }),
  })),
}));

vi.mock('../repositories/tenant.repository.js', () => ({
  TenantRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../repositories/tenant-member.repository.js', () => ({
  TenantMemberRepository: vi.fn().mockImplementation(() => ({})),
}));

const mockFindById = vi.fn().mockResolvedValue({
  id: 'user-1',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  deletedAt: null,
});

vi.mock('../repositories/user.repository.js', () => ({
  UserRepository: vi.fn().mockImplementation(() => ({
    findById: mockFindById,
  })),
}));

vi.mock('../services/email.service.js', () => ({
  EmailService: vi.fn().mockImplementation(() => ({})),
  ConsoleEmailService: vi.fn().mockImplementation(() => ({})),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

function createTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/invitations/*', async (c, next) => {
    const MockTenants = TenantService as unknown as new () => InstanceType<typeof TenantService>;
    const MockMembers = TenantMemberService as unknown as new () => InstanceType<typeof TenantMemberService>;
    const MockAuth = AuthService as unknown as new () => InstanceType<typeof AuthService>;

    c.set('svc', {
      tenants: new MockTenants(),
      tenantMembers: new MockMembers(),
      auth: new MockAuth(),
    } as never);
    c.set('userId', 'user-1');
    c.set('user', {
      id: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      avatarUrl: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: null,
    });
    await next();
  });

  app.route('/api/invitations', createInvitationRoutes());

  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Invitation Routes', () => {
  beforeEach(() => {
    mockGetMyInvitations.mockClear();
    mockAcceptInvitation.mockClear();
    mockDeclineInvitation.mockClear();
    mockFindById.mockClear();
  });

  describe('GET /api/invitations/my', () => {
    it('returns 200 with { data } envelope', async () => {
      const app = createTestApp();
      const res = await app.request('/api/invitations/my', { method: 'GET' }, TEST_ENV);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: unknown[] };

      expect(body.data).toHaveLength(1);
    });
  });

  describe('POST /api/invitations/:invitationId/accept', () => {
    it('returns 200 with success', async () => {
      const app = createTestApp();
      const res = await app.request(
        '/api/invitations/77777777-0000-4000-8000-000000000123/accept',
        { method: 'POST' },
        TEST_ENV,
      );

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { success: boolean } };

      expect(body.data.success).toBe(true);
    });

    it('calls TenantMemberService.acceptInvitation with the authenticated userId (M-01)', async () => {
      const app = createTestApp();

      await app.request('/api/invitations/77777777-0000-4000-8000-000000000123/accept', { method: 'POST' }, TEST_ENV);

      expect(mockAcceptInvitation).toHaveBeenCalledWith('77777777-0000-4000-8000-000000000123', 'user-1');
    });

    it('returns 403 when the invitation belongs to another user (M-01)', async () => {
      mockAcceptInvitation.mockRejectedValueOnce(new ForbiddenError('You can only accept your own invitations'));

      const app = createTestApp();
      const res = await app.request(
        '/api/invitations/77777777-0000-4000-8000-000000000123/accept',
        { method: 'POST' },
        TEST_ENV,
      );

      expect(res.status).toBe(403);

      const body = (await res.json()) as { error: { code: string; message: string } };

      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('You can only accept your own invitations');
    });
  });

  describe('POST /api/invitations/:invitationId/decline', () => {
    it('returns 200 with success', async () => {
      const app = createTestApp();
      const res = await app.request(
        '/api/invitations/77777777-0000-4000-8000-000000000123/decline',
        { method: 'POST' },
        TEST_ENV,
      );

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { success: boolean } };

      expect(body.data.success).toBe(true);
    });

    it('calls TenantService.declineInvitation', async () => {
      const app = createTestApp();

      await app.request('/api/invitations/77777777-0000-4000-8000-000000000123/decline', { method: 'POST' }, TEST_ENV);

      expect(mockDeclineInvitation).toHaveBeenCalledWith('77777777-0000-4000-8000-000000000123', 'user-1');
    });
  });

  // V2-3: the UI's Decline action fires DELETE /api/invitations/:id — the same
  // operation must be reachable under that method.
  describe('DELETE /api/invitations/:invitationId (UI decline alias)', () => {
    it('returns 200 with success', async () => {
      const app = createTestApp();
      const res = await app.request(
        '/api/invitations/77777777-0000-4000-8000-000000000123',
        { method: 'DELETE' },
        TEST_ENV,
      );

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { success: boolean } };

      expect(body.data.success).toBe(true);
    });

    it('routes to TenantService.declineInvitation like POST …/decline', async () => {
      const app = createTestApp();

      await app.request('/api/invitations/77777777-0000-4000-8000-000000000123', { method: 'DELETE' }, TEST_ENV);

      expect(mockDeclineInvitation).toHaveBeenCalledWith('77777777-0000-4000-8000-000000000123', 'user-1');
    });
  });
  /**
   * A request is authenticated ONCE.
   *
   * The property, not the count of mounts: the invitation sub-app used to carry
   * its own `authMiddleware` on top of the one `app.ts` already applies, so every
   * request paid two user lookups and — with an `X-Tenant-Id` present — two
   * membership resolutions. This asserts the LOOKUPS, because that is the cost;
   * a fix that achieves one lookup a different way still passes.
   */
  describe('D-21: one authentication per invitation request', () => {
    it('performs exactly one user lookup for a request the app already guards', async () => {
      const { authMiddleware: realAuth } =
        await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
      const findActiveUser = vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
        deletedAt: null,
      });
      const app = new Hono<AppEnv>();

      app.onError(errorHandler);
      app.use('/api/*', async (c, next) => {
        c.set('svc', { auth: { findActiveUser }, tenantMembers: { getMyInvitations: mockGetMyInvitations } } as never);
        await next();
      });
      // The guard `app.ts` applies to every /api route …
      app.use('/api/*', realAuth);
      // … and the sub-app under test, which must not add a second one.
      app.route('/api/invitations', createInvitationRoutes());

      const res = await app.request(
        '/api/invitations/my',
        { headers: { Authorization: 'Bearer x.y.z' } },
        { ...TEST_ENV, JWT_SECRET: 'test-secret' },
      );

      expect(res.status).toBe(401); // the stub token is not a valid JWT
      expect(findActiveUser).not.toHaveBeenCalled();
    });

    it('a VALID token costs exactly one user lookup, not two', async () => {
      const { authMiddleware: realAuth } =
        await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
      const { sign } = await import('hono/jwt');
      const findActiveUser = vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
        deletedAt: null,
      });
      const app = new Hono<AppEnv>();
      const secret = 'fx5-invitation-secret';

      app.onError(errorHandler);
      app.use('/api/*', async (c, next) => {
        c.set('svc', {
          auth: { findActiveUser, me: vi.fn().mockResolvedValue({ id: 'user-1', email: 'test@example.com' }) },
          tenantMembers: { getMyInvitations: mockGetMyInvitations },
        } as never);
        await next();
      });
      app.use('/api/*', realAuth);
      app.route('/api/invitations', createInvitationRoutes());

      const token = await sign({ sub: 'user-1', email: 'test@example.com' }, secret, 'HS256');
      const res = await app.request(
        '/api/invitations/my',
        { headers: { Authorization: `Bearer ${token}` } },
        { ...TEST_ENV, JWT_SECRET: secret },
      );

      expect(res.status, await res.clone().text()).toBe(200);
      expect(findActiveUser).toHaveBeenCalledTimes(1);
    });
  });
});
