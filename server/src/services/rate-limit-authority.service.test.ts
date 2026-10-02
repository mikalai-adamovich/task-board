/**
 * The rate-limit authority: what each tier may decide, and in what order.
 *
 * The store here is the in-memory counter (`testing/rate-limit-counter-store.ts`)
 * rather than MongoDB, so these tests are about the TIER STACK — the advisory
 * map, the ordering, the key derivation, the store-outage refusal — and not about
 * MongoDB executes a pipeline, which the repository's integration spec covers.
 * The store COUNTS, so no assertion here is satisfied by a fixed answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FORGOT_PASSWORD_MAX_REQUESTS,
  LOGIN_ACCOUNT_MAX_REQUESTS,
  LOGIN_SOURCE_MAX_REQUESTS,
  RATE_LIMIT_SCOPE_HASH_BITS,
  RATE_LIMIT_SCOPE_HASH_HEX_LENGTH,
  rateLimitCounterId,
  RateLimitAuthorityService,
  REGISTER_MAX_REQUESTS,
  AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS,
  LOGIN_ACCOUNT_WINDOW_MS,
} from './rate-limit-authority.service.js';
import type { RateLimitBucket } from '../repositories/rate-limit-counter.repository.js';
import { logger } from '../utils/logger.js';
import { createFailingCounterStore, createInMemoryCounterStore } from '../testing/rate-limit-counter-store.js';

let unique = 0;
/** A scope no other test in this file has used, so the module-level maps stay private. */
const freshScope = (prefix: string) => `${prefix}-${(unique += 1)}`;

function authorityOver(store = createInMemoryCounterStore()) {
  return { service: new RateLimitAuthorityService(store as never), store };
}

/**
 * A store that is DOWN until `recover()` is called, and counts properly after —
 * the outage-then-recovery sequence the advisory tier has to survive. The
 * counting store is the one inside, so a recovered store holds no document for a
 * key the outage served: whatever the local map remembers about that key, the
 * store genuinely never saw it.
 */
function recoverableCounterStore() {
  const inner = createInMemoryCounterStore();
  const state = { down: true };
  const ids: string[] = [];
  const probe = vi.fn(async (request: Parameters<typeof inner.probe>[0]) => {
    ids.push(request.id);

    if (state.down) {
      throw new Error('counter store unavailable');
    }

    return inner.probe(request);
  });

  return {
    store: { probe, ids },
    recover: () => {
      state.down = false;
    },
  };
}

describe('the counter key', () => {
  it('is the bucket, then a truncated digest — never the raw scope', async () => {
    const id = await rateLimitCounterId('login-account', 'victim@example.com');

    expect(id.startsWith('login-account:')).toBe(true);
    expect(id).not.toContain('victim');
    expect(id).not.toContain('@');
  });

  it('truncates the digest to 128 bits', () => {
    // A declared, testable number rather than a length someone typed: 128 bits is
    // 32 hex characters, a collision space no plausible key count reaches, and a
    // short enough index key.
    expect(RATE_LIMIT_SCOPE_HASH_BITS).toBe(128);
    expect(RATE_LIMIT_SCOPE_HASH_HEX_LENGTH).toBe(RATE_LIMIT_SCOPE_HASH_BITS / 4);
  });

  it('produces exactly that many hex characters, and the same key for the same scope', async () => {
    const first = await rateLimitCounterId('login-source', '203.0.113.7');
    const second = await rateLimitCounterId('login-source', '203.0.113.7');

    expect(first.slice('login-source:'.length)).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toBe(second);
  });

  it('separates two buckets asking about the SAME scope', async () => {
    // The registration bucket keys on a bare address while the login source
    // bucket keys on the same one. Without the prefix they would share a
    // document, and a caller's registration budget would silently be part of its
    // login budget.
    const scope = freshScope('203.0.113.9');
    const register = await rateLimitCounterId('register-source', scope);
    const source = await rateLimitCounterId('login-source', scope);

    expect(register).not.toBe(source);
    expect(register.split(':')[0]).toBe('register-source');
    expect(source.split(':')[0]).toBe('login-source');
  });

  it('uses a different document for EVERY bucket pair (the store is told so)', async () => {
    const buckets: RateLimitBucket[] = ['login-account', 'login-source', 'register-source', 'forgot-email-ip'];
    const { service, store } = authorityOver();

    for (const bucket of buckets) {
      await service.probe(bucket, 'same-raw-scope');
    }

    expect(new Set(store.ids).size).toBe(buckets.length);
  });
});

