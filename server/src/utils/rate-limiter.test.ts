/**
 * Tests for the shared in-memory sliding-window rate limiter.
 *
 * Covers the window semantics, the `Retry-After`/header contract and — the part
 * that matters most for a long-lived Workers isolate — the HARD key cap that
 * stops an attacker-controlled key space from becoming a memory leak.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildRateLimitHeaders, createRateLimiter, DEFAULT_MAX_KEYS } from './rate-limiter.js';

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

  it('evicts the OLDEST keys when the cap is reached with all-live keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const limiter = createRateLimiter(5, 60 * 60 * 1000, { maxKeys: 3 });

    limiter('a');
    vi.advanceTimersByTime(1000);
    limiter('b');
    vi.advanceTimersByTime(1000);
    limiter('c');
    vi.advanceTimersByTime(1000);
    limiter('d'); // cap hit → the oldest key ('a') is dropped

    // Bounded by construction, and the victim is the OLDEST key, not a random one.
    expect(limiter.size()).toBe(3);
    // 'a' lost its counter, so it starts from a fresh budget.
    expect(limiter('a').remaining).toBe(4);
    // The newer keys are still tracked (each with one hit recorded).
    expect(limiter.size()).toBeLessThanOrEqual(3);
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
    const headers = buildRateLimitHeaders(10, { limited: true, remaining: 0, retryAfterSeconds: 42 });

    expect(headers).toEqual({
      'Retry-After': '42',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '42',
    });
  });

  it('stringifies the values (headers must be strings)', () => {
    const headers = buildRateLimitHeaders(5, { limited: true, remaining: 0, retryAfterSeconds: 1 });

    expect(Object.values(headers).every((value) => typeof value === 'string')).toBe(true);
  });
});
