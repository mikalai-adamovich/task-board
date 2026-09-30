/**
 * Tests for the per-user authenticated-route rate limiter and for
 * the client-identifier resolution used by the login limiters.
 *
 * The limiter is verified through a real Hono app with the standard
 * `{ error: { code, message } }` envelope and the F6 `Retry-After` headers, so
 * the wiring (middleware → error handler) is covered, not just the counter.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  AUTH_MAX_REQUESTS,
  UNKNOWN_CLIENT_ID,
  authRateLimit,
  clientIdentifier,
  isRateLimitExempt,
} from './rate-limit.js';
import { errorHandler } from './error-handler.js';
import type { AppEnv } from '../types/context.js';

const TEST_ENV = { JWT_SECRET: 'test-secret', MONGODB_URI: '', ALLOWED_ORIGINS: '*' };

/**
 * Minimal stand-in for `authMiddleware`: it does exactly what the limiter
 * depends on — set `userId` from the VERIFIED token — and nothing else.
 */
function createTestApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('/api/*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') ?? 'user-1');
    await next();
  });

  app.use('/api/*', authRateLimit());

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/ping', (c) => c.json({ status: 'ok' }));
  app.get('/api/readyz', (c) => c.json({ status: 'ok' }));
  app.get('/api/tasks', (c) => c.json({ data: [] }));
  app.get('/api/audit', (c) => c.json({ data: [] }));

  return app;
}

describe('clientIdentifier (M-007)', () => {
  it('uses CF-Connecting-IP — the edge-overwritten header', () => {
    const c = { req: { header: (name: string) => (name === 'CF-Connecting-IP' ? '203.0.113.7' : undefined) } };

    expect(clientIdentifier(c)).toBe('203.0.113.7');
  });

  it('does NOT read X-Forwarded-For (a client-settable header)', () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === 'X-Forwarded-For') return '1.2.3.4, 5.6.7.8';
          return undefined;
        },
      },
    };

    // The whole point: a client cannot mint itself a fresh budget by varying
    // X-Forwarded-For, so that header is simply not consulted.
    expect(clientIdentifier(c)).toBe(UNKNOWN_CLIENT_ID);
  });

  it('falls back to one shared coarse bucket when the edge header is absent', () => {
    const c = { req: { header: () => undefined } };

    expect(clientIdentifier(c)).toBe(UNKNOWN_CLIENT_ID);
  });

  it('treats an empty/whitespace header as absent', () => {
    expect(clientIdentifier({ req: { header: () => '   ' } })).toBe(UNKNOWN_CLIENT_ID);
  });
});

describe('isRateLimitExempt', () => {
  it.each(['/api/health', '/api/ping', '/api/readyz'])('exempts %s', (path) => {
    expect(isRateLimitExempt(path, 'GET')).toBe(true);
  });

  it('exempts CORS preflights', () => {
    expect(isRateLimitExempt('/api/tasks', 'OPTIONS')).toBe(true);
  });

  it('does not exempt ordinary routes', () => {
    expect(isRateLimitExempt('/api/tasks', 'GET')).toBe(false);
    expect(isRateLimitExempt('/api/tenants/t1/members/invite', 'POST')).toBe(false);
  });
});

