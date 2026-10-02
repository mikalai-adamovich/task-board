import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import * as z from 'zod';
import {
  errorHandler,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  AppError,
} from './error-handler.js';
import { requestIdMiddleware } from './request-id.js';
import { MAX_TIME_MS_EXPIRED_CODE, isQueryTimeoutError } from '../db/query-timeout.js';

/** Helper to extract the `error` object from a JSON response. */
async function errorBody(res: Response) {
  const json = (await res.json()) as { error: { code: string; message: string; details?: unknown } };

  return json.error;
}

function createTestApp() {
  const app = new Hono();

  app.onError(errorHandler);

  app.get('/not-found', () => {
    throw new NotFoundError('User not found');
  });

  app.get('/unauthorized', () => {
    throw new UnauthorizedError('Token expired');
  });

  app.get('/forbidden', () => {
    throw new ForbiddenError('No access');
  });

  app.get('/validation', () => {
    throw new ValidationError('Invalid input', [{ field: 'email', message: 'Invalid email' }]);
  });

  app.get('/conflict', () => {
    throw new ConflictError('Already exists');
  });

  app.get('/conflict-specific', () => {
    throw new ConflictError('Task was modified', 'TASK_VERSION_CONFLICT');
  });

  app.get('/custom', () => {
    throw new AppError(403, 'PROJECT_ARCHIVED', 'Cannot modify archived project');
  });

  // An AppError may carry response headers (Retry-After / RateLimit-*).
  app.get('/rate-limited', () => {
    throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Try again later.', undefined, {
      'Retry-After': '900',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '900',
    });
  });

  app.get('/zod-error', (c) => {
    const schema = z.object({ email: z.email() });
    const result = schema.safeParse({ email: 'bad' });

    if (!result.success) {
      throw result.error;
    }
    return c.json({ ok: true });
  });

  // What MongoDB actually throws when a query exceeds its maxTimeMS budget.
  app.get('/query-timeout', () => {
    throw Object.assign(new Error('operation exceeded time limit'), {
      name: 'MongoServerError',
      code: 50,
      codeName: 'MaxTimeMSExpired',
    });
  });

  app.get('/unknown', () => {
    throw new Error('Something broke');
  });

  app.get('/ok', (c) => {
    return c.json({ success: true });
  });

  return app;
}

