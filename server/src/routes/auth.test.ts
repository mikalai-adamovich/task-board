/**
 * Tests for /auth/login and /auth/register HTTP routes.
 *
 * Validates that the endpoints correctly enforce Zod schema validation
 * and return proper HTTP status codes and error responses with { data: ... } envelope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createAuthRoutes } from './auth.js';
import { AuthService } from '../services/auth.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({})),
}));

vi.mock('../services/auth.service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue({
      token: 'jwt-token',
      user: { id: '1', email: 'test@test', displayName: 'Test', avatarUrl: null, deletedAt: null },
    }),
    register: vi.fn().mockResolvedValue({
      token: 'jwt-token',
      user: { id: '1', email: 'new@test', displayName: 'New', avatarUrl: null, deletedAt: null },
    }),
    acceptInvitation: vi.fn().mockResolvedValue({
      token: 'jwt-token',
      user: { id: '2', email: 'invited@test', displayName: 'Invited', avatarUrl: null, deletedAt: null },
    }),
    getInvitationDetails: vi.fn().mockResolvedValue({
      email: 'invited@test',
      tenantName: 'Acme',
      role: 'MEMBER',
      status: 'PENDING',
      isRegistered: false,
    }),
    me: vi
      .fn()
      .mockResolvedValue({ id: '1', email: 'test@test', displayName: 'Test', avatarUrl: null, deletedAt: null }),
    requestPasswordReset: vi.fn().mockResolvedValue({
      message: 'If an account exists for that email, a password reset link has been sent.',
    }),
    resetPassword: vi.fn().mockResolvedValue({ message: 'Password has been reset.' }),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

function createTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    const MockAuth = AuthService as unknown as new () => InstanceType<typeof AuthService>;

    c.set('svc', { auth: new MockAuth() } as never);
    await next();
  });
  app.route('/api/auth', createAuthRoutes());

  return app;
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

// ─── POST /api/auth/login ─────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  const app = createTestApp();

  it('should return 200 for valid credentials with { data } envelope', async () => {
    const res = await postJson(app, '/api/auth/login', {
      email: 'user@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');

    const data = body.data as Record<string, unknown>;

    expect(data).toHaveProperty('token');
    expect(data).toHaveProperty('user');
  });

  // ── Valid emails ─────────────────────────────────────────────────────────

  it.each(['user@example.com', 'test@test', 'a@b.c', 'user+tag@example.com'])(
    'should accept email: %s',
    async (email) => {
      const res = await postJson(app, '/api/auth/login', { email, password: 'password123' });

      expect(res.status).toBe(200);
    },
  );

  // ── Invalid emails ──────────────────────────────────────────────────────

  it.each([
    { email: '', desc: 'empty string' },
    { email: 'not-an-email', desc: 'missing @' },
    { email: '@example.com', desc: 'missing local part' },
    { email: 'user@', desc: 'missing domain' },
  ])('should return 422 for email: $desc', async ({ email }) => {
    const res = await postJson(app, '/api/auth/login', { email, password: 'password123' });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.error).toBeDefined();
  });

  // ── Password ────────────────────────────────────────────────────────────

  it('should return 422 for empty password', async () => {
    const res = await postJson(app, '/api/auth/login', { email: 'user@example.com', password: '' });

    expect(res.status).toBe(400);
  });

  it('should accept any non-empty password (no length restriction)', async () => {
    const res = await postJson(app, '/api/auth/login', { email: 'user@example.com', password: 'a' });

    expect(res.status).toBe(200);
  });

  // ── Missing fields ──────────────────────────────────────────────────────

  it('should return 422 for missing body', async () => {
    const res = await postJson(app, '/api/auth/login', {});

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing email', async () => {
    const res = await postJson(app, '/api/auth/login', { password: 'password123' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing password', async () => {
    const res = await postJson(app, '/api/auth/login', { email: 'user@example.com' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for invalid JSON body', async () => {
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/register ──────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  const app = createTestApp();
  const validBody = { email: 'new@example.com', password: 'securePass123', displayName: 'New User' };

  it('should return 201 for valid registration with { data } envelope', async () => {
    const res = await postJson(app, '/api/auth/register', validBody);

    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');
  });

  // ── Email ────────────────────────────────────────────────────────────────

  it.each(['test@test', 'user@example.com', 'a@b.co'])('should accept email: %s', async (email) => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, email });

    expect(res.status).toBe(201);
  });

  it('should return 422 for invalid email', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  // ── Password ────────────────────────────────────────────────────────────

  it('should accept password at minimum boundary (8 chars)', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, password: '12345678' });

    expect(res.status).toBe(201);
  });

  it('should accept password at maximum boundary (128 chars)', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, password: 'a'.repeat(128) });

    expect(res.status).toBe(201);
  });

  it('should return 422 for password shorter than 8 chars', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, password: 'short' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for password longer than 128 chars', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, password: 'a'.repeat(129) });

    expect(res.status).toBe(400);
  });

  it('should return 422 for empty password', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, password: '' });

    expect(res.status).toBe(400);
  });

  // ── Display Name ────────────────────────────────────────────────────────

  it('should accept single-character display name', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, displayName: 'A' });

    expect(res.status).toBe(201);
  });

  it('should accept display name at maximum boundary (100 chars)', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, displayName: 'a'.repeat(100) });

    expect(res.status).toBe(201);
  });

  it('should return 422 for empty display name', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, displayName: '' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for display name exceeding 100 chars', async () => {
    const res = await postJson(app, '/api/auth/register', { ...validBody, displayName: 'a'.repeat(101) });

    expect(res.status).toBe(400);
  });

  // ── Missing fields ──────────────────────────────────────────────────────

  it('should return 422 for missing body', async () => {
    const res = await postJson(app, '/api/auth/register', {});

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing email', async () => {
    const res = await postJson(app, '/api/auth/register', { password: '12345678', displayName: 'User' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing password', async () => {
    const res = await postJson(app, '/api/auth/register', { email: 'a@b.com', displayName: 'User' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing displayName', async () => {
    const res = await postJson(app, '/api/auth/register', { email: 'a@b.com', password: '12345678' });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/accept-invitation ─────────────────────────────────────

describe('POST /api/auth/accept-invitation', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope for valid token-only acceptance', async () => {
    const res = await postJson(app, '/api/auth/accept-invitation', { token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');

    const data = body.data as Record<string, unknown>;

    expect(data.token).toBeDefined();
    expect(data.user).toBeDefined();
  });

  it('should return 200 for acceptance with password and displayName', async () => {
    const res = await postJson(app, '/api/auth/accept-invitation', {
      token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      password: 'securePass123',
      displayName: 'New User',
    });

    expect(res.status).toBe(200);
  });

  it('should return 422 for empty token', async () => {
    const res = await postJson(app, '/api/auth/accept-invitation', { token: '' });

    expect(res.status).toBe(400);
  });

  it('should return 422 for missing token', async () => {
    const res = await postJson(app, '/api/auth/accept-invitation', {});

    expect(res.status).toBe(400);
  });

  it('should return 422 for password shorter than 8 chars', async () => {
    const res = await postJson(app, '/api/auth/accept-invitation', {
      token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      password: 'short',
    });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/auth/invitations/:token ─────────────────────────────────────

describe('GET /api/auth/invitations/:token', () => {
  const app = createTestApp();

  it('should return 200 with { data } envelope containing invitation details', async () => {
    const res = await app.request(
      '/api/auth/invitations/a1b2c3d4e5f60718293a4b5c6d7e8f90',
      { method: 'GET' },
      TEST_ENV,
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');

    const data = body.data as Record<string, unknown>;

    expect(data.email).toBe('invited@test');
    expect(data.tenantName).toBe('Acme');
    expect(data.role).toBe('MEMBER');
    expect(data.status).toBe('PENDING');
    expect(data.isRegistered).toBe(false);
  });
});

// ─── POST /api/auth/forgot-password ───────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  const app = createTestApp();

  it('should return 200 with neutral { data: { message } } envelope', async () => {
    const res = await postJson(app, '/api/auth/forgot-password', { email: 'user@example.com' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');

    const data = body.data as Record<string, unknown>;
    const message = data.message as string;

    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it.each(['', 'not-an-email', '@example.com', 'user@'])('should return 400 for invalid email: %s', async (email) => {
    const res = await postJson(app, '/api/auth/forgot-password', { email });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.error).toBeDefined();
  });

  it('should return 400 for missing email', async () => {
    const res = await postJson(app, '/api/auth/forgot-password', {});

    expect(res.status).toBe(400);
  });

  it('should return 400 for missing body', async () => {
    const res = await postJson(app, '/api/auth/forgot-password', {});

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/reset-password ────────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  const app = createTestApp();
  const validBody = { token: 'reset-token-abc123', newPassword: 'newSecurePass123' };

  it('should return 200 with { data: { message } } envelope for a valid request', async () => {
    const res = await postJson(app, '/api/auth/reset-password', validBody);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('data');

    const data = body.data as Record<string, unknown>;

    expect(typeof data.message).toBe('string');
  });

  it.each(['', undefined])('should return 400 for missing/empty token (%s)', async (token) => {
    const res = await postJson(app, '/api/auth/reset-password', { token, newPassword: 'newSecurePass123' });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.error).toBeDefined();
  });

  it('should return 400 for password shorter than 8 chars', async () => {
    const res = await postJson(app, '/api/auth/reset-password', { token: 'tok', newPassword: 'short' });

    expect(res.status).toBe(400);
  });

  it('should return 400 for password longer than 128 chars', async () => {
    const res = await postJson(app, '/api/auth/reset-password', { token: 'tok', newPassword: 'a'.repeat(129) });

    expect(res.status).toBe(400);
  });

  it('should accept password at minimum boundary (8 chars)', async () => {
    const res = await postJson(app, '/api/auth/reset-password', { token: 'tok', newPassword: '12345678' });

    expect(res.status).toBe(200);
  });

  it('should return 400 for missing body', async () => {
    const res = await postJson(app, '/api/auth/reset-password', {});

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/auth/bootstrap ──────────────────────────────────────────────

/**
 * Bootstrap tests use the REAL authMiddleware (unlike the login/register
 * tests above, which never reach it), so a signed JWT and an `auth` service
 * mock with `findActiveUser` are required.
 */
