/**
 * An in-memory stand-in for the authoritative rate-limit counter store.
 *
 * Unit specs that exercise the AUTH service need a counter store to exercise
 * the auth service against. A store that returned a fixed answer would make
 * every rate-limit assertion in those files vacuous — the ceilings, the
 * trip-on-the-11th-attempt and the `RateLimit-Limit` values would be properties
 * of the stub rather than of the code — so this one COUNTS.
 *
 * It counts with `createRateLimiter` because admission parity with that limiter
 * is the repository's contract: the Mongo pipeline keeps the newest
 * `ceiling + 1` in-window attempts and refuses on `length > ceiling`, which is
 * what `createRateLimiter` reports as `limited`. The pipeline itself is exercised
 * against a real server in `repositories/rate-limit-counter.repository.integration.test.ts`,
 * which is skipped unless `RATE_LIMIT_COUNTER_TEST_URI` names a cluster.
 *
 * The returned object is a structural stand-in for `RateLimitCounterRepository`,
 * so a spec passes it with `as never` exactly as it passes the mock repositories
 * next to it.
 */
import { vi } from 'vitest';
import { createRateLimiter, type RateLimiter } from '../utils/rate-limiter.js';
import type {
  RateLimitCounterProbe,
  RateLimitCounterProbeRequest,
} from '../repositories/rate-limit-counter.repository.js';

export interface InMemoryCounterStore {
  /** The call is recorded so a spec can assert how many operations reached the store. */
  probe: ReturnType<typeof vi.fn>;
  /** Every document `_id` the store was asked about, in order. */
  readonly ids: string[];
}

/**
 * A counting store, keyed by the real `<bucket>:<hash>` document `_id` — so two
 * buckets asking about the same raw value are counted separately, exactly as two
 * documents are.
 */
export function createInMemoryCounterStore(): InMemoryCounterStore {
  const windows = new Map<string, RateLimiter>();
  const ids: string[] = [];

  return {
    ids,
    probe: vi.fn(async (request: RateLimitCounterProbeRequest): Promise<RateLimitCounterProbe> => {
      ids.push(request.id);

      const windowId = `${request.id}|${request.windowMs}`;
      let window = windows.get(windowId);

      if (window === undefined) {
        window = createRateLimiter(request.ceiling, request.windowMs);
        windows.set(windowId, window);
      }

      const result = window(request.id, request.ceiling);

      // A refused probe still appends to the retained window (that is what makes
      // `length > ceiling` the refusal test), so the steady state while a key is
      // over budget is `ceiling + 1` — reported here rather than the limiter's
      // internal count, which is not exposed.
      return {
        inWindow: result.limited ? request.ceiling + 1 : request.ceiling - result.remaining,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }),
  };
}

/**
 * A store that always fails — the condition the authority now fails CLOSED on.
 *
 * `AuthService` is only ever handed this in the tests whose subject IS the
 * store outage: without an unreachable store the failure branch is never taken,
 * and a fail-closed guarantee with no test that can fail would prove nothing.
 */
export function createFailingCounterStore(message = 'counter store unavailable'): InMemoryCounterStore {
  const ids: string[] = [];

  return {
    ids,
    probe: vi.fn(async (request: RateLimitCounterProbeRequest): Promise<RateLimitCounterProbe> => {
      ids.push(request.id);
      throw new Error(message);
    }),
  };
}
