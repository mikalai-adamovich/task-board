/**
 * Tests for the shared in-memory sliding-window rate limiter.
 *
 * Covers the window semantics, the `Retry-After`/header contract and — the part
 * that matters most for a long-lived Workers isolate — the HARD key cap that
 * stops an attacker-controlled key space from becoming a memory leak.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildRateLimitHeaders, createRateLimiter, isAtCapacity, DEFAULT_MAX_KEYS } from './rate-limiter.js';

describe('createRateLimiter — window semantics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows exactly maxRequests inside the window and rejects the next one', () => {
    const limiter = createRateLimiter(3, 60_000);

    for (let i = 0; i < 3; i++) {
      expect(limiter('k').limited).toBe(false);
    }

    const rejected = limiter('k');

    expect(rejected.limited).toBe(true);
    expect(rejected.remaining).toBe(0);
  });

  it('counts down `remaining` while requests are allowed', () => {
    const limiter = createRateLimiter(3, 60_000);

    expect(limiter('k').remaining).toBe(2);
    expect(limiter('k').remaining).toBe(1);
    expect(limiter('k').remaining).toBe(0);
  });

  it('keeps keys independent (one noisy key never throttles another)', () => {
    const limiter = createRateLimiter(2, 60_000);

    limiter('a');
    limiter('a');

    expect(limiter('a').limited).toBe(true);
    expect(limiter('b').limited).toBe(false);
  });

  it('reports retryAfterSeconds = 0 when the request was allowed', () => {
    const limiter = createRateLimiter(2, 60_000);

    expect(limiter('k').retryAfterSeconds).toBe(0);
  });

  it('frees a slot once the window slides past the oldest attempt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(1, 1000);

    expect(limiter('k').limited).toBe(false);
    expect(limiter('k').limited).toBe(true);

    // Halfway: still inside the window.
    vi.advanceTimersByTime(500);
    expect(limiter('k').limited).toBe(true);

    // Past the window: the first attempt has fallen out.
    vi.advanceTimersByTime(600);
    expect(limiter('k').limited).toBe(false);
  });

  it('drops an attempt at EXACTLY the window edge, and keeps one a millisecond younger', () => {
    // The boundary, decided rather than described. The Mongo pipeline's `$gt`
    // filter is documented as matching this exact comparison — `now - ts <
    // windowMs`, so an attempt exactly `windowMs` old has LEFT the window — and
    // nothing else in this file pins it: the neighbouring test slides 500 ms and
    // then 600 ms, which both `<` and `<=` would answer identically. A `<=` here
    // would hold an attempt a whole millisecond past its expiry, and the two
    // tiers would then disagree about who is inside the window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const windowMs = 60_000;
    const limiter = createRateLimiter(1, windowMs);

    expect(limiter('edge').limited).toBe(false);

    // One millisecond INSIDE the window: still counted, so still refused.
    vi.advanceTimersByTime(windowMs - 1);
    expect(limiter('edge').limited).toBe(true);

    // And exactly AT it: that attempt has left the window, and the slot is free.
    vi.advanceTimersByTime(1);
    expect(limiter('edge').limited).toBe(false);
  });

  it('derives retryAfterSeconds from the oldest in-window attempt (never 0, never fractional)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(1, 60_000);

    limiter('k');
    vi.advanceTimersByTime(30_000);

    const rejected = limiter('k');

    expect(rejected.limited).toBe(true);
    expect(Number.isInteger(rejected.retryAfterSeconds)).toBe(true);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe('createRateLimiter — the window is driven by a MONOTONIC clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never reports a retry hint longer than the window it is drawn from', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const windowMs = 60_000;
    const limiter = createRateLimiter(1, windowMs);

    expect(limiter('k').limited).toBe(false);

    // An hour backwards (NTP correction, a restored VM, a manual `date`). With a
    // raw `Date.now()` the limiter's timeline diverges from real time: the attempt
    // now reads as being in the future, so it stays counted for an extra hour
    // AND the `Retry-After` handed to the client — the one number a throttled
    // caller obeys — grows to ~3660 s, sixty times the window that is actually
    // configured. The property: the hint is bounded by the window, whatever the
    // wall clock does.
    vi.setSystemTime(new Date('2025-12-31T23:00:00.000Z'));

    const rejected = limiter('k');

    expect(rejected.limited).toBe(true);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(windowMs / 1000));
  });

  it('still ages attempts out once the clock is back at (or past) the last reading', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(1, 1000);

    limiter('k');
    vi.setSystemTime(new Date('2025-12-31T23:00:00.000Z'));
    expect(limiter('k').limited).toBe(true);

    // Past the window relative to the frozen reading → the slot frees. Clamping
    // must not turn into a permanent lockout.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.100Z'));

    expect(limiter('k').limited).toBe(false);
  });
});

describe('createRateLimiter — bounded memory (F10 requirement 5)', () => {
  it('never holds more than maxKeys keys, even when every key is fresh', () => {
    const limiter = createRateLimiter(5, 60 * 60 * 1000, { maxKeys: 10 });

    // A key-spray: 500 distinct keys, all inside the window (so none is expired
    // and none can be swept as stale).
    for (let i = 0; i < 500; i++) {
      limiter(`spray-${i}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(10);
  });

  it('sweeps expired keys before evicting live ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(5, 1000, { maxKeys: 10 });

    // 12 keys (already over the cap), then a 2s jump makes all of them expired.
    for (let i = 0; i < 12; i++) {
      limiter(`old-${i}`);
    }

    vi.advanceTimersByTime(2000);

    // The next call trips the cap check, which sweeps the stale entries — no
    // LRU eviction of a key that is still inside its window is needed.
    limiter('fresh-1');

    expect(limiter.size()).toBe(1);
  });

  it('refuses a NEW key at the cap instead of evicting a live one — the limiter fails CLOSED', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(5, 60 * 60 * 1000, { maxKeys: 3 });

    limiter('a');
    vi.advanceTimersByTime(1000);
    limiter('b');
    vi.advanceTimersByTime(1000);
    limiter('c');
    vi.advanceTimersByTime(1000);

    const refused = limiter('d'); // cap hit with every key still inside its window

    // Bounded by construction, and the map did NOT grow to make room.
    expect(limiter.size()).toBe(3);
    // The NEW key is the one rejected — with the ordinary throttled result, so
    // the caller answers 429 exactly as it does for any other rejection.
    expect(refused.limited).toBe(true);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    // The keys that were already counting were left alone: this allowed probe
    // is 'a''s SECOND hit, so 3 of its 5-request budget remain. Under the old
    // evict-the-oldest policy this read 4 — the counter had been thrown away and
    // the key restarted from a full budget, which is the fail-open.
    expect(limiter('a').remaining).toBe(3);
    // Five hits in, not six: the budget the flood tried to buy does not exist.
    expect(limiter('a').remaining).toBe(2);
  });

  it('at the cap, a live key that already spent its budget is STILL limited afterwards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(2, 60_000, { maxKeys: 2 });

    // Spend 'attacker-1''s whole budget, then fill the map to the cap.
    expect(limiter('attacker-1').limited).toBe(false);
    expect(limiter('attacker-1').limited).toBe(false);
    expect(limiter('attacker-1').limited).toBe(true);
    limiter('attacker-2'); // the map is now at maxKeys, both keys LIVE
    expect(limiter.size()).toBe(2);

    // A spray of new keys at the cap — each is refused, and none of them may
    // reset a counter that is still counting.
    for (let i = 0; i < 25; i++) {
      expect(limiter(`spray-${i}`).limited).toBe(true);
    }

    // The live, already-limited key is still limited: its recorded attempts
    // survived the cap, so the flood bought no extra budget.
    const after = limiter('attacker-1');

    expect(after.limited).toBe(true);
    expect(after.remaining).toBe(0);
    // The refused key produced no counter, so the flood could not grow the map.
    expect(limiter.size()).toBe(2);
  });

  it('a cap refusal carries the same Retry-After / RateLimit-* header set as any other 429', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const windowMs = 60_000;
    const limiter = createRateLimiter(5, windowMs, { maxKeys: 1 });

    limiter('a'); // the single slot
    vi.advanceTimersByTime(5_000); // 55s of the window still to run

    const refused = limiter('b');

    expect(refused.limited).toBe(true);
    expect(buildRateLimitHeaders(5, refused)).toEqual({
      // Bounded by the window: the soonest a slot can appear is 'a' expiring.
      'Retry-After': '55',
      'RateLimit-Limit': '5',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '55',
    });
  });

  it('a refused key is admitted once the tracked keys have expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(5, 1000, { maxKeys: 2 });

    limiter('a');
    limiter('b');
    expect(limiter('c').limited).toBe(true); // cap: refused, not evicted-into
    expect(limiter.size()).toBe(2);

    // Both tracked windows close → the sweep frees the whole map and admission
    // resumes. Clamping the cap must not turn into a permanent lockout.
    vi.advanceTimersByTime(1001);

    expect(limiter('c').limited).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it('uses a hard default cap so a limiter built without options is still bounded', () => {
    const limiter = createRateLimiter(1, 60 * 60 * 1000);

    for (let i = 0; i < DEFAULT_MAX_KEYS + 250; i++) {
      limiter(`k-${i}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(DEFAULT_MAX_KEYS);
  });
});

describe('buildRateLimitHeaders (F6)', () => {
  it('emits the RFC 9110 / RFC 6585 header set', () => {
    const headers = buildRateLimitHeaders(10, {
      limited: true,
      outcome: 'limited',
      remaining: 0,
      retryAfterSeconds: 42,
    });

    expect(headers).toEqual({
      'Retry-After': '42',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '42',
    });
  });

  it('stringifies the values (headers must be strings)', () => {
    const headers = buildRateLimitHeaders(5, {
      limited: true,
      outcome: 'at_capacity',
      remaining: 0,
      retryAfterSeconds: 1,
    });

    expect(Object.values(headers).every((value) => typeof value === 'string')).toBe(true);
  });

  it('builds the same header set for a capacity refusal as for an ordinary 429', () => {
    // The condition differs; the wire contract does not. A client cannot tell
    // the two apart from headers, which is why the service layer — not the
    // response — is where the distinction has to be read.
    const headers = buildRateLimitHeaders(5, {
      limited: true,
      outcome: 'at_capacity',
      remaining: 0,
      retryAfterSeconds: 3,
    });

    expect(headers).toEqual({
      'Retry-After': '3',
      'RateLimit-Limit': '5',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '3',
    });
  });
});

describe('createRateLimiter — being FULL is reported as its own condition', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('distinguishes at-capacity from over-budget from allowed', () => {
    const limiter = createRateLimiter(1, 60_000, { maxKeys: 1 });
    const allowed = limiter('a');

    expect(allowed.limited).toBe(false);
    expect(allowed.outcome).toBe('allowed');
    expect(isAtCapacity(allowed)).toBe(false);

    // Same key, budget spent: a fact about the CALLER.
    const overBudget = limiter('a');

    expect(overBudget.limited).toBe(true);
    expect(overBudget.outcome).toBe('limited');
    expect(isAtCapacity(overBudget)).toBe(false);

    // A key that has spent nothing, in a limiter that is simply full: a fact
    // about the PROCESS, and the only reason the outcome field exists — both
    // answers are `limited: true`, so a caller reading only that flag cannot tell
    // "you are over budget" from "nobody is being counted right now".
    const refused = limiter('b');

    expect(refused.limited).toBe(true);
    expect(refused.outcome).toBe('at_capacity');
    expect(isAtCapacity(refused)).toBe(true);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('a key tracked before the cap is still judged on its OWN budget at the cap', () => {
    const limiter = createRateLimiter(2, 60_000, { maxKeys: 2 });

    limiter('tracked-1');
    limiter('tracked-2'); // the map is at the cap, both keys live and under budget

    // Capacity does not turn a live key's allowance into a rejection.
    expect(limiter('tracked-1').limited).toBe(false);
    expect(limiter('tracked-2').limited).toBe(false);
    // And it does not turn an over-budget key's rejection into a capacity one.
    limiter('tracked-1');
    limiter('tracked-1');
    expect(limiter('tracked-1').outcome).toBe('limited');
  });

  it('the monotonic guard does NOT free capacity during a backwards clock step', () => {
    // The documented behaviour, asserted rather than asserted-as-a-benefit: the
    // clamp exists so the window cannot WIDEN (a fail-open), and it has the
    // opposite effect on admission — while the wall clock is behind, no key ages
    // out, so a limiter at its cap stays at its cap for the whole skew. The
    // honest response is the `at_capacity` outcome above, not a promise that the
    // refusal lasts one window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(5, 1_000, { maxKeys: 2 });

    limiter('a');
    limiter('b');
    expect(limiter.size()).toBe(2);

    // An hour backwards. In real time both keys are ancient.
    vi.setSystemTime(new Date('2025-12-31T23:00:00.000Z'));

    const duringSkew = limiter('c');

    expect(duringSkew.outcome).toBe('at_capacity');
    expect(limiter.size()).toBe(2);

    // Once the clock is back past the window relative to the frozen reading,
    // the sweep frees them again.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.100Z'));

    expect(limiter('c').limited).toBe(false);
    expect(limiter.size()).toBe(1);
  });
});