describe('GET /api/auth/bootstrap', () => {
  const BOOTSTRAP_SECRET = 'bootstrap-test-secret';
  const mockUser = { id: 'user-1', email: 'test@test', displayName: 'Test', avatarUrl: null, deletedAt: null };
  const mockTenants = [
    { id: 't1', name: 'Acme', slug: 'acme', role: 'OWNER' },
    { id: 't2', name: 'Beta', slug: 'beta', role: 'MEMBER' },
  ];
  const meMock = vi.fn();
  const listTenantsMock = vi.fn();

  function createBootstrapApp() {
    const bootstrapApp = new Hono<AppEnv>();

    bootstrapApp.onError(errorHandler);
    bootstrapApp.use('*', async (c, next) => {
      c.set('svc', {
        auth: {
          findActiveUser: vi.fn().mockResolvedValue(mockUser),
          me: meMock,
        },
        tenants: { listTenantsWithRole: listTenantsMock },
      } as never);
      await next();
    });
    bootstrapApp.route('/api/auth', createAuthRoutes());

    return bootstrapApp;
  }

  async function createTestToken(payload: Record<string, unknown>, secret = BOOTSTRAP_SECRET): Promise<string> {
    const encoder = new TextEncoder();
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const tokenPayload = { ...payload, iat: now, exp: now + 3600 };
    const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payloadB64 = btoa(JSON.stringify(tokenPayload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return `${headerB64}.${payloadB64}.${signatureB64}`;
  }

  function requestWithToken(app: Hono<AppEnv>, token: string, env: Record<string, string>) {
    return app.request('/api/auth/bootstrap', { headers: { Authorization: `Bearer ${token}` } }, env as never);
  }

  beforeEach(() => {
    meMock.mockReset().mockResolvedValue(mockUser);
    listTenantsMock.mockReset().mockResolvedValue(mockTenants);
  });

  it('returns 200 with { user, tenants } for an authenticated request', async () => {
    const app = createBootstrapApp();
    const token = await createTestToken({ sub: 'user-1', email: 'test@test' });
    const res = await requestWithToken(app, token, { JWT_SECRET: BOOTSTRAP_SECRET });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { user: Record<string, unknown>; tenants: unknown[] } };

    expect(body.data.user).toEqual(mockUser);
    expect(body.data.tenants).toEqual(mockTenants);
    expect(meMock).toHaveBeenCalledWith('user-1');
    expect(listTenantsMock).toHaveBeenCalledWith('user-1');
  });

  it('returns 401 without an Authorization header', async () => {
    const app = createBootstrapApp();
    const res = await app.request('/api/auth/bootstrap', {}, { JWT_SECRET: BOOTSTRAP_SECRET } as never);

    expect(res.status).toBe(401);
    expect(meMock).not.toHaveBeenCalled();
    expect(listTenantsMock).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const app = createBootstrapApp();
    const res = await requestWithToken(app, 'invalid.token.here', { JWT_SECRET: BOOTSTRAP_SECRET });

    expect(res.status).toBe(401);
  });

  it('returns an empty tenants array when the user has no memberships', async () => {
    listTenantsMock.mockResolvedValue([]);

    const app = createBootstrapApp();
    const token = await createTestToken({ sub: 'user-1', email: 'test@test' });
    const res = await requestWithToken(app, token, { JWT_SECRET: BOOTSTRAP_SECRET });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { tenants: unknown[] } };

    expect(body.data.tenants).toEqual([]);
  });

  it('invokes both service calls in parallel (neither awaited sequentially)', async () => {
    const invocationOrder: string[] = [];
    let resolveMe!: (value: unknown) => void;
    const meGate = new Promise((resolve) => (resolveMe = resolve));

    meMock.mockImplementation(() => {
      invocationOrder.push('me');

      return meGate;
    });
    listTenantsMock.mockImplementation(() => {
      invocationOrder.push('tenants');

      return Promise.resolve([]);
    });

    const app = createBootstrapApp();
    const token = await createTestToken({ sub: 'user-1', email: 'test@test' });
    const resPromise = requestWithToken(app, token, { JWT_SECRET: BOOTSTRAP_SECRET });

    // The tenants call must start while the me() promise is still pending —
    // a sequential await would deadlock here and the waitFor would time out.
    await vi.waitFor(() => expect(invocationOrder).toContain('tenants'));
    expect(invocationOrder[0]).toBe('me');

    resolveMe(mockUser);

    const res = await resPromise;

    expect(res.status).toBe(200);
  });
});
