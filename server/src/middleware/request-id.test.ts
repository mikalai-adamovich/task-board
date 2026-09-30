import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware, resolveRequestId } from './request-id.js';
import { errorHandler } from './error-handler.js';
import { createNotFoundHandler } from './not-found.js';
import { NotFoundError } from '../errors/app-error.js';
import { getServerTimings, trackDbCall } from '../utils/timings.js';
import type { AppEnv } from '../types/context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ID = '123e4567-e89b-12d3-a456-426614174000';
/** `metric;dur=<integer ms>[;desc="…"]`, comma-separated — the spec grammar. */
const METRIC = /^[a-z][a-z0-9_-]*;dur=\d+(;desc="[^"]*")?$/;

function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', requestIdMiddleware);
  app.get('/echo', (c) => c.json({ requestId: c.get('requestId') }));

  return app;
}

/** Assert the header is present and every metric in it is well-formed. */
function expectValidServerTimings(res: Response): string {
  const header = res.headers.get('Server-Timings');

  expect(header).toBeTruthy();
  for (const entry of (header as string).split(', ')) {
    expect(entry).toMatch(METRIC);
  }

  return header as string;
}

describe('requestIdMiddleware', () => {
  it('passes through a valid incoming X-Request-Id', async () => {
    const res = await createApp().request('/echo', { headers: { 'X-Request-Id': VALID_ID } });
    const body = (await res.json()) as { requestId: string };

    expect(res.headers.get('X-Request-Id')).toBe(VALID_ID);
    expect(body.requestId).toBe(VALID_ID);
  });

  it('generates a fresh UUID for a malformed header', async () => {
    const res = await createApp().request('/echo', { headers: { 'X-Request-Id': 'not-a-uuid' } });
    const body = (await res.json()) as { requestId: string };

    expect(body.requestId).not.toBe('not-a-uuid');
    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(res.headers.get('X-Request-Id')).toBe(body.requestId);
  });

  it('generates a fresh UUID when the header is absent', async () => {
    const res = await createApp().request('/echo');
    const body = (await res.json()) as { requestId: string };

    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(res.headers.get('X-Request-Id')).toBe(body.requestId);
  });

  it('generates different ids for different requests', async () => {
    const app = createApp();
    const first = ((await (await app.request('/echo')).json()) as { requestId: string }).requestId;
    const second = ((await (await app.request('/echo')).json()) as { requestId: string }).requestId;

    expect(first).not.toBe(second);
  });
});

describe('Server-Timings (F15)', () => {
  it('emits a syntactically valid header on a success response', async () => {
    const header = expectValidServerTimings(await createApp().request('/echo'));

    expect(header).toContain('total;dur=');
    expect(header).toContain('db;dur=');
    expect(header).toContain('app;dur=');
    // No database was touched on this route — a `firstdb` of 0 would be a lie.
    expect(header).not.toContain('firstdb');
  });

  it('reports the database split once a request really used the database', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', requestIdMiddleware);
    app.get('/list', async (c) => {
      await trackDbCall(() => new Promise((resolve) => setTimeout(resolve, 5)));

      return c.json({ data: [] });
    });

    const header = expectValidServerTimings(await app.request('/list'));
    const dur = (name: string): number =>
      Number((header.split(', ').find((m) => m.startsWith(`${name};`)) as string).split(';dur=')[1]?.split(';')[0]);

    expect(header).toContain('firstdb;dur=');
    expect(dur('db')).toBeGreaterThan(0);
    // db + app reconstructs total (within the 1 ms rounding each duration is
    // rendered with): the header is internally consistent.
    expect(Math.abs(dur('db') + dur('app') - dur('total'))).toBeLessThanOrEqual(1);
  });

  it('exposes the timings store to the whole request chain', async () => {
    const app = new Hono<AppEnv>();
    let seenInHandler: unknown;

    app.use('*', requestIdMiddleware);
    app.get('/probe', (c) => {
      seenInHandler = getServerTimings();

      return c.json({ data: true });
    });

    await app.request('/probe');

    expect(seenInHandler).toBeDefined();
  });

  it('is emitted on an ERROR response built by the error handler', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', requestIdMiddleware);
    app.onError(errorHandler);
    app.get('/boom', () => {
      throw new NotFoundError('Task not found');
    });

    const res = await app.request('/boom');

    expect(res.status).toBe(404);
    expectValidServerTimings(res);
  });

  it('is emitted on the not-found / method-not-allowed responses', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', requestIdMiddleware);
    app.onError(errorHandler);
    app.get('/known', (c) => c.json({ data: true }));
    app.notFound(createNotFoundHandler(() => app.routes));

    const missing = await app.request('/nope');
    const wrongMethod = await app.request('/known', { method: 'POST' });

    expect(missing.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expectValidServerTimings(missing);
    expectValidServerTimings(wrongMethod);
  });

  it('is emitted on a response a downstream middleware produced inline', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', requestIdMiddleware);
    // Stands in for the `DB_UNAVAILABLE` 503 of `app.ts`: an inline response
    // that short-circuits before any handler runs.
    app.use('/db', async (c) => c.json({ error: { code: 'DB_UNAVAILABLE', message: 'no db' } }, 503));

    const res = await app.request('/db');

    expect(res.status).toBe(503);
    expectValidServerTimings(res);
  });
});

describe('resolveRequestId', () => {
  it('trusts a valid UUID in any case', () => {
    expect(resolveRequestId(VALID_ID.toUpperCase())).toBe(VALID_ID.toUpperCase());
  });

  it('rejects malformed values and generates a UUID', () => {
    expect(resolveRequestId('../etc/passwd')).toMatch(UUID_PATTERN);
    expect(resolveRequestId(undefined)).toMatch(UUID_PATTERN);
  });
});
