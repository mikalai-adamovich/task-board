/**
 * Shared in-process sliding-window rate limiter.
 *
 * Extracted from `services/auth.service.ts` so the login path, the invitation
 * cooldown and the authenticated-route middleware all share ONE implementation
 * and ONE `Retry-After` / `RateLimit-*` header builder — no second, subtly
 * different limiter.
 *
 * ## Why in-process
 * The counters live in module-level `Map`s inside a reused Workers isolate (or
 * inside the Durable Object when `DB_CLIENT_MODE=durable`). Consequences, stated
 * honestly:
 * - the ceiling is PER ISOLATE / PER DO INSTANCE, so a request spread across PoPs
 *   (or across DO instances) gets a fresh budget per instance. In production
 *   (`DB_CLIENT_MODE=durable`, one DO identity at `index.ts`) that is one
 *   instance, so the abuse ceiling is `limit × 1` — the DO identity is a
 *   SECURITY parameter, not only a performance one, and a mode-aware counter
 *   (the audit's Q4) does not exist. See `AGENTS.md` §Stack.
 * - the counters reset when the isolate is evicted or the DO is restarted;
 * - a KV / Durable-Object-backed counter would fix the first two, but it needs a
 *   new Cloudflare binding and a decision about DO topology — deliberately NOT
 *   introduced here.
 *
 * For abuse mitigation against credential stuffing and request flooding this is
 * the right trade-off today: it costs zero extra round-trips on the hot path.
 *
 * ## Bounded memory
 * A `Map` keyed by attacker-controlled input is the classic Workers memory-leak
 * class. {@link createRateLimiter} therefore enforces a HARD key cap
 * (`maxKeys`, default {@link DEFAULT_MAX_KEYS}): expired keys are swept first, and
 * if the map is still over the cap the oldest entries are dropped. Growth is
 * bounded by construction, not by hope.
 */

/** Outcome of a single rate-limiter probe. */
export interface RateLimitResult {
  /** True when the request must be rejected with 429. */
  limited: boolean;
  /** Requests still available in the current window (0 when limited). */
  remaining: number;
  /**
   * Whole seconds until the caller may retry — derived from the OLDEST attempt
   * still inside the sliding window, which is the first one to expire. `0`
   * when the request was allowed.
   */
  retryAfterSeconds: number;
}

/**
 * Build the `Retry-After` + `RateLimit-*` headers for a throttled response.
 *
 * The limiter trips correctly, but without these headers a client has
 * no way to know how long to back off and can only guess (or hammer).
 * RFC 9110 §10.2.3 defines `Retry-After` in seconds; RFC 6585 §4 defines the
 * `RateLimit-*` family. Every 429 in the API goes through this builder.
 */
export function buildRateLimitHeaders(maxRequests: number, result: RateLimitResult): Record<string, string> {
  return {
    'Retry-After': String(result.retryAfterSeconds),
    'RateLimit-Limit': String(maxRequests),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.retryAfterSeconds),
  };
}

/**
 * Hard cap on distinct keys a single limiter may hold before it starts evicting.
 *
 * 5 000 keys × a small array of timestamps is a few hundred KB at worst — safe
 * inside a 128 MB isolate even with several limiters. A spray across many
 * identities (emails, IPs) is exactly the traffic that would otherwise grow the
 * map without bound; past the cap the oldest keys are dropped, which costs the
 * attacker their own counter (and only theirs — the map is small enough that
 * honest users are evicted long after their windows expired).
 */
export const DEFAULT_MAX_KEYS = 5_000;

export interface RateLimiterOptions {
  /** Hard cap on distinct keys held in memory (see {@link DEFAULT_MAX_KEYS}). */
  maxKeys?: number;
}