describe('all four authentication buckets go through the authoritative store', () => {
  it('each probe reaches the store, under its own ceiling and window', async () => {
    const cases: {
      run: (s: RateLimitAuthorityService) => Promise<unknown>;
      bucket: RateLimitBucket;
      ceiling: number;
    }[] = [
      {
        run: (s) => s.probeLoginAccount('a@example.com'),
        bucket: 'login-account',
        ceiling: LOGIN_ACCOUNT_MAX_REQUESTS,
      },
      { run: (s) => s.probeLoginSource('198.51.100.1'), bucket: 'login-source', ceiling: LOGIN_SOURCE_MAX_REQUESTS },
      { run: (s) => s.probeRegisterSource('198.51.100.2'), bucket: 'register-source', ceiling: REGISTER_MAX_REQUESTS },
      {
        run: (s) => s.probeForgotPassword('b@example.com', '198.51.100.3'),
        bucket: 'forgot-email-ip',
        ceiling: FORGOT_PASSWORD_MAX_REQUESTS,
      },
    ];

    for (const { run, bucket, ceiling } of cases) {
      const { service, store } = authorityOver();

      await run(service);

      expect(store.probe).toHaveBeenCalledTimes(1);
      expect(store.ids[0]?.startsWith(`${bucket}:`)).toBe(true);
      expect(store.probe.mock.calls[0]?.[0]?.ceiling).toBe(ceiling);
    }
  });

  it('enforces each ceiling at its own number', async () => {
    const buckets: { run: (s: RateLimitAuthorityService) => Promise<{ limited: boolean }>; ceiling: number }[] = [
      { run: (s) => s.probeLoginAccount('c@example.com'), ceiling: LOGIN_ACCOUNT_MAX_REQUESTS },
      { run: (s) => s.probeLoginSource('198.51.100.4'), ceiling: LOGIN_SOURCE_MAX_REQUESTS },
      { run: (s) => s.probeRegisterSource('198.51.100.5'), ceiling: REGISTER_MAX_REQUESTS },
      { run: (s) => s.probeForgotPassword('d@example.com', '198.51.100.6'), ceiling: FORGOT_PASSWORD_MAX_REQUESTS },
    ];

    for (const { run, ceiling } of buckets) {
      const { service } = authorityOver();
      const outcomes: boolean[] = [];

      for (let i = 0; i < ceiling + 1; i += 1) {
        outcomes.push((await run(service)).limited);
      }

      // Admitted exactly `ceiling` times, refused on the next one.
      expect(outcomes.filter((limited) => !limited)).toHaveLength(ceiling);
      expect(outcomes[outcomes.length - 1]).toBe(true);
    }
  });
});

describe('the advisory tier is fail-closed and never manufactures an admission', () => {
  it('spends one store operation per attempt until the key is locally saturated, then none', async () => {
    const scope = freshScope('attack@example.com');
    const { service, store } = authorityOver();
    const ATTEMPTS = 500;
    let admitted = 0;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      if (!(await service.probeLoginAccount(scope)).limited) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(LOGIN_ACCOUNT_MAX_REQUESTS);
    // The whole point of the tier: a sustained attack on ONE key costs the store
    // `ceiling` operations, not one per attempt. The bound is by configuration,
    // not by attacker bandwidth.
    expect(store.probe).toHaveBeenCalledTimes(LOGIN_ACCOUNT_MAX_REQUESTS);
  });

  it('stops calling the store entirely once the key is saturated', async () => {
    const scope = freshScope('saturated@example.com');
    const { service, store } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLoginAccount(scope);
    }

    const spent = store.probe.mock.calls.length;

    for (let i = 0; i < 100; i += 1) {
      expect((await service.probeLoginAccount(scope)).limited).toBe(true);
    }

    expect(store.probe).toHaveBeenCalledTimes(spent);
  });

  it('cannot admit what the store would refuse: a local refusal is always backed by a stored attempt', async () => {
    const scope = freshScope('subset@example.com');
    const { service, store } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS + 5; i += 1) {
      await service.probeLoginAccount(scope);
    }

    // Every locally recorded attempt was admitted by the store first — the local
    // timestamp set is a SUBSET of the stored one, which is what makes a local
    // refusal sound rather than merely plausible.
    expect(store.probe).toHaveBeenCalledTimes(LOGIN_ACCOUNT_MAX_REQUESTS);
  });

  it('reports a positive back-off on an advisory refusal, derived from the oldest local attempt', async () => {
    const scope = freshScope('backoff@example.com');
    const { service } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLoginAccount(scope);
    }

    const refusal = await service.probeLoginAccount(scope);

    expect(refusal.limited).toBe(true);
    expect(refusal.outcome).toBe('limited');
    expect(refusal.remaining).toBe(0);
    expect(refusal.retryAfterSeconds).toBeGreaterThan(0);
    expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });
});

