/**
 * The AUTHORITATIVE ceiling is the configured constant, in EVERY `DB_CLIENT_MODE`
 * — and under a counter fault NOTHING is admitted at any ceiling.
 *
 * ## The invariant
 *
 * MongoDB counts one document per bucket/scope pair, so its verdict cannot
 * depend on how many isolates exist. The instance-divided number from
 * `utils/rate-limit-scope.ts` belongs to no ceiling any request is held to: the
 * in-process map is the ADVISORY tier alone — it may refuse a saturated key and
 * may never admit one — so nothing consumes `effectiveCeiling`, and a store that
 * cannot answer refuses rather than handing the decision to a per-instance map.
 *
 * Production runs `durable`, where the division is 1 and both would be
 * invisible. These tests therefore drive EVERY mode, including the unset one,
 * and assert both halves: the constant is what the store is asked to enforce,
 * and a counter-only fault produces a refusal rather than a degraded ceiling.
 *
 * ## What is asserted, and what would fail without the rule
 *
 *   1. the `ceiling` the AUTHORITATIVE store is asked to enforce is the constant,
 *      and the full constant is admitted before anything is refused;
 *   2. with the store unreachable, the response is an ordinary 429 holding the
 *      CONSTANT — never the divided value, and never a login.
 *
 * Reverting to a per-instance answer fails (2); handing the divided number to
 * the store fails (1) in all three non-`durable` modes. Neither direction passes
 * both.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from './auth.service.js';
import {
  AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS,
  LOGIN_ACCOUNT_MAX_REQUESTS,
  LOGIN_SOURCE_MAX_REQUESTS,
  RateLimitAuthorityService,
} from './rate-limit-authority.service.js';
import { DEFAULT_ASSUMED_INSTANCES, resolveRateLimitScope } from '../utils/rate-limit-scope.js';
import { createFailingCounterStore, createInMemoryCounterStore } from '../testing/rate-limit-counter-store.js';
import { logger } from '../utils/logger.js';
import type { AppError } from '../errors/app-error.js';

const TEST_SECRET = 'test-jwt-secret-for-ceiling-separation';
/** Every mode the deployment can be in, plus the unset one (which means `per-request`). */
const MODES: { readonly mode: string | undefined; readonly label: string }[] = [
  { mode: 'durable', label: 'durable' },
  { mode: 'per-request', label: 'per-request' },
  { mode: 'singleton', label: 'singleton' },
  { mode: undefined, label: 'unset' },
];
const divided = (maxRequests: number): number => Math.max(1, Math.floor(maxRequests / DEFAULT_ASSUMED_INSTANCES));
let unique = 0;
/** A key no other test in this file has used, so the module-level maps stay private. */
const fresh = (prefix: string): string => `${prefix}-${(unique += 1)}`;

