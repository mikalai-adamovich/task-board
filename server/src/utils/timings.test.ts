/**
 * `Server-Timings` unit tests.
 *
 * The header is the only new observability surface the project has, so these
 * tests pin the two properties production depends on: the value is
 * syntactically valid per the Server-Timing spec, and it contains NOTHING that
 * `utils/redact.ts` would have to scrub (no ids, no e-mails, no tokens, no
 * route).
 */
import { describe, it, expect } from 'vitest';
import {
  SERVER_TIMINGS_HEADER,
  createServerTimings,
  formatServerTimings,
  getServerTimings,
  markFirstDbOp,
  runWithServerTimings,
  trackDbCall,
  trackDbPromise,
  trackDbValue,
  type ServerTimings,
} from './timings.js';
import { redactAuthorization } from './redact.js';

/** `metric;dur=123` / `metric;dur=123;desc="…"` — token ; dur=integer [; desc=quoted]. */
const METRIC = /^[a-z][a-z0-9_-]*;dur=\d+(;desc="[^"]*")?$/;
const VALID_HEADER = (value: string): boolean =>
  value.length > 0 && value.split(', ').every((entry) => METRIC.test(entry));

/** A resolved-in-the-future promise: the tracker must see it as DB time. */
function delay(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve('done'), ms));
}

function readMetrics(header: string): Record<string, number> {
  return Object.fromEntries(
    header.split(', ').map((entry) => {
      const [name, rest] = entry.split(';dur=');

      return [name as string, Number((rest as string).split(';')[0])];
    }),
  );
}

describe('Server-Timings store', () => {
  it('is invisible outside a request context (migrations, CLI, tests)', () => {
    expect(getServerTimings()).toBeUndefined();
    // A null store must degrade to a pass-through, never throw.
    expect(trackDbValue(() => 'raw')).toBe('raw');
  });

  it('is visible to every await inside the context', async () => {
    const timings = createServerTimings();
    const seen = await runWithServerTimings(timings, async () => {
      await Promise.resolve();

      return getServerTimings();
    });

    expect(seen).toBe(timings);
  });

  it('marks the first database operation only once', () => {
    const timings = createServerTimings();

    markFirstDbOp(timings, timings.start + 140);
    markFirstDbOp(timings, timings.start + 900);

    // 140 ms is the documented shape of the unexplained pre-DB stall; the
    // later call must not overwrite it.
    expect(timings.firstDbAt).toBeCloseTo(140);
  });
});

describe('trackDbPromise / trackDbCall / trackDbValue', () => {
  it('accumulates database time and counts operations', async () => {
    const timings = createServerTimings();

    await runWithServerTimings(timings, async () => {
      await trackDbCall(() => delay(5));
      await trackDbPromise(delay(5));
    });

    expect(timings.dbCount).toBe(2);
    expect(timings.dbMs).toBeGreaterThan(0);
    expect(timings.firstDbAt).toBeDefined();
  });

  it('records the time of a FAILED operation too (a slow error is the sample we need)', async () => {
    const timings = createServerTimings();

    await runWithServerTimings(timings, async () => {
      await expect(trackDbCall(() => delay(5).then(() => Promise.reject(new Error('boom'))))).rejects.toThrow('boom');
    });

    expect(timings.dbCount).toBe(1);
    expect(timings.dbMs).toBeGreaterThan(0);
  });

  it('times a promise-returning collection call', async () => {
    const timings = createServerTimings();
    const result = await runWithServerTimings(timings, () => trackDbValue(() => delay(5)));

    expect(result).toBe('done');
    expect(timings.dbCount).toBe(1);
  });

  it('times a cursor only when it is consumed (find() itself does no I/O)', async () => {
    const timings = createServerTimings();
    const cursor = {
      toArray: () => delay(5),
      next: () => delay(5),
    };
    const rows = await runWithServerTimings(timings, () => trackDbValue(() => cursor).toArray());

    expect(rows).toBe('done');
    // `find()` is lazy: the proxy must not have charged it a round trip, and the
    // `toArray()` that actually talks to MongoDB must be charged exactly once.
    expect(timings.dbCount).toBe(1);
  });

  it('passes a plain object through untouched', async () => {
    const timings = createServerTimings();
    const value = { acknowledged: true };
    const tracked = await runWithServerTimings(timings, async () => trackDbValue(() => value));

    expect(tracked).toBe(value);
    expect(timings.dbCount).toBe(0);
  });
});

describe('formatServerTimings', () => {
  const metricsOf = (timings: ServerTimings, at?: number): Record<string, number> =>
    readMetrics(formatServerTimings(timings, at));

  it('always reports total, db and app', () => {
    const timings = createServerTimings();
    const metrics = metricsOf(timings, timings.start + 30);

    expect(metrics.total).toBe(30);
    expect(metrics.db).toBe(0);
    expect(metrics.app).toBe(30);
  });

  it('splits database time out of the non-database time', () => {
    const timings: ServerTimings = { start: 0, dbMs: 12.4, dbCount: 3, firstDbAt: 5 };
    const metrics = metricsOf(timings, 50);

    expect(metrics).toEqual({ total: 50, firstdb: 5, db: 12, app: 38 });
    // app + db must reconstruct total — that identity is what makes the two
    // numbers comparable across samples.
    expect((metrics.app ?? 0) + (metrics.db ?? 0)).toBe(metrics.total);
  });

  it('omits firstdb when the request never reached the database', () => {
    const header = formatServerTimings({ start: 0, dbMs: 0, dbCount: 0 }, 5);

    expect(header).not.toContain('firstdb');
    expect(VALID_HEADER(header)).toBe(true);
  });

  it('never emits a negative or fractional duration', () => {
    // A dbMs larger than the elapsed total must clamp, not produce `dur=-8`.
    const header = formatServerTimings({ start: 0, dbMs: 40.6, dbCount: 2, firstDbAt: -3 }, 10);

    expect(header).not.toMatch(/dur=-/);
    expect(header).not.toMatch(/dur=\d+\./);
    expect(metricsOf({ start: 0, dbMs: 40.6, dbCount: 2, firstDbAt: -3 }, 10).app).toBe(0);
  });

  it('produces a syntactically valid header value', () => {
    const timings: ServerTimings = { start: 0, dbMs: 7.2, dbCount: 2, firstDbAt: 140 };
    const header = formatServerTimings(timings, 300);

    expect(VALID_HEADER(header)).toBe(true);
    expect(header).toBe(
      'total;dur=300, firstdb;dur=140;desc="time to first MongoDB operation", db;dur=7;desc="MongoDB", app;dur=293;desc="non-DB"',
    );
  });

  it('carries no identifier, e-mail, token or route (redaction invariant)', () => {
    const header = formatServerTimings({ start: 0, dbMs: 1, dbCount: 1, firstDbAt: 1 }, 2);

    // Every value in the header is a literal this module owns — the only
    // free-form part is `desc`, which is a constant string, so the redaction
    // helper has nothing to scrub and never has to be extended.
    expect(header).not.toMatch(/@/);
    expect(header).not.toMatch(/Bearer/i);
    expect(header).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(redactAuthorization(header)).toBe(header);
  });

  it('is exposed under the standard header name', () => {
    expect(SERVER_TIMINGS_HEADER).toBe('Server-Timings');
  });
});
