import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  echoedRequestId,
  getRequestCorrelation,
  requestIdMiddleware,
  resolveRequestCorrelation,
  runWithRequestCorrelation,
} from './request-id.js';
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
  app.get('/echo', (c) => c.json({ requestId: c.get('requestId'), upstreamRequestId: c.get('upstreamRequestId') }));

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
  it('echoes a valid incoming X-Request-Id back to the caller', async () => {
    const res = await createApp().request('/echo', { headers: { 'X-Request-Id': VALID_ID } });

    // The upstream convenience is preserved: a gateway that sent an id still
    // sees that id on the response.
    expect(res.headers.get('X-Request-Id')).toBe(VALID_ID);
  });

  it('records a valid incoming X-Request-Id as the UPSTREAM id, not as the correlation id', async () => {
    const res = await createApp().request('/echo', { headers: { 'X-Request-Id': VALID_ID } });
    const body = (await res.json()) as { requestId: string; upstreamRequestId: string | null };

    // The two ids are kept distinct: the audit trail is keyed on a value the
    // caller does not control, and the caller's value is kept beside it only for
    // traceability.
    expect(body.upstreamRequestId).toBe(VALID_ID);
    expect(body.requestId).not.toBe(VALID_ID);
    expect(body.requestId).toMatch(UUID_PATTERN);
  });

  it('generates a fresh UUID for a malformed header and drops the malformed value', async () => {
    const res = await createApp().request('/echo', { headers: { 'X-Request-Id': 'not-a-uuid' } });
    const body = (await res.json()) as { requestId: string; upstreamRequestId: string | null };

    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(body.upstreamRequestId).toBeNull();
    expect(res.headers.get('X-Request-Id')).toBe(body.requestId);
  });

  it('generates a fresh UUID when the header is absent', async () => {
    const res = await createApp().request('/echo');
    const body = (await res.json()) as { requestId: string; upstreamRequestId: string | null };

    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(body.upstreamRequestId).toBeNull();
    expect(res.headers.get('X-Request-Id')).toBe(body.requestId);
  });

  it('never lets a client-supplied id become the correlation id, however it is spelled', async () => {
    // Same id sent twice must produce two DIFFERENT correlation ids, or an
    // audit trail keyed on that value would merge unrelated requests into one
    // apparent chain.
    const app = createApp();
    const send = async () =>
      (await (await app.request('/echo', { headers: { 'X-Request-Id': VALID_ID } })).json()) as { requestId: string };

    expect((await send()).requestId).not.toBe((await send()).requestId);
  });

  it('generates different ids for different requests', async () => {
    const app = createApp();
    const first = ((await (await app.request('/echo')).json()) as { requestId: string }).requestId;
    const second = ((await (await app.request('/echo')).json()) as { requestId: string }).requestId;

    expect(first).not.toBe(second);
  });

  it('exposes the correlation pair to the service layer for the whole chain', async () => {
    const app = new Hono<AppEnv>();
    let seen: { requestId: string; upstreamRequestId: string | null } | undefined;

    app.use('*', requestIdMiddleware);
    app.get('/probe', () => {
      seen = getRequestCorrelation();

      return c_json();
    });

    await app.request('/probe', { headers: { 'X-Request-Id': VALID_ID } });

    expect(seen?.upstreamRequestId).toBe(VALID_ID);
    expect(seen?.requestId).toMatch(UUID_PATTERN);
    expect(seen?.requestId).not.toBe(VALID_ID);
  });

  it('reports no correlation outside a request context', () => {
    expect(getRequestCorrelation()).toBeUndefined();
  });

  it('gives every concurrent request its own correlation', async () => {
    const app = new Hono<AppEnv>();
    const seen: string[] = [];

    app.use('*', requestIdMiddleware);
    app.get('/probe', async (c) => {
      // Yield, so an implementation that stored the correlation on the app
      // rather than per request would interleave these two.
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(c.get('requestId'));

      return c.json({ data: true });
    });

    await Promise.all([app.request('/probe'), app.request('/probe')]);

    expect(new Set(seen).size).toBe(2);
  });
});

/** Minimal typed helper so the probe route above stays a one-liner. */
function c_json(): Response {
  return new Response(JSON.stringify({ data: true }), { headers: { 'content-type': 'application/json' } });
}

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

describe('resolveRequestCorrelation', () => {
  it('keeps a valid UUID in any case as the UPSTREAM id', () => {
    expect(resolveRequestCorrelation(VALID_ID.toUpperCase()).upstreamRequestId).toBe(VALID_ID.toUpperCase());
  });

  it('always mints its own correlation id, whatever the header says', () => {
    const correlation = resolveRequestCorrelation(VALID_ID);

    expect(correlation.requestId).not.toBe(VALID_ID);
    expect(correlation.requestId).toMatch(UUID_PATTERN);
  });

  it('drops a malformed header instead of sanitizing it', () => {
    // Sanitizing would let a caller shape the recorded value; dropping leaves
    // nothing to attribute.
    expect(resolveRequestCorrelation('../etc/passwd').upstreamRequestId).toBeNull();
    expect(resolveRequestCorrelation(undefined).upstreamRequestId).toBeNull();
  });

  it('echoes the caller id when there is one and the minted id otherwise', () => {
    expect(echoedRequestId(resolveRequestCorrelation(VALID_ID))).toBe(VALID_ID);
    expect(echoedRequestId(resolveRequestCorrelation(undefined))).toMatch(UUID_PATTERN);
  });
});

describe('runWithRequestCorrelation', () => {
  it('makes the correlation visible only inside the callback', async () => {
    const correlation = resolveRequestCorrelation(VALID_ID);

    await runWithRequestCorrelation(correlation, async () => {
      expect(getRequestCorrelation()).toBe(correlation);
    });

    expect(getRequestCorrelation()).toBeUndefined();
  });
});