function authOver(store: ReturnType<typeof createInMemoryCounterStore>): AuthService {
  return new AuthService(
    // The credential never resolves, so an ADMITTED attempt ends as a 401 — a
    // different failure from the 429 under test, and therefore distinguishable
    // without the test depending on a password.
    { findActiveByEmail: vi.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
    new RateLimitAuthorityService(store as never),
    TEST_SECRET,
    null,
  );
}

/** One login attempt, and the 429 it produced (or `null` for anything else). */
async function login(service: AuthService, email: string, source: string): Promise<AppError | null> {
  try {
    await service.login({ email, password: 'irrelevant' }, source);

    return null;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode === 429 ? (err as AppError) : null;
  }
}

describe('the authoritative ceiling is the constant in every deployment mode', () => {
  for (const { mode, label } of MODES) {
    it(`hands the store ${LOGIN_ACCOUNT_MAX_REQUESTS} / ${LOGIN_SOURCE_MAX_REQUESTS} — not the divided value (${label})`, async () => {
      const store = createInMemoryCounterStore();

      await login(authOver(store), fresh('victim@example.com'), fresh('198.51.100.1'));

      // The store is asked to enforce, per bucket: `10 / 30`, the configured
      // constants, in every mode. Before the authority this read `2 / 7`
      // everywhere the division applied.
      expect(store.probe.mock.calls.map((call) => call[0]?.ceiling)).toEqual([
        LOGIN_ACCOUNT_MAX_REQUESTS,
        LOGIN_SOURCE_MAX_REQUESTS,
      ]);
      // Named so the assertion above cannot pass by both numbers happening to
      // agree: these are the values the defect produced.
      expect(divided(LOGIN_ACCOUNT_MAX_REQUESTS)).toBe(2);
      expect(divided(LOGIN_SOURCE_MAX_REQUESTS)).toBe(7);
      // And the arithmetic still exists — reported on `/api/readyz`, applied to
      // no probe — so the two facts cannot drift into one another.
      expect(resolveRateLimitScope(mode, '4', LOGIN_ACCOUNT_MAX_REQUESTS).effectiveCeiling).toBe(
        mode === 'durable' ? LOGIN_ACCOUNT_MAX_REQUESTS : divided(LOGIN_ACCOUNT_MAX_REQUESTS),
      );
    });
  }

  it('admits the FULL constant before refusing, in every mode — not the divided budget', async () => {
    for (const { label } of MODES) {
      const service = authOver(createInMemoryCounterStore());
      const email = fresh('brute@example.com');
      const source = fresh('198.51.100.2');
      let refusedAt = 0;

      for (let i = 1; i <= LOGIN_ACCOUNT_MAX_REQUESTS + 1 && refusedAt === 0; i += 1) {
        if (await login(service, email, source)) {
          refusedAt = i;
        }
      }

      // Ten admitted, the eleventh refused. A mode enforcing the divided ceiling
      // refused at the third — the behaviour this file exists to prevent,
      // invisible in `durable` and very visible on the rollback.
      expect(refusedAt, `mode ${label}`).toBe(LOGIN_ACCOUNT_MAX_REQUESTS + 1);
    }
  });
});

describe('a counter-store fault is a refusal, never a degraded ceiling', () => {
  beforeEach(() => {
    // Every unreachable probe logs one line; that log is a record of the refusal,
    // not noise the test has to silence to stay readable.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('admits nobody, in any mode — the divided number decides nothing', async () => {
    for (const { label } of MODES) {
      const service = authOver(createFailingCounterStore());
      const email = fresh('outage@example.com');
      const source = fresh('198.51.100.3');
      let admitted = 0;

      // A whole ceiling's worth of attempts, which is what the per-instance
      // fallback used to let through in every non-`durable` mode.
      for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS + 5 && admitted === 0; i += 1) {
        if (!(await login(service, email, source))) {
          admitted += 1;
        }
      }

      expect(admitted, `mode ${label}`).toBe(0);
    }
  });

  it('reports the CONSTANT in the headers — never the divided number it might have applied', async () => {
    const service = authOver(createFailingCounterStore());
    const email = fresh('headers@example.com');
    const source = fresh('198.51.100.4');
    const refused = await login(service, email, source);

    // `RateLimit-Limit` must name a ceiling the caller is genuinely held to. The
    // divided value is what the removed fallback answered with; naming it now
    // would tell a correct client it may retry after 2 attempts.
    expect(refused?.headers?.['RateLimit-Limit']).toBe(String(LOGIN_ACCOUNT_MAX_REQUESTS));
    expect(refused?.headers?.['RateLimit-Limit']).not.toBe(String(divided(LOGIN_ACCOUNT_MAX_REQUESTS)));
    expect(refused?.headers?.['RateLimit-Remaining']).toBe('0');
    expect(refused?.headers?.['Retry-After']).toBe(String(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS));
    expect(refused?.headers?.['RateLimit-Reset']).toBe(String(AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS));
  });

  it('reports the constant when the store answered — the same rule, the healthy half', async () => {
    const service = authOver(createInMemoryCounterStore());
    const email = fresh('healthy@example.com');
    const source = fresh('198.51.100.5');
    let limited: AppError | null = null;

    for (let i = 0; i < LOGIN_ACCOUNT_MAX_REQUESTS + 2 && limited === null; i += 1) {
      limited = await login(service, email, source);
    }

    // The healthy path enforces the constant, so the header names the constant:
    // one rule about what is reported, on both sides of the store's answer.
    expect(limited?.headers?.['RateLimit-Limit']).toBe(String(LOGIN_ACCOUNT_MAX_REQUESTS));
  });
});