/**
 * A counter-store FAULT is not a degraded ceiling — it is a refusal.
 *
 * The invariant this service exists for is that the authoritative ceiling does
 * not depend on the number of Worker/DO instances. A per-instance map cannot
 * honour that: under a counter-only fault it answers with `limit ÷ instances`
 * while the caller is still admitted, so the ceiling quietly multiplies by a
 * number the operator does not choose. Measured on the counter-only fault:
 * `counterOk=0/20` while `authLookupOk=20/20` — twenty logins that would have
 * worked, each admitted under a ceiling nobody is enforcing.
 *
 * So a store that cannot produce a verdict admits nobody: no admission, no
 * local timestamp recorded on its behalf, no successful auth downstream.
 */
describe('a counter-store fault fails closed', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('refuses EVERY bucket, whatever shape the fault takes', async () => {
    // Three distinct faults, because "the store errored" is not one condition: a
    // `maxTimeMS` expiry, an ordinary driver failure and an unreachable server
    // arrive by different paths, and a fail-closed guarantee that only holds for
    // one of them is not a guarantee.
    const faults: { readonly label: string; readonly error: Error }[] = [
      {
        label: 'timeout',
        error: Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError' }),
      },
      { label: 'generic error', error: new TypeError('undefined is not a function') },
      {
        label: 'unavailable',
        error: Object.assign(new Error('server selection timed out'), { name: 'MongoNetworkError' }),
      },
    ];

    for (const { label, error } of faults) {
      const { service } = authorityOver(createFailingCounterStore(error.message));
      const scope = freshScope(`fault-${label}@example.com`);
      const result = await service.probeLoginAccount(scope);

      expect(result.limited, label).toBe(true);
      expect(result.tier, label).toBe('authority_unavailable');
      expect(result.outcome, label).toBe('limited');
      expect(result.remaining, label).toBe(0);
    }
  });

  it('admits nothing and records nothing, and a recovered store starts from zero', async () => {
    const scope = freshScope('outage@example.com');
    const { store, recover } = recoverableCounterStore();
    const service = new RateLimitAuthorityService(store as never);
    const ATTEMPTS = LOGIN_ACCOUNT_MAX_REQUESTS * 2;
    let admitted = 0;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      if (!(await service.probeLoginAccount(scope)).limited) {
        admitted += 1;
      }
    }

    // Not one. A per-instance ceiling would have admitted a whole ceiling here
    // and every one of those logins would have succeeded.
    expect(admitted).toBe(0);

    recover();

    const afterRecovery = await service.probeLoginAccount(scope);

    // The store holds nothing for this key, because nothing was admitted and
    // nothing was recorded on its behalf: its own count is 1, and the LOCAL
    // record agrees — if a timestamp had been written during the outage, the
    // recovered probe would have been refused by the advisory tier instead.
    expect(afterRecovery.tier).toBe('authoritative');
    expect(afterRecovery.limited).toBe(false);
    expect(afterRecovery.remaining).toBe(LOGIN_ACCOUNT_MAX_REQUESTS - 1);
  });

  it('still asks the store on every attempt — it does not cache the refusal', async () => {
    const scope = freshScope('no-cached-refusal@example.com');
    const { service, store } = authorityOver(createFailingCounterStore());

    for (let i = 0; i < 5; i += 1) {
      expect((await service.probeLoginAccount(scope)).limited).toBe(true);
    }

    // The store may have recovered at any moment, so a cached "unavailable"
    // verdict would keep refusing a caller the authority could admit. One
    // operation per attempt, and the ceiling is no longer what bounds that.
    expect(store.probe).toHaveBeenCalledTimes(5);
  });

  it('reports the AUTHORITATIVE ceiling and a bounded back-off, never a divided number', async () => {
    const { service } = authorityOver(createFailingCounterStore());
    const result = await service.probeLoginAccount(freshScope('headers@example.com'));

    // What the caller forwards into `RateLimit-Limit` and `Retry-After`. The
    // back-off is bounded rather than the window: the authority has no deadline
    // — it cannot know when the store recovers — so promising 15 minutes would
    // turn a transient fault into a lockout, and promising 0 would invite a hot
    // retry loop against a store that is already failing.
    expect(result.ceiling).toBe(LOGIN_ACCOUNT_MAX_REQUESTS);
    expect(result.retryAfterSeconds).toBe(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThan(LOGIN_ACCOUNT_WINDOW_MS / 1000);
  });

  it('names the failure CLASS in the log and nothing that identifies the caller', async () => {
    // A driver message routinely carries the collection, the filter and the
    // document `_id` — and a counter document's `_id` IS the hashed scope. The
    // bucket name says which of the four keys is under attack. None of that may
    // reach a log a reader of the deployment can see.
    const { service } = authorityOver(
      createFailingCounterStore(
        'E11000 dup key: rate_limit_counters _id login-account:0123456789abcdef0123456789abcdef',
      ),
    );

    await service.probeLoginAccount('leak-me@example.com');

    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');

    expect(logged).toContain('Error');
    expect(logged).not.toContain('leak-me@example.com');
    expect(logged).not.toMatch(/login-account|login-source|register-source|forgot-email-ip/);
    expect(logged).not.toMatch(/[0-9a-f]{32}/);
    expect(logged).not.toContain('E11000');
    expect(logged).not.toContain('rate_limit_counters');
  });
});

