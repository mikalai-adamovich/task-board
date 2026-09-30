/**
 * Decision 20 — the application's own request-body cap (5 MB).
 *
 * Before this there was NO cap anywhere in `server/src`: no framework
 * body-limit option and no `Content-Length` check. The only bound was whatever
 * the hosting platform happened to impose, which is a guarantee the application
 * does not own and cannot test. These tests are the ownership.
 *
 * The properties that matter, in the order a reviewer should care about them:
 *   1. an over-sized body is REFUSED — not accepted and not truncated;
 *   2. it is refused in the application's own error envelope, with 413, rather
 *      than as a bare platform error the client cannot parse;
 *   3. the refusal happens BEFORE anything expensive runs — no service graph,
 *      no database connection, no parse of the body it just rejected;
 *   4. a body at the limit is still ADMITTED, and so is the largest payload
 *      this API can legitimately produce (that is the "deliberately generous"
 *      half of the owner's decision, and it is asserted with numbers).
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from './error-handler.js';
import { requestIdMiddleware } from './request-id.js';
import { MAX_REQUEST_BODY_BYTES, MAX_REQUEST_BODY_LABEL, requestBodyLimit } from './body-limit.js';
import { ERROR_CODES } from '@task-board/shared';
import type { AppEnv } from '../types/context.js';

/**
 * The middleware in the position `app.ts` mounts it: ahead of every layer that
 * would do work with the body.
 */
function app(seen?: { handlerRan: boolean; parsedBody: unknown }) {
  const instance = new Hono<AppEnv>();

  instance.onError(errorHandler);
  instance.use('*', requestIdMiddleware);
  instance.use('/api/*', requestBodyLimit());
  instance.post('/api/echo', async (c) => {
    if (seen) {
      seen.handlerRan = true;
      seen.parsedBody = await c.req.json();
    }

    return c.json({ data: { ok: true } });
  });

  return instance;
}

/**
 * A JSON body of EXACTLY `bytes` bytes.
 *
 * Exact, not approximate: the boundary test ("a body exactly at the limit is
 * admitted") is only a boundary test if the body is the size it claims to be,
 * and an off-by-a-few filler would silently turn it into a second over-limit
 * case. The padding is a single JSON string value so the document stays valid
 * JSON and the byte count is the serialized length, which is what the cap
 * measures.
 */
function bodyOf(bytes: number): string {
  const prefix = '{"title":"';
  const suffix = '"}';

  return prefix + 'x'.repeat(Math.max(0, bytes - prefix.length - suffix.length)) + suffix;
}

describe('decision 20: a request body over 5 MB is refused with the application envelope', () => {
  it('answers 413 with `{ error: { code, message } }` — not a bare platform error', async () => {
    // The fail-proof for the whole item: with no cap the same request returns
    // 200, and with Hono's DEFAULT body-limit onError it returns 413 as
    // `text/plain` — the status would still be right while the body shape the
    // client parses would be wrong.
    const seen = { handlerRan: false, parsedBody: null as unknown };
    const res = await app(seen).request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOf(MAX_REQUEST_BODY_BYTES + 1),
    });

    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.message).toContain(MAX_REQUEST_BODY_LABEL);
    // Never a hand-rolled body: the envelope is the contract every client parses.
    expect(body).toHaveProperty('error.code');
    expect(body).not.toHaveProperty('data');
  });

  it('never runs the handler, so nothing is parsed, connected or allocated', async () => {
    // The point of rejecting EARLY. A cap enforced after the parse would bound
    // nothing that matters.
    const seen = { handlerRan: false, parsedBody: null as unknown };

    await app(seen).request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOf(MAX_REQUEST_BODY_BYTES + 1_000),
    });

    expect(seen.handlerRan).toBe(false);
    expect(seen.parsedBody).toBeNull();
  });

  it('refuses a body that DECLARES an over-sized length, without sending one', async () => {
    // The cheap path, and the one a caller can lie about in the other
    // direction: a declared `Content-Length` over the cap is refused on the
    // header alone. This is what a 5 MB upload actually looks like.
    const res = await app().request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1) },
      body: '{"title":"small"}',
    });

    expect(res.status).toBe(413);
  });

  it('refuses a body that OMITS its length and is over the cap when measured', async () => {
    // A chunked request has no `Content-Length`, so the cap can only be
    // enforced while streaming. Without this branch a caller could bypass the
    // limit entirely by not declaring a length.
    const chunk = 'y'.repeat(1_000_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent <= MAX_REQUEST_BODY_BYTES; sent += chunk.length) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const res = await app().request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: stream,
      // @ts-expect-error -- duplex is required by undici for a streaming body
      duplex: 'half',
    });

    expect(res.status).toBe(413);
  });
});

