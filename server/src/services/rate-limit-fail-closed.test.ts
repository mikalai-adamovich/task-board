/**
 * A counter-store fault must produce ZERO successful logins.
 *
 * ## Why this file exists
 *
 * The counter is a distinct operation from the credential lookup, so a fault
 * confined to it leaves the user lookup working. That is what makes it dangerous:
 * the request would otherwise SUCCEED, under a ceiling the process cannot speak
 * for. Measured on the counter-only fault: `counterOk=0/20` while
 * `authLookupOk=20/20` — twenty logins completed on a degraded, per-instance
 * ceiling that no operator is enforcing.
 *
 * So the rule under test is the fail-closed one, end to end through
 * `AuthService.login`: an authoritative counter that cannot produce a verdict
 * admits nobody. Every test here drives the production tier stack over a
 * counting (or deliberately failing) store, so no assertion can be satisfied by
 * a stub's fixed answer.
 *
 * ## The response, pinned
 *
 * The refusal is the project's existing throttled contract — status 429, code
 * `RATE_LIMITED`, and the full `Retry-After` + `RateLimit-*` header set — rather
 * than a new 503: a store that cannot answer has no deadline, so there is no
 * "unavailable" condition a client could distinguish from a busy one, and every
 * client already knows what to do with a 429 and a back-off. The headers name the
 * ceiling the caller is genuinely held to (the configured constant), never a
 * per-instance number nothing enforces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashSync } from 'bcryptjs';
import { AuthService } from './auth.service.js';
import {
  AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS,
  LOGIN_ACCOUNT_MAX_REQUESTS,
  LOGIN_SOURCE_MAX_REQUESTS,
  RateLimitAuthorityService,
} from './rate-limit-authority.service.js';
import { createFailingCounterStore, createInMemoryCounterStore } from '../testing/rate-limit-counter-store.js';
import type { AppError } from '../errors/app-error.js';
import { logger } from '../utils/logger.js';

const TEST_SECRET = 'test-jwt-secret-for-fail-closed';
const NOW = '2025-01-01T00:00:00.000Z';
let unique = 0;
/** A key no other test has used, so the module-level limiter maps stay private. */
const freshEmail = (): string => `victim-${(unique += 1)}@example.com`;
const freshSource = (): string => `198.51.100.${(unique % 250) + 1}`;
/** The password every attempt in this file presents. */
const PASSWORD = 'correct-password';

/**
 * A REAL bcrypt hash of {@link PASSWORD}, so "admitted" and "authenticated" are
 * the same thing here. A placeholder hash would make every admitted attempt end
 * in a 401 and the measurement meaningless: a login that fails its credentials
 * looks exactly like one that was never admitted.
 */
function makeUserDoc() {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    passwordHash: hashSync(PASSWORD, 10),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    deletedAt: null,
  };
}

/**
 * An auth service whose credentials are VALID, so an admitted attempt would
 * complete with a token rather than ending in a 401. That distinction is the
 * whole measurement: a 401 would prove nothing about admission.
 */
function authWithValidCredentials(store: ReturnType<typeof createInMemoryCounterStore>): {
  service: AuthService;
  findActiveByEmail: ReturnType<typeof vi.fn>;
} {
  const findActiveByEmail = vi.fn().mockResolvedValue(makeUserDoc());
  const service = new AuthService(
    { findActiveByEmail } as never,
    {} as never,
    // A real membership, so a completed login also completes the tenant lookup
    // rather than failing on a collaborator the test did not stand in for.
    { findByUser: vi.fn().mockResolvedValue([]) } as never,
    new RateLimitAuthorityService(store as never),
    TEST_SECRET,
    null,
  );

  return { service, findActiveByEmail };
}

/** The error a login threw, or `null` when it completed. */
async function login(service: AuthService, email: string, source: string): Promise<AppError | null> {
  try {
    await service.login({ email, password: PASSWORD }, source);

    return null;
  } catch (err) {
    return err as AppError;
  }
}