/**
 * The subset property, and it now holds unconditionally.
 *
 * A local timestamp is written only after the store admitted that same attempt,
 * so the local set is a subset of the stored one and a local refusal is sound.
 * The case that used to break it — a fallback writing timestamps with no store
 * behind them, then shadowing a recovered authority for the rest of the window —
 * cannot occur, because nothing is written on a store that said nothing.
 */
describe('the local tier never outlives the store it caches', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Each outage probe logs one refusal; here that log is the expected subject,
    // not noise a reader has to skip past.
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /** Drive `count` attempts at one key while the store is down. */
  async function serveDuringOutage(service: RateLimitAuthorityService, scope: string, count: number) {
    const outcomes: boolean[] = [];

    for (let i = 0; i < count; i += 1) {
      outcomes.push((await service.probeLoginAccount(scope)).limited);
    }

    return outcomes;
  }

  it('reaches the store again on the first attempt after the store recovers', async () => {
    const scope = freshScope('recovered@example.com');
    const { store, recover } = recoverableCounterStore();
    const service = new RateLimitAuthorityService(store as never);

    await serveDuringOutage(service, scope, LOGIN_ACCOUNT_MAX_REQUESTS + 5);

    const spentDuringOutage = store.probe.mock.calls.length;

    recover();

    const afterRecovery = await service.probeLoginAccount(scope);

    expect(store.probe.mock.calls.length).toBe(spentDuringOutage + 1);
    expect(afterRecovery.tier).toBe('authoritative');
  });

  it('re-seeds the key from the store, so a full ceiling is admissible again', async () => {
    const scope = freshScope('reseeded@example.com');
    const { store, recover } = recoverableCounterStore();
    const service = new RateLimitAuthorityService(store as never);

    await serveDuringOutage(service, scope, LOGIN_ACCOUNT_MAX_REQUESTS + 5);

    recover();

    const outcomes: boolean[] = [];

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS + 1; i += 1) {
      outcomes.push((await service.probeLoginAccount(scope)).limited);
    }

    // The store's own ceiling, counted from zero, with every attempt reaching it:
    // an outage that admitted nothing leaves nothing behind to be carried over.
    expect(outcomes.filter((limited) => !limited)).toHaveLength(LOGIN_ACCOUNT_MAX_REQUESTS);
    expect(outcomes[outcomes.length - 1]).toBe(true);
  });

  it('leaves a healthy key exactly as before: refused locally, no store operation', async () => {
    // The control for the cases above. Nothing about the change may slow the
    // normal path down, where the local entries ARE a subset and a refusal is
    // sound — and the advisory first check must still save the store operation.
    const scope = freshScope('healthy@example.com');
    const { service, store } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLoginAccount(scope);
    }

    const spent = store.probe.mock.calls.length;
    const refused = await service.probeLoginAccount(scope);

    expect(refused.tier).toBe('advisory');
    expect(store.probe).toHaveBeenCalledTimes(spent);
  });

  it('short-circuits a locally saturated key WITHOUT the store, even when the store is down', async () => {
    // The advisory tier is independent of the store in both directions: it saves
    // the operation on the healthy path, and on a store fault it refuses without
    // adding one. A saturated key costs the outage nothing.
    const scope = freshScope('saturated-during-outage@example.com');
    const healthy = authorityOver();
    const { service: saturated } = healthy;

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await saturated.probeLoginAccount(scope);
    }

    const { service, store } = authorityOver(createFailingCounterStore());
    const refusal = await service.probeLoginAccount(scope);

    expect(refusal.limited).toBe(true);
    expect(refusal.tier).toBe('advisory');
    expect(store.probe).not.toHaveBeenCalled();
  });
});