describe('authRateLimit (M-008)', () => {
  it('lets normal traffic through', async () => {
    const app = createTestApp();
    const res = await app.request('/api/tasks', { headers: { 'X-Test-User': 'user-normal' } }, TEST_ENV);

    expect(res.status).toBe(200);
  });

  it('trips after the configured ceiling and answers 429 with Retry-After (F6 headers)', async () => {
    const app = createTestApp();
    const user = 'user-flood';
    let limited: Response | null = null;

    for (let i = 0; i < AUTH_MAX_REQUESTS + 1; i++) {
      const res = await app.request('/api/tasks', { headers: { 'X-Test-User': user } }, TEST_ENV);

      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    if (limited === null) {
      throw new Error('the per-user limiter never tripped');
    }

    const body = (await limited.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toBe('Too many requests. Try again later.');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(limited.headers.get('RateLimit-Limit')).toBe(String(AUTH_MAX_REQUESTS));
    expect(limited.headers.get('RateLimit-Remaining')).toBe('0');
  });

  it('keys on the authenticated user id, so one user cannot throttle another', async () => {
    const app = createTestApp();

    for (let i = 0; i < AUTH_MAX_REQUESTS + 5; i++) {
      await app.request('/api/tasks', { headers: { 'X-Test-User': 'user-noisy' } }, TEST_ENV);
    }

    const other = await app.request('/api/tasks', { headers: { 'X-Test-User': 'user-quiet' } }, TEST_ENV);

    expect(other.status).toBe(200);
  });

  it('is not defeatable by a client-supplied header (the key is the token subject)', async () => {
    const app = createTestApp();
    let limited = false;

    for (let i = 0; i < AUTH_MAX_REQUESTS + 1; i++) {
      // Each request claims a different spoofed source — irrelevant to the key.
      const res = await app.request(
        '/api/tasks',
        {
          headers: { 'X-Test-User': 'user-victim', 'CF-Connecting-IP': `10.0.0.${i}` },
        },
        TEST_ENV,
      );

      if (res.status === 429) {
        limited = true;
        break;
      }
    }

    expect(limited).toBe(true);
  });

  it.each(['/api/health', '/api/ping', '/api/readyz'])('never throttles %s (even past the ceiling)', async (path) => {
    const app = createTestApp();
    const user = `user-probe-${path}`;

    for (let i = 0; i < AUTH_MAX_REQUESTS + 20; i++) {
      const res = await app.request(path, { headers: { 'X-Test-User': user } }, TEST_ENV);

      expect(res.status).toBe(200);
    }
  });

  it('keeps the probe endpoints reachable for a user who IS over the ceiling', async () => {
    const app = createTestApp();
    const user = 'user-exhausted-probe';

    for (let i = 0; i < AUTH_MAX_REQUESTS; i++) {
      await app.request('/api/tasks', { headers: { 'X-Test-User': user } }, TEST_ENV);
    }

    const limited = await app.request('/api/tasks', { headers: { 'X-Test-User': user } }, TEST_ENV);
    const probe = await app.request('/api/health', { headers: { 'X-Test-User': user } }, TEST_ENV);

    expect(limited.status).toBe(429);
    expect(probe.status).toBe(200);
  });

  it('applies to every authenticated route, including the invitation route', async () => {
    const app = createTestApp();
    const user = 'user-inviter';

    app.post('/api/tenants/:tenantId/members/invite', (c) => c.json({ data: { ok: true } }));

    let limited = false;

    for (let i = 0; i < AUTH_MAX_REQUESTS + 1; i++) {
      const res = await app.request(
        '/api/tenants/11111111-1111-4111-8111-111111111111/members/invite',
        { method: 'POST', headers: { 'X-Test-User': user } },
        TEST_ENV,
      );

      if (res.status === 429) {
        limited = true;
        break;
      }
    }

    expect(limited).toBe(true);
  });

  it('FAILS CLOSED when no userId is on the context (misconfigured chain)', async () => {
    const app = new Hono<AppEnv>();

    app.onError(errorHandler);
    // No auth middleware → userId never set. The property under test is that a
    // request is never passed through UNCUNTED: passing it through removes the
    // per-user ceiling, which is the regression the per-user limiter exists to prevent. The
    // previous behaviour (`expect(res.status).toBe(200)`) pinned the defect.
    app.use('/api/*', authRateLimit());
    app.get('/api/tasks', (c) => c.json({ data: [] }));

    const res = await app.request('/api/tasks', {}, TEST_ENV);

    expect(res.status).toBe(429);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('RATE_LIMITED');
    // A 429 with no Retry-After is a contract violation — check the absent
    // path carries the headers too.
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(res.headers.get('RateLimit-Limit')).toBe(String(AUTH_MAX_REQUESTS));
  });

  it('keeps the liveness probes reachable even in the un-keyed configuration', async () => {
    const app = new Hono<AppEnv>();

    app.onError(errorHandler);
    app.use('/api/*', authRateLimit());
    app.get('/api/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/api/health', {}, TEST_ENV);

    // The exemption is evaluated BEFORE the key check, so a mis-ordered chain
    // fails loud without making the probe look like an outage.
    expect(res.status).toBe(200);
  });
});
