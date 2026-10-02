import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { RouterRoute } from 'hono/types';
import type { AppEnv } from '../types/context.js';
import { NotFoundError } from '../errors/app-error.js';
import { errorHandler } from './error-handler.js';
import { requestIdMiddleware } from './request-id.js';
import { createNotFoundHandler, findAllowedMethods, routePatternToRegExp } from './not-found.js';

/**
 * The router-level 404/405 responses used to escape the
 * documented `{ error: { code, message, requestId } }` envelope entirely —
 * Hono's default notFound is a bare text/plain "404 Not Found", and it also
 * swallows "path exists, method does not" (Hono has no built-in 405).
 *
 * These tests pin the three shapes that must stay distinguishable:
 *   1. unknown path                → 404 NOT_FOUND  (generic router message)
 *   2. wrong method on known path  → 405 METHOD_NOT_ALLOWED (+ Allow header)
 *   3. 404 raised INSIDE a route   → 404 NOT_FOUND  (domain message, from onError)
 */

/** A miniature app wired exactly like the real one: requestId + onError + notFound. */
function createTestApp() {
  const app = new Hono<AppEnv>();

  app.use('*', requestIdMiddleware);
  app.onError(errorHandler);
  app.get('/api/projects/:projectId/tasks', (c) => c.json({ data: [] }));
  app.post('/api/projects/:projectId/tasks', (c) => c.json({ data: [] }));
  app.delete('/api/projects/:projectId/tasks', (c) => c.json({ data: [] }));
  app.get('/api/tenants/:tenantId', (c) => c.json({ data: [] }));
  app.get('/api/boom/:id', (c) => {
    throw new NotFoundError(`Sprint ${c.req.param('id')} not found`);
  });
  // Middleware registered via app.use must NOT count as an endpoint for 405.
  app.use('/api/only-middleware', async (_c, next) => next());

  app.notFound(createNotFoundHandler(() => app.routes));

  return app;
}

const app = createTestApp();

describe('router-level notFound handler (M-045 / M-247)', () => {
  describe('unknown path', () => {
    it('answers 404 with the standard error envelope (never raw text/plain)', async () => {
      const res = await app.request('/api/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toContain('application/json');

      const body = (await res.json()) as { error: { code: string; message: string; requestId?: string } };

      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Resource not found');
      expect(typeof body.error.message).toBe('string');
    });

    it('echoes the caller id on the header and reports the server id in the envelope', async () => {
      const res = await app.request('/api/does-not-exist', {
        headers: { 'X-Request-Id': '11111111-2222-3333-4444-555555555555' },
      });
      const body = (await res.json()) as { error: { requestId?: string } };

      // The envelope carries the id the logs are keyed on — minted here, not
      // taken from the header — while the header still echoes the caller's own
      // id so the upstream keeps seeing it come back.
      expect(body.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(body.error.requestId).not.toBe('11111111-2222-3333-4444-555555555555');
      expect(res.headers.get('X-Request-Id')).toBe('11111111-2222-3333-4444-555555555555');
    });

    it('still answers 404 for an unknown path with a trailing slash', async () => {
      const res = await app.request('/api/does-not-exist/');

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });
  });

  describe('wrong method on a known path', () => {
    it('answers 405 (not 404) with the standard envelope', async () => {
      const res = await app.request('/api/projects/p1/tasks', { method: 'PUT' });

      expect(res.status).toBe(405);

      const body = (await res.json()) as { error: { code: string; message: string; requestId?: string } };

      expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
      expect(body.error.message).toContain('PUT');
      expect(typeof body.error.requestId).toBe('string');
    });

    it('lists the supported methods in the Allow header', async () => {
      const res = await app.request('/api/projects/p1/tasks', { method: 'PUT' });
      const allow = (res.headers.get('Allow') ?? '').split(', ');

      expect(allow).toContain('GET');
      expect(allow).toContain('POST');
      expect(allow).toContain('DELETE');
      expect(allow).toContain('PUT');
    });

    it('still answers the registered method normally', async () => {
      const res = await app.request('/api/projects/p1/tasks', { method: 'GET' });

      expect(res.status).toBe(200);
    });

    it('does not treat middleware-only paths as endpoints (stays 404)', async () => {
      const res = await app.request('/api/only-middleware', { method: 'PUT' });

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });
  });

  describe('404 raised inside a route stays distinguishable', () => {
    it('keeps the domain-specific message from the route (onError path, not the router)', async () => {
      const res = await app.request('/api/boom/sprint-42');

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: { code: string; message: string } };

      expect(body.error.code).toBe('NOT_FOUND');
      // Distinct from the router's generic message — this is what the two 404
      // shapes are told apart by.
      expect(body.error.message).toBe('Sprint sprint-42 not found');
      expect(body.error.message).not.toBe('Resource not found');
    });
  });
});

describe('routePatternToRegExp', () => {
  it('matches a concrete path against a :param pattern', () => {
    const re = routePatternToRegExp('/api/projects/:projectId/tasks');

    expect(re.test('/api/projects/p1/tasks')).toBe(true);
    expect(re.test('/api/projects/p1/labels')).toBe(false);
    expect(re.test('/api/projects/p1/tasks/extra')).toBe(false);
  });

  it('matches a * wildcard across the remainder of the path', () => {
    const re = routePatternToRegExp('/files/*');

    expect(re.test('/files/a')).toBe(true);
    expect(re.test('/files/a/b/c')).toBe(true);
    expect(re.test('/files')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = routePatternToRegExp('/a.b/c+d');

    expect(re.test('/a.b/c+d')).toBe(true);
    expect(re.test('/axb/cxd')).toBe(false);
  });

  it('tolerates a trailing slash', () => {
    expect(routePatternToRegExp('/api/ping').test('/api/ping/')).toBe(true);
  });
});

describe('findAllowedMethods', () => {
  // Only `path` and `method` are read by findAllowedMethods; the handler is a
  // placeholder that the helper never calls.
  const noopHandler = () => undefined;
  const routes: RouterRoute[] = [
    { basePath: '/', path: '/api/tasks', method: 'GET', handler: noopHandler },
    { basePath: '/', path: '/api/tasks', method: 'POST', handler: noopHandler },
    { basePath: '/', path: '/api/mw', method: 'ALL', handler: noopHandler },
  ];

  it('returns the other methods registered for a matching path, sorted', () => {
    expect(findAllowedMethods(routes, '/api/tasks', 'GET')).toEqual(['POST']);
  });

  it('never reports the current method', () => {
    expect(findAllowedMethods(routes, '/api/tasks', 'GET')).not.toContain('GET');
  });

  it('ignores ALL (middleware) entries', () => {
    expect(findAllowedMethods(routes, '/api/mw', 'GET')).toEqual([]);
  });

  it('returns nothing for a path that matches no route', () => {
    expect(findAllowedMethods(routes, '/api/nope', 'GET')).toEqual([]);
  });
});