describe('the login pair', () => {
  it('decides the ACCOUNT bucket first, so its ceiling is the one reported', async () => {
    const email = freshScope('victim@example.com');
    const { service } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLogin({ email, source: freshScope('198.51.100.20') });
    }

    const decision = await service.probeLogin({ email, source: freshScope('198.51.100.20') });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.bucket).toBe('account');
    // The caller reports `RateLimit-Limit` from `result.ceiling`, so it has to
    // name the account bucket's ceiling and never the source one.
    expect(decision.allowed === false && decision.result.limited).toBe(true);
    expect(decision.allowed === false && decision.result.ceiling).toBe(LOGIN_ACCOUNT_MAX_REQUESTS);
  });

  it('does not probe the source bucket once the account bucket has refused', async () => {
    const email = freshScope('short-circuit@example.com');
    const { service, store } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLogin({ email, source: freshScope('198.51.100.21') });
    }

    const spent = store.probe.mock.calls.length;

    await service.probeLogin({ email, source: freshScope('198.51.100.21') });

    // An attempt that is already refused contributes nothing observable to the
    // source bucket, so spending an operation on it is pure cost under attack.
    expect(store.probe).toHaveBeenCalledTimes(spent);
  });

  it('reports the SOURCE bucket when that is the one that refused', async () => {
    const source = freshScope('198.51.100.22');
    const { service } = authorityOver();
    let decision = await service.probeLogin({ email: freshScope('one@example.com'), source });

    for (let i = 0; i < LOGIN_SOURCE_MAX_REQUESTS && decision.allowed; i += 1) {
      decision = await service.probeLogin({ email: freshScope(`spray-${i}@example.com`), source });
    }

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.bucket).toBe('source');
    expect(decision.allowed === false && decision.result.ceiling).toBe(LOGIN_SOURCE_MAX_REQUESTS);
  });

  it('allows a fresh account from a fresh source', async () => {
    const { service } = authorityOver();

    await expect(
      service.probeLogin({ email: freshScope('ok@example.com'), source: freshScope('198.51.100.23') }),
    ).resolves.toEqual({
      allowed: true,
    });
  });

  it('costs the store TWO operations per pair while it lasts, not one per attempt', async () => {
    // A login probes the account bucket and then the source bucket, so a sustained
    // attack on ONE pair is two saturated keys and therefore twice the ceiling in
    // authoritative operations. The bound is a property of the PAIR; counting one
    // bucket in isolation understates it by half, which is why this is measured
    // through `probeLogin` and not through a single-bucket call.
    const email = freshScope('pair-cost@example.com');
    const source = freshScope('198.51.100.25');
    const { service, store } = authorityOver();
    const ATTEMPTS = 500;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      await service.probeLogin({ email, source });
    }

    expect(store.probe).toHaveBeenCalledTimes(2 * LOGIN_ACCOUNT_MAX_REQUESTS);
  });

  it('a refusal exposes no bucket name, key hash or document id', async () => {
    const email = freshScope('opaque@example.com');
    const { service } = authorityOver();

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS; i += 1) {
      await service.probeLogin({ email, source: freshScope('198.51.100.24') });
    }

    const decision = await service.probeLogin({ email, source: freshScope('198.51.100.24') });
    // The decision object is internal; what the 429 carries is the RESULT. These
    // assertions are on the result because that is the half the caller forwards
    // into headers and (in a future field) into a body.
    const result =
      decision.allowed === false
        ? decision.result
        : { limited: false, outcome: 'allowed', remaining: 1, retryAfterSeconds: 0 };
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/login-account|login-source|register-source|forgot-email-ip/);
    expect(serialized).not.toMatch(/[0-9a-f]{32}/);
    expect(serialized).not.toContain(email);
    expect(result.limited).toBe(true);
  });
});