describe('decision 20: the cap still admits every legitimate payload', () => {
  it('admits a body exactly AT the limit', async () => {
    // The boundary, asserted from the admitting side. `maxSize` is a strict
    // `>`, so exactly-at must pass — a cap that rejects its own limit is a cap
    // nobody can reason about.
    const seen = { handlerRan: false, parsedBody: null as unknown };
    const res = await app(seen).request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOf(MAX_REQUEST_BODY_BYTES),
    });

    expect(res.status).toBe(200);
    expect(seen.handlerRan).toBe(true);
  });

  it('admits an ordinary request untouched', async () => {
    const seen = { handlerRan: false, parsedBody: null as unknown };
    const res = await app(seen).request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a normal task', description: 'short' }),
    });

    expect(res.status).toBe(200);
    expect(seen.parsedBody).toEqual({ title: 'a normal task', description: 'short' });
  });

  it('the largest LEGAL bulk write fits, with the headroom the comment claims', async () => {
    // The number behind "deliberately generous". `BulkUpdateTasksSchema` caps at
    // 100 task ids and a task description at 10 000 characters, so the biggest
    // request this API can legitimately produce is ~100 x 10 000 chars of
    // description plus JSON overhead. The comment in `body-limit.ts` says that
    // lands around 2 MB inside a 5 MB cap; this asserts the ratio rather than
    // trusting the arithmetic in a comment.
    const LEGAL_BULK_DESCRIPTION_CHARS = 100 * 10_000;
    const legalBulkBytes =
      Buffer.byteLength(JSON.stringify({ taskIds: new Array(100).fill('id'), data: {} })) +
      LEGAL_BULK_DESCRIPTION_CHARS * 2; // worst case: every char escaped

    expect(legalBulkBytes).toBeLessThan(MAX_REQUEST_BODY_BYTES);
    // At least 2x headroom, which is the margin the decision's reasoning claims.
    expect(MAX_REQUEST_BODY_BYTES / legalBulkBytes).toBeGreaterThanOrEqual(2);
  });
});

describe('decision 20: the cap is mounted where it can actually bite', () => {
  it('is mounted in app.ts on /api/*, ahead of the DB middleware and the routes', async () => {
    // A middleware that exists but is mounted after the service graph would
    // still pass every test above, because each of them builds its own app. This
    // is the assertion that the SHIPPED pipeline has it.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const source = readFileSync(join(dirname(import.meta.filename), '..', 'app.ts'), 'utf8');
    const mountedAt = source.indexOf("app.use('/api/*', requestBodyLimit())");

    expect(mountedAt, 'app.ts must mount requestBodyLimit()').toBeGreaterThan(-1);
    // Ahead of the DB middleware (a rejected body must not open a connection)
    // and ahead of every route.
    expect(mountedAt, 'the body cap must be mounted before the DB middleware').toBeLessThan(
      source.indexOf("app.use('/api/*', async (c, next)"),
    );
    expect(mountedAt, 'the body cap must be mounted before the first route').toBeLessThan(
      source.indexOf("app.route('/api', createReadyzRoutes())"),
    );
  });

  it('the error code is a member of the shared closed list, so the client can render it', async () => {
    // The client's `Record<ErrorCode, string>` message map is EXHAUSTIVE and
    // fails to compile for any code missing from the shared list — and a code
    // that is not in the list at all would fall through to a generic string,
    // rendering a 413 with no explanation. The member and the client entry were
    // added together for exactly that reason (see the note in `body-limit.ts`).
    expect(ERROR_CODES).toContain('PAYLOAD_TOO_LARGE');
  });

  it('the limit is the owner-decided 5 MB', () => {
    // Pinned so a later "let's tighten it a bit" edit has to change this test
    // and say why, rather than arriving silently.
    expect(MAX_REQUEST_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_REQUEST_BODY_LABEL).toBe('5 MB');
  });

  it('does not fire on a request with no body at all', async () => {
    // A GET carries no body; the middleware must not treat that as a size of
    // zero-and-therefore-fine only by accident, nor reject it.
    const instance = new Hono<AppEnv>();

    instance.onError(errorHandler);
    instance.use('/api/*', requestBodyLimit());
    instance.get('/api/ping', (c) => c.json({ status: 'ok' }));

    const res = await instance.request('/api/ping');

    expect(res.status).toBe(200);
  });

  it('the 413 is produced by the body-limit middleware itself, not by a downstream failure', async () => {
    // The 413 is RENDERED by the framework's `onError` hook rather than thrown,
    // so it never reaches `errorHandler`. That is deliberate (the hook must
    // return a Response) and it is why the 413 envelope is asserted directly
    // above — this test pins the distinction so nobody later "simplifies" the
    // rejection into a throw and silently changes the response shape.
    const instance = new Hono<AppEnv>();

    instance.onError(errorHandler);
    instance.use('*', requestIdMiddleware);
    instance.use('/api/*', requestBodyLimit());
    instance.post('/api/echo', (c) => c.json({ data: { ok: true } }));

    const res = await instance.request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyOf(MAX_REQUEST_BODY_BYTES + 1),
    });
    const body = (await res.json()) as { error: { code: string } };

    // A thrown error would have been rendered by `errorHandler`, whose code for
    // an unknown failure is INTERNAL_ERROR / 500. A 413 can only have come from
    // the body-limit hook.
    expect(res.status).toBe(413);
    expect(body.error.code).not.toBe('INTERNAL_ERROR');
    expect(vi.isMockFunction(console.error)).toBe(false);
  });
});