export interface RateLimiter {
  /**
   * Probe (and, when allowed, record) one request for `key`.
   *
   * `maxRequests` OVERRIDES the ceiling configured at construction. It exists
   * for the mode-aware deployment ceiling (
   * `utils/rate-limit-scope.ts`): a limiter must keep ONE set of counters
   * across requests, so the ceiling is applied per probe rather than by
   * rebuilding the limiter. Omit it to use the configured ceiling.
   */
  (key: string, maxRequests?: number): RateLimitResult;
  /** Number of keys currently held — exported for the eviction test. */
  size(): number;
}

/**
 * Build a sliding-window limiter: at most `maxRequests` hits per `key` inside a
 * rolling `windowMs` window.
 *
 * Intentionally module-scoped by its CALLERS (a limiter is useless if it is
 * rebuilt per request) — the service graph itself stays request-scoped, see
 * `AGENTS.md`.
 */
export function createRateLimiter(
  maxRequests: number,
  windowMs: number,
  options: RateLimiterOptions = {},
): RateLimiter {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const attempts = new Map<string, number[]>();
  /**
   * MONOTONIC CLOCK. `Date.now()` is wall-clock and can step backwards (an NTP
   * correction, a suspended/restored VM, a manual `date`), a distinction
   * `utils/timings.ts:67` states explicitly and applies for the request timer.
   * A backwards step made `now - ts` negative, so the filter below KEPT attempts
   * that had already fallen out of the window: the sliding window WIDENED and the
   * abuse control failed OPEN. Clamping the wall clock to the last reading makes
   * the source monotonic — elapsed time is never negative, so the window can
   * shrink but never grow. That is the fail-closed direction.
   *
   * Scoped to THIS limiter, not to the module: a limiter is a value with its own
   * lifetime, and a shared "last reading" would let one clock (a frozen test
   * timer, one key's skew) freeze every other window in the isolate.
   */
  let lastReading = Number.NEGATIVE_INFINITY;
  const monotonicNow = (): number => {
    const wall = Date.now();

    if (wall > lastReading) {
      lastReading = wall;
    }

    return lastReading;
  };
  /** Drop keys whose every hit fell out of the window. */
  const sweepExpired = (now: number): void => {
    for (const [key, timestamps] of attempts) {
      if (timestamps.every((ts) => now - ts >= windowMs)) {
        attempts.delete(key);
      }
    }
  };
  /**
   * Enforce the hard cap. Expired keys go first; if the map is still over the
   * cap (every key is live — i.e. a key-spray inside one window) the OLDEST keys
   * are dropped. Cheapest correct bound: the map can never exceed `maxKeys`.
   */
  const enforceCap = (now: number): void => {
    if (attempts.size <= maxKeys) {
      return;
    }

    sweepExpired(now);

    if (attempts.size <= maxKeys) {
      return;
    }

    const byAge = [...attempts.entries()].sort(([, a], [, b]) => (a[a.length - 1] ?? 0) - (b[b.length - 1] ?? 0));

    for (const [key] of byAge.slice(0, attempts.size - maxKeys)) {
      attempts.delete(key);
    }
  };
  const limiter = ((key: string, ceilingOverride?: number): RateLimitResult => {
    // The effective ceiling for THIS probe. `?? maxRequests` rather
    // than a default parameter, so an explicit `undefined` (which is what an
    // optional constructor argument forwards under `exactOptionalPropertyTypes`)
    // falls back to the configured value instead of comparing against `undefined`.
    const ceiling = ceilingOverride ?? maxRequests;
    const now = monotonicNow();
    const timestamps = (attempts.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (timestamps.length >= ceiling) {
      attempts.set(key, timestamps);

      // The oldest in-window attempt is the first to fall out of the window,
      // so that is exactly when a slot frees up. At least 1s so a client that
      // retries immediately is not told "retry now".
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));

      return { limited: true, remaining: 0, retryAfterSeconds };
    }

    timestamps.push(now);
    attempts.set(key, timestamps);
    enforceCap(now);

    return {
      limited: false,
      remaining: ceiling - timestamps.length,
      retryAfterSeconds: 0,
    };
  }) as RateLimiter;

  limiter.size = () => attempts.size;

  return limiter;
}