describe('errorHandler', () => {
  const app = createTestApp();

  it('passes through successful requests', async () => {
    const res = await app.request('/ok');

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({ success: true });
  });

  it('returns 404 for NotFoundError', async () => {
    const res = await app.request('/not-found');

    expect(res.status).toBe(404);

    const err = await errorBody(res);

    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('User not found');
  });

  it('returns 401 for UnauthorizedError', async () => {
    const res = await app.request('/unauthorized');

    expect(res.status).toBe(401);

    const err = await errorBody(res);

    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Token expired');
  });

  it('returns 403 for ForbiddenError', async () => {
    const res = await app.request('/forbidden');

    expect(res.status).toBe(403);

    const err = await errorBody(res);

    expect(err.code).toBe('FORBIDDEN');
  });

  it('returns 400 for ValidationError with details', async () => {
    const res = await app.request('/validation');

    expect(res.status).toBe(400);

    const err = await errorBody(res);

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual([{ field: 'email', message: 'Invalid email' }]);
  });

  it('returns 409 for ConflictError', async () => {
    const res = await app.request('/conflict');

    expect(res.status).toBe(409);

    const err = await errorBody(res);

    expect(err.code).toBe('CONFLICT');
  });

  it('returns 409 for specific conflict codes', async () => {
    const res = await app.request('/conflict-specific');

    expect(res.status).toBe(409);

    const err = await errorBody(res);

    expect(err.code).toBe('TASK_VERSION_CONFLICT');
  });

  it('omits requestId when the request-id middleware is not mounted', async () => {
    const res = await app.request('/not-found');
    const err = (await errorBody(res)) as { requestId?: string };

    expect(err.requestId).toBeUndefined();
  });

  it('returns custom status code and code for AppError', async () => {
    const res = await app.request('/custom');

    expect(res.status).toBe(403);

    const err = await errorBody(res);

    expect(err.code).toBe('PROJECT_ARCHIVED');
    expect(err.message).toBe('Cannot modify archived project');
  });

  it('returns 400 VALIDATION_ERROR for ZodError', async () => {
    const res = await app.request('/zod-error');

    expect(res.status).toBe(400);

    const err = await errorBody(res);

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Request validation failed');
    expect(Array.isArray(err.details)).toBe(true);
    expect((err.details as unknown[]).length).toBeGreaterThan(0);
  });

  // ── A maxTimeMS expiry is a KNOWN outcome, not an internal error ───────────
  it('maps a MongoDB maxTimeMS expiry to 503 QUERY_TIMEOUT in the standard envelope', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await app.request('/query-timeout');

      expect(res.status).toBe(503);

      const err = await errorBody(res);

      expect(err.code).toBe('QUERY_TIMEOUT');
      expect(err.message).toMatch(/too long/i);
      // The operator keeps the cause; the client never sees it.
      expect(consoleSpy).toHaveBeenCalledOnce();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('does not leak the driver message, the collection, or a stack to the client', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await app.request('/query-timeout');
      const raw = await res.text();

      // The raw driver string is the only clue an operator had before F11 — and
      // it must not become a client-visible oracle for query shapes.
      expect(raw).not.toMatch(/exceeded time limit/i);
      expect(raw).not.toMatch(/MaxTimeMSExpired/);
      expect(raw).not.toMatch(/MongoServerError/);
      expect(raw).not.toContain('stack');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('still classifies every other error as before (a non-timeout driver error is a 500)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await app.request('/unknown');

      expect(res.status).toBe(500);
      expect((await errorBody(res)).code).toBe('INTERNAL_ERROR');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns 500 for unknown errors without leaking stack', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await app.request('/unknown');

      expect(res.status).toBe(500);

      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error as Record<string, unknown>;

      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.message).toBe('An unexpected error occurred');
      expect(json).not.toHaveProperty('stack');
      expect(consoleSpy).toHaveBeenCalledOnce();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('all responses are wrapped in { error: { ... } }', async () => {
    const endpoints = [
      '/not-found',
      '/unauthorized',
      '/forbidden',
      '/validation',
      '/conflict',
      '/unknown',
      '/query-timeout',
    ];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      for (const endpoint of endpoints) {
        const res = await app.request(endpoint);
        const json = (await res.json()) as Record<string, unknown>;

        expect(json).toHaveProperty('error');
        expect(typeof json.error).toBe('object');
        expect(json.error).toHaveProperty('code');
        expect(json.error).toHaveProperty('message');
      }
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

/**
 * The predicate behind the mapping above. Driver-agnostic by design: it reads
 * `code` / `codeName` instead of `instanceof MongoServerError`, so the Durable
 * Object transport and a plain object in a test are classified identically.
 */
describe('isQueryTimeoutError (F11)', () => {
  it('recognises the code MongoDB returns for an expired maxTimeMS', () => {
    expect(isQueryTimeoutError({ code: MAX_TIME_MS_EXPIRED_CODE })).toBe(true);
    expect(isQueryTimeoutError({ codeName: 'MaxTimeMSExpired' })).toBe(true);
    expect(isQueryTimeoutError({ code: 50, codeName: 'MaxTimeMSExpired' })).toBe(true);
  });

  it('does not swallow other driver failures into a 503', () => {
    // E11000 DuplicateKey, E11001 legacy duplicate, an exhausted pool, a
    // server-selection timeout — all of these must stay 500, because reporting
    // them as "your query was too slow" would send an operator hunting a
    // maxTimeMS budget that does not exist.
    expect(isQueryTimeoutError({ code: 11000, codeName: 'DuplicateKey' })).toBe(false);
    expect(isQueryTimeoutError({ code: 89, codeName: 'NetworkTimeout' })).toBe(false);
    expect(isQueryTimeoutError(new Error('nope'))).toBe(false);
  });

  it('treats the numeric code as sufficient on its own (codeName is not always populated)', () => {
    // A driver/transport that drops `codeName` must not lose the classification.
    expect(isQueryTimeoutError({ code: 50 })).toBe(true);
  });

  it('tolerates non-error inputs (the handler is reached with anything)', () => {
    for (const value of [null, undefined, 'timeout', 42]) {
      expect(isQueryTimeoutError(value)).toBe(false);
    }
  });
});

describe('errorHandler request-id correlation (M-10)', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST_ID = '123e4567-e89b-12d3-a456-426614174000';

  function createAppWithRequestId() {
    const app = new Hono();

    app.use('*', requestIdMiddleware);
    app.onError(errorHandler);
    app.get('/boom', () => {
      throw new NotFoundError('User not found');
    });

    return app;
  }

  it('echoes the incoming X-Request-Id but reports the SERVER id in the envelope', async () => {
    const res = await createAppWithRequestId().request('/boom', {
      headers: { 'X-Request-Id': REQUEST_ID },
    });

    expect(res.status).toBe(404);
    // The header still carries the caller's own id, so a gateway sees its id
    // come back...
    expect(res.headers.get('X-Request-Id')).toBe(REQUEST_ID);

    const err = (await errorBody(res)) as { requestId?: string };

    // ...while the envelope carries the id the logs are keyed on, which a caller
    // cannot choose. If these were the same value, a client could replay one id
    // across unrelated failures and merge them into a single apparent chain.
    expect(err.requestId).not.toBe(REQUEST_ID);
    expect(err.requestId).toMatch(UUID_PATTERN);
  });

  it('generates a request id when the header is absent', async () => {
    const res = await createAppWithRequestId().request('/boom');
    const err = (await errorBody(res)) as { requestId?: string };

    expect(err.requestId).toMatch(UUID_PATTERN);
    expect(res.headers.get('X-Request-Id')).toBe(err.requestId);
  });
});

// ─── Error-carried response headers ───────────────────────────────────────────

describe('errorHandler — AppError response headers (W-42)', () => {
  it('applies Retry-After and RateLimit-* to the 429 response', async () => {
    const app = createTestApp();
    const res = await app.request('/rate-limited');

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(res.headers.get('RateLimit-Limit')).toBe('10');
    expect(res.headers.get('RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('RateLimit-Reset')).toBe('900');
  });

  it('keeps the error envelope intact alongside the headers', async () => {
    const app = createTestApp();
    const res = await app.request('/rate-limited');
    const body = await errorBody(res);

    expect(body.code).toBe('RATE_LIMITED');
    expect(body.message).toBe('Too many login attempts. Try again later.');
  });

  it('does not invent headers for an AppError that carries none', async () => {
    const app = createTestApp();
    const res = await app.request('/conflict');

    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(res.headers.get('RateLimit-Limit')).toBeNull();
  });
});
