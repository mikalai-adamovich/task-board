import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { connectMongo } from '../db/mongo.js';
import {
  createReadyzRoutes,
  pingDatabase,
  readCachedVerdict,
  resetReadinessCache,
  writeCachedVerdict,
  READY_PING_TIMEOUT_MS,
  READY_VERDICT_TTL_MS,
} from './readyz.js';
import type { ConfigurationVerdict } from '../config/runtime-config.js';

vi.mock('../db/mongo.js', () => ({
  connectMongo: vi.fn(),
}));

const ENV = { MONGODB_URI: 'mongodb://localhost:27017/test', JWT_SECRET: 'secret' };

function createApp() {
  return createReadyzRoutes();
}

function mockConnect(command: ReturnType<typeof vi.fn>) {
  vi.mocked(connectMongo).mockResolvedValue({
    client: { close: vi.fn().mockResolvedValue(undefined) } as unknown as MongoClient,
    db: { command } as unknown as Db,
  });
}

describe('GET /api/readyz', () => {
  beforeEach(() => {
    vi.mocked(connectMongo).mockReset();
  });

  // The verdict cache is MODULE scoped (it must be shared by every request
  // in every deployment mode), so a verdict computed by one test would otherwise
  // answer the next one. Clearing it per test is what keeps each case an
  // independent statement about the route rather than about the test order —
  // and it is why `resetReadinessCache` is exported at all.
  afterEach(() => {
    resetReadinessCache();
  });

  it('returns 200 with the database AND the configuration verdict when both are good', async () => {
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const res = await createApp().request('/readyz', undefined, ENV);

    expect(res.status).toBe(200);
    // The response gained the configuration verdict. The connection
    // behaviour is unchanged: the same fresh client, the same ping, the
    // same close — only the body says more.
    expect(await res.json()).toEqual({
      status: 'ok',
      configuration: { ok: true, missing: [] },
      // The login limiter's scope is reported so an operator can see
      // what the deployment is actually enforcing (this env declares no mode,
      // which the app treats as its own default, `per-request`).
      rateLimit: {
        loginAttempts:
          'per-instance counter, 4 assumed instances (undeclared) — ceiling 2 per instance, ~10 deployment-wide',
        mode: 'per-request',
        instanceBudgetDeclared: false,
      },
    });
    expect(connectMongo).toHaveBeenCalledWith(ENV.MONGODB_URI);
  });

  it('D-23: reports a missing JWT_SECRET as not-ready WITHOUT throwing, and still answers 200', async () => {
    // The input no production deployment has today: a Worker whose signing
    // secret was never set. The database is fine, so the probe must still
    // answer — and the answer must say the deployment is mis-configured
    // rather than failing later, on a user's first login.
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const res = await createApp().request('/readyz', undefined, { MONGODB_URI: ENV.MONGODB_URI });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', configuration: { ok: false, missing: ['JWT_SECRET'] } });
  });

  it('D-23: the verdict never leaks a value — only variable names leave the endpoint', async () => {
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const jwtSecret = 'a-real-signing-secret-value';
    const res = await createApp().request('/readyz', undefined, { MONGODB_URI: ENV.MONGODB_URI, JWT_SECRET: '' });
    const raw = await res.text();

    expect(raw).not.toContain(jwtSecret);
    expect(raw).not.toContain(ENV.MONGODB_URI);
    expect(JSON.parse(raw)).toMatchObject({ configuration: { missing: ['JWT_SECRET'] } });
  });

  it('returns 503 DB_UNAVAILABLE when the ping fails', async () => {
    mockConnect(vi.fn().mockRejectedValue(new Error('connection refused')));

    const res = await createApp().request('/readyz', undefined, ENV);

    expect(res.status).toBe(503);

    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('DB_UNAVAILABLE');
  });

  it('returns 503 and never connects when MONGODB_URI is empty', async () => {
    const res = await createApp().request('/readyz', undefined, { ...ENV, MONGODB_URI: '' });

    expect(res.status).toBe(503);

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('DB_UNAVAILABLE');
    expect(connectMongo).not.toHaveBeenCalled();
  });

  it('closes the client after pinging', async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    vi.mocked(connectMongo).mockResolvedValue({
      client: { close } as unknown as MongoClient,
      db: { command: vi.fn().mockResolvedValue({ ok: 1 }) } as unknown as Db,
    });

    await createApp().request('/readyz', undefined, ENV);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('pingDatabase', () => {
  it('resolves when the command resolves', async () => {
    const db = { command: vi.fn().mockResolvedValue({ ok: 1 }) } as unknown as Db;

    await expect(pingDatabase(db, 100)).resolves.toBeUndefined();
  });

  it('rejects when the ping exceeds the timeout', async () => {
    const db = { command: vi.fn().mockReturnValue(new Promise(() => undefined)) } as unknown as Db;

    await expect(pingDatabase(db, 10)).rejects.toThrow('timed out');
  });

  it('uses a short default timeout', () => {
    expect(READY_PING_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

/**
 * The readiness verdict is CACHED for a few seconds, so a monitoring probe
 * stops paying a full connection handshake (DNS + TCP + TLS + auth) on every
 * hit. The behaviour under test is the one the decision asked for and nothing
 * more: the fresh-connection probe is unchanged, only its FREQUENCY moved.
 */
describe('C-9: the readiness verdict is cached for a few seconds', () => {
  beforeEach(() => {
    vi.mocked(connectMongo).mockReset();
  });

  afterEach(() => {
    resetReadinessCache();
  });

  it('opens ONE connection for a burst of probes inside the TTL', async () => {
    // The fail-proof for the whole item: without the cache this counter is 5.
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const app = createReadyzRoutes();

    for (let hit = 0; hit < 5; hit += 1) {
      const res = await app.request('/readyz', undefined, ENV);

      expect(res.status).toBe(200);
    }

    expect(connectMongo).toHaveBeenCalledTimes(1);
  });

  it('probes again once the TTL has elapsed', async () => {
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const app = createReadyzRoutes();

    await app.request('/readyz', undefined, ENV);
    expect(connectMongo).toHaveBeenCalledTimes(1);

    // Age the entry past the TTL rather than sleeping: the cache is a pure
    // function of (entry, now), so the boundary can be asserted exactly.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + READY_VERDICT_TTL_MS);

    await app.request('/readyz', undefined, ENV);

    expect(connectMongo).toHaveBeenCalledTimes(2);
  });

  it('caches a FAILURE too — a down database must not be re-dialled per hit', async () => {
    // The failure verdict is the expensive one to recompute and the one a
    // monitor hits most during an incident, so caching only the success case
    // would leave the cost exactly where it hurts.
    mockConnect(vi.fn().mockRejectedValue(new Error('connection refused')));

    const app = createReadyzRoutes();
    const first = await app.request('/readyz', undefined, ENV);
    const second = await app.request('/readyz', undefined, ENV);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual(await first.json());
    expect(connectMongo).toHaveBeenCalledTimes(1);
  });

  it('recomputes the CONFIGURATION verdict on every hit, never from the cache', async () => {
    // The database verdict is cached; the configuration verdict describes the
    // environment in front of the probe and is two presence checks, so serving
    // it from the cache would be the one way this endpoint could describe a
    // deployment other than the one being probed.
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const app = createReadyzRoutes();
    const configured = await app.request('/readyz', undefined, ENV);
    const unconfigured = await app.request('/readyz', undefined, { MONGODB_URI: ENV.MONGODB_URI });
    // `Response.json()` is `unknown`; a named type is the honest way to read the
    // shape out, rather than an `any` that would silence the compiler for the
    // rest of the assertion.
    const configurationOf = async (res: Response) => (await res.json()) as { configuration: ConfigurationVerdict };

    expect((await configurationOf(configured)).configuration).toEqual({ ok: true, missing: [] });
    expect((await configurationOf(unconfigured)).configuration).toEqual({ ok: false, missing: ['JWT_SECRET'] });
    // Both environments are 'configured' as far as the cache key is concerned,
    // so this is the cache HITTING and the configuration verdict still changing
    // underneath it.
    expect(connectMongo).toHaveBeenCalledTimes(1);
  });

  it('does not let one environment answer another environment probe', async () => {
    // The cache is keyed by CONFIGUREDNESS, never by the URI value, and the
    // unconfigured direction is covered by the no-connect 503 path; this is the
    // configured-vs-configured direction, where a stale entry could otherwise
    // answer for a database this request never touched.
    mockConnect(vi.fn().mockResolvedValue({ ok: 1 }));

    const app = createReadyzRoutes();

    await app.request('/readyz', undefined, ENV);

    const other = await app.request('/readyz', undefined, { ...ENV, MONGODB_URI: 'mongodb://other-host/other' });

    expect(other.status).toBe(200);
    expect(connectMongo).toHaveBeenCalledTimes(1);
  });

  it('the TTL is a positive number and short enough to stay a health signal', () => {
    // A TTL that grew to minutes would quietly turn the probe into a lie. These
    // bounds are the reviewable form of the reasoning in the module header.
    expect(READY_VERDICT_TTL_MS).toBeGreaterThan(0);
    expect(READY_VERDICT_TTL_MS).toBeLessThanOrEqual(30_000);
  });

  it('an entry is never served AT its expiry instant, and never across environments', () => {
    const now = 1_000_000;

    writeCachedVerdict('configured', { ok: true }, now);

    expect(readCachedVerdict('configured', now)).toEqual({ ok: true });
    // The boundary belongs to the miss: `expiresAt <= now`, not `<`.
    expect(readCachedVerdict('configured', now + READY_VERDICT_TTL_MS)).toBeNull();
    expect(readCachedVerdict('configured', now + READY_VERDICT_TTL_MS - 1)).toEqual({ ok: true });
    // A different environment never inherits the entry.
    expect(readCachedVerdict('unconfigured', now)).toBeNull();

    resetReadinessCache();

    expect(readCachedVerdict('configured', now)).toBeNull();
  });
});