describe('a counter-store fault admits nobody', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with valid credentials: N attempts, ZERO completed logins (the audit case)', async () => {
    const { service, findActiveByEmail } = authWithValidCredentials(createFailingCounterStore());
    const email = freshEmail();
    const source = freshSource();
    const ATTEMPTS = 20;
    let completed = 0;
    let refused = 0;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      const err = await login(service, email, source);

      if (err === null) {
        completed += 1;
      } else if (err.statusCode === 429) {
        refused += 1;
      }
    }

    // The measured shape of the defect: twenty attempts, twenty working
    // credentials, and twenty successful logins under a degraded ceiling. The
    // counter store failing is now the only reason any of them are refused.
    expect(completed).toBe(0);
    expect(refused).toBe(ATTEMPTS);
    // The credential lookup is never reached — the request dies at the ceiling,
    // so nothing downstream of the counter has to make a decision at all.
    expect(findActiveByEmail).not.toHaveBeenCalled();
  });

  it('refuses with 429 RATE_LIMITED and the full retry header set', async () => {
    const { service } = authWithValidCredentials(createFailingCounterStore());
    const err = await login(service, freshEmail(), freshSource());

    // Pinned exactly, because "the request was refused" is not enough: a client
    // acts on the status, the code and the back-off, and all three are the
    // existing throttled contract rather than something new.
    expect(err?.statusCode).toBe(429);
    expect(err?.code).toBe('RATE_LIMITED');
    expect(err?.headers).toEqual({
      'Retry-After': String(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS),
      'RateLimit-Limit': String(LOGIN_ACCOUNT_MAX_REQUESTS),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  });

  it('never names the bucket, the hashed scope or the store in the refusal', async () => {
    const { service } = authWithValidCredentials(
      createFailingCounterStore(
        'E11000 dup key on rate_limit_counters _id login-account:0123456789abcdef0123456789abcdef',
      ),
    );
    const email = freshEmail();
    const err = await login(service, email, freshSource());

    // The driver message reached the log and nowhere else. A counter document's
    // `_id` is the hashed scope, so forwarding that anywhere a client can read it
    // would confirm which key is under attack.
    expect(err?.message).toBe('Too many login attempts. Try again later.');

    const visible = JSON.stringify({ message: err?.message, code: err?.code, headers: err?.headers });

    expect(visible).not.toContain(email);
    expect(visible).not.toMatch(/[0-9a-f]{32}/);
    expect(visible).not.toMatch(/login-account|login-source|register-source|forgot-email-ip/);
    expect(visible).not.toContain('rate_limit_counters');
  });

  it('refuses registration too — the same authority, the same answer', async () => {
    const service = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      new RateLimitAuthorityService(createFailingCounterStore() as never),
      TEST_SECRET,
      null,
    );
    const err = (await service
      .register({ email: freshEmail(), password: PASSWORD, displayName: 'Test' }, freshSource())
      .catch((e: unknown) => e)) as AppError;

    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.headers?.['RateLimit-Limit']).toBe('20');
  });

  it('issues no password reset — a refused probe does the work anyway', async () => {
    // The password-reset path answers neutrally whatever it decides, so the
    // observable difference is whether the reset work happened.
    const setPasswordReset = vi.fn();
    const sendPasswordResetEmail = vi.fn();
    const service = new AuthService(
      { findActiveByEmail: vi.fn().mockResolvedValue(makeUserDoc()), setPasswordReset } as never,
      {} as never,
      {} as never,
      new RateLimitAuthorityService(createFailingCounterStore() as never),
      TEST_SECRET,
      { sendPasswordResetEmail } as never,
    );
    const response = await service.requestPasswordReset({ email: 'test@example.com' }, freshSource());

    expect(response.message).toContain('If an account exists');
    expect(setPasswordReset).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('login stays SEQUENTIAL: an account that cannot be decided creates no source probe', async () => {
    const store = createFailingCounterStore();
    const service = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      new RateLimitAuthorityService(store as never),
      TEST_SECRET,
      null,
    );

    await service.login({ email: freshEmail(), password: PASSWORD }, freshSource()).catch(() => undefined);

    // One operation, for the ACCOUNT bucket. An attempt that is not being
    // admitted contributes nothing observable to the source bucket, so spending
    // a second one on it is pure cost under attack.
    expect(store.probe).toHaveBeenCalledTimes(1);
    expect(store.ids[0]?.startsWith('login-account:')).toBe(true);
  });
});

describe('the healthy path is untouched by any of it', () => {
  it('a counter that answers lets the login through, with valid credentials', async () => {
    const { service } = authWithValidCredentials(createInMemoryCounterStore());

    expect(await login(service, freshEmail(), freshSource())).toBeNull();
  });

  it('a counter that answers and reports the limit gives a NORMAL refusal, not an error path', async () => {
    // The control for every test above: a store that answers and says "over
    // budget" is the ordinary rate-limit condition, with the same 429 and the
    // same back-off derived from the caller's own window — not the store-failure
    // branch wearing the same status.
    const { service } = authWithValidCredentials(createInMemoryCounterStore());
    const email = freshEmail();
    const source = freshSource();
    let refusal: AppError | null = null;

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS + 1 && refusal === null; i += 1) {
      const err = await login(service, email, source);

      if (err?.statusCode === 429) {
        refusal = err;
      }
    }

    expect(refusal?.code).toBe('RATE_LIMITED');
    expect(refusal?.headers?.['RateLimit-Limit']).toBe(String(LOGIN_ACCOUNT_MAX_REQUESTS));
    // The store answered, so the back-off is the caller's own window — not the
    // authority's fixed "the store is down" number.
    expect(refusal?.headers?.['Retry-After']).not.toBe(String(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS));
    expect(Number(refusal?.headers?.['Retry-After'])).toBeGreaterThan(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS);
  });

  it('the source bucket still decides a spray across many accounts', async () => {
    const { service } = authWithValidCredentials(createInMemoryCounterStore());
    const source = freshSource();
    let refusal: AppError | null = null;

    for (let i = 0; i < LOGIN_SOURCE_MAX_REQUESTS + 1 && refusal === null; i += 1) {
      const err = await login(service, freshEmail(), source);

      if (err?.statusCode === 429) {
        refusal = err;
      }
    }

    expect(refusal?.message).toBe('Too many login attempts from this source. Try again later.');
    expect(refusal?.headers?.['RateLimit-Limit']).toBe(String(LOGIN_SOURCE_MAX_REQUESTS));
  });
});
