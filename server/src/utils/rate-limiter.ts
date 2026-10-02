/**
 * Shared in-process sliding-window rate limiter.
 *
 * Extracted from `services/auth.service.ts` so the login path, the invitation
 * cooldown and the authenticated-route middleware all share ONE implementation
 * and ONE `Retry-After` / `RateLimit-*` header builder — no second, subtly
 * different limiter.
 *
 * ## What this is on the authentication path: the ADVISORY tier
 * The four authentication buckets are counted by MongoDB
 * (`services/rate-limit-authority.service.ts`), one atomic operation per probe,
 * so the enforced ceiling does not multiply by instances. On that path this
 * limiter is consulted BEFORE the store and may REFUSE a saturated key without
 * spending an operation, but it may never admit anything: when the store cannot
 * produce a verdict the authority refuses the request rather than asking a
 * per-instance map to answer for a global ceiling.
 *
 * `peek()` is the read-only door to that: it refuses nothing and records nothing,
 * so reaching the store cannot spend an admission the store has not granted. A
 * local timestamp is written only after the store admitted that same attempt, so
 * the local set is a subset of the stored one and a local refusal is sound rather
 * than merely plausible. `forget()` used to serve the counterpart case — entries
 * the fallback had written with no store behind them — and is gone with that
 * tier: nothing writes an unconfirmed timestamp any more, so there is nothing to
 * retract.
 *
 * The counters live in module-level `Map`s inside a reused Workers isolate (or
 * inside the Durable Object when `DB_CLIENT_MODE=durable`), so they reset when
 * the isolate is evicted or the DO is restarted. On the advisory tier that costs
 * a round trip and nothing else: the store still holds the authoritative count,
 * so the next probe simply rebuilds the local record from the store's own answer.
 *
 * The route middleware's own limiters are unaffected: they are not among the
 * four authentication buckets and still run entirely on this.
 *
 * ## Bounded memory, and bounded WITHOUT failing open
 * A `Map` keyed by attacker-controlled input is the classic Workers memory-leak
 * class, so {@link createRateLimiter} enforces a HARD key cap (`maxKeys`, default
 * {@link DEFAULT_MAX_KEYS}). The cap is enforced on ADMISSION: a key that is
 * already tracked costs no memory, and a key that is new is admitted only while
 * the map is below the cap. When the map is full of live keys the new key is
 * REFUSED — the ordinary 429, with the same `Retry-After` / `RateLimit-*`
 * headers as any other rejection — and the counters that are already counting
 * are left alone.
 *
 * **What this cap bounds: the process-local map, and nothing else.** It is a
 * memory bound on THIS isolate (or this Durable Object), on the advisory record of
 * attempts already admitted by the store. It is NOT a bound on the MongoDB
 * collection behind the four authentication buckets: the store keeps one document
 * per bucket/scope pair whatever this map holds, sweeps it by TTL, and its size is
 * a function of how many distinct scopes are simultaneously live — not of
 * `maxKeys`. The two are unrelated quantities, and reading this number as a
 * storage ceiling is the mistake this paragraph exists to prevent. The storage
 * model, the measured document size and the worst-case calculation are in
 * `docs/architecture.md` §2.7.
 *
 * The earlier policy dropped the OLDEST live counters to make room, which is the
 * one thing a rate limiter must never do: eviction of a live counter is a silent
 * FAIL-OPEN. The victim gets a fresh budget, nothing in the response says so, and
 * because these counters are in-process the abuse ceiling documented in
 * `AGENTS.md` §Stack (`limit × DO instances`) is quietly multiplied by however
 * many keys the attacker sprayed. Failing closed means a newcomer is refused
 * rather than admitted for free, and a spray of distinct identities — the only
 * traffic that reaches the cap — buys itself nothing.
 *
 * ## Refusal at the cap is ITS OWN condition, and is reported as one
 * `limited` alone cannot carry both meanings. "This identity has spent its
 * budget" is a fact about the CALLER and resolves with that caller's own window.
 * "This limiter is full" is a fact about the PROCESS: it can be true because one
 * caller sprayed thousands of keys, and it then refuses every OTHER caller's new
 * keys too — including callers that have spent nothing. A caller that reads only
 * `limited` cannot tell them apart, which is how a full limiter turns into a
 * silent outage on a path whose response is deliberately identical whether or not
 * the work happened. So the outcome is a separate field
 * ({@link RateLimitResult.outcome}), and callers that act on the difference —
 * the password-reset path, the invitation cooldown — say so.
 */

/**
 * Why a probe came back the way it did.
 *
 * `at_capacity` is deliberately NOT collapsed into `limited`. Both are 429s, but
 * they are different failures with different owners and different remedies: a
 * caller over budget should wait out its own window, while a limiter at capacity
 * means its own tracked keys have to expire first — and, if the caller is
 * reading only this flag, it means the limiter is no longer enforcing anything
 * about this caller either.
 */
export type RateLimitOutcome = 'allowed' | 'limited' | 'at_capacity';

/** Outcome of a single rate-limiter probe. */
export interface RateLimitResult {
  /** True when the request must be rejected with 429. */
  limited: boolean;
  /**
   * Which rejection this is — the half of the answer `limited` cannot express.
   * A caller whose behaviour differs between "you are over budget" and "this
   * limiter is full" must read this rather than infer it.
   */
  outcome: RateLimitOutcome;
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
 * Whether this rejection is the limiter being FULL rather than the caller being
 * over budget.
 *
 * Exported as a predicate so the distinction cannot be re-derived by comparing
 * flags at a dozen call sites.
 */
export function isAtCapacity(result: RateLimitResult): boolean {
  return result.outcome === 'at_capacity';
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
 * Hard cap on distinct keys a single limiter holds in PROCESS MEMORY at once.
 *
 * 5 000 keys × a small array of timestamps is a few hundred KB at worst — safe
 * inside a 128 MB isolate even with several limiters. A spray across many
 * identities (emails, IPs) is exactly the traffic that would otherwise grow the
 * map without bound, so past the cap the limiter stops admitting NEW keys and
 * rejects them with the normal 429 instead of evicting a live counter: see
 * "Bounded memory, and bounded WITHOUT failing open" above. Growth is bounded by
 * construction, and no tracked key is ever forgotten while it is still counting.
 *
 * SCOPE OF THIS NUMBER, because the size makes it read as a storage ceiling and it
 * is not one: it bounds the in-process advisory map only, and it is **not a bound
 * on the collection**. The authoritative counters live in MongoDB, one document per
 * bucket/scope pair, and the number of those documents is set by how many distinct
 * scopes are live at once — bounded by the store's per-window TTL, not by this
 * constant. Raising or lowering this constant changes the memory a single isolate
 * holds and nothing about the collection.
 */
export const DEFAULT_MAX_KEYS = 5_000;

export interface RateLimiterOptions {
  /**
   * Hard cap on distinct keys held in THIS PROCESS's memory — not on any stored
   * counter (see {@link DEFAULT_MAX_KEYS}).
   */
  maxKeys?: number;
}

/**
 * A key's record as it stands, read WITHOUT recording anything.
 *
 * `retryAfterSeconds` is computed by the limiter itself rather than by the
 * caller so the monotonic clock and the window stay inside the module that owns
 * them — a caller cannot recompute the same number from `Date.now()` without
 * inheriting the backwards-step behaviour `createRateLimiter` guards against.
 */
export interface RateLimitPeek {
  /** In-window attempts recorded for this key (0 when the key is unknown). */
  count: number;
  /** Seconds until the OLDEST recorded attempt leaves the window; 0 at count 0. */
  retryAfterSeconds: number;
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
  /**
   * Read this key's record without recording anything.
   *
   * This is what lets the limiter sit in front of the authoritative counter
   * (`services/rate-limit-authority.service.ts`): the local tier may REFUSE on a
   * saturated key, but it may not record an attempt until the authoritative
   * store has admitted that same attempt. Without a non-recording read the only
   * way to consult it would be to call it, which would spend an admission the
   * authority has not granted.
   */
  peek(key: string): RateLimitPeek;
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
   * `utils/timings.ts` states explicitly and applies for the request timer.
   *
   * What it DOES: it prevents a WIDENED window. With a raw wall clock a backwards
   * step makes `now - ts` negative, so the filter below KEEPS attempts that have
   * already fallen out of the window — the window grows, attempts stop expiring,
   * and the abuse control fails OPEN. Clamping to the last reading makes elapsed
   * time never negative, so the window can shrink but never grow. That is the
   * fail-closed direction, and it is the whole of it.
   *
   * What it does NOT do: it does not free CAPACITY, and it does not make a refusal
   * at the cap temporary. Every key is swept against this same clock, so while the
   * wall clock is behind, `now - last` stays negative for keys that are already
   * stale in real time, nothing is swept, and a limiter sitting at `maxKeys` stays
   * full for the entire skew — which is exactly when a monitoring alert or an NTP
   * fix is least likely to be looked at. The cap therefore stays bounded (that is
   * what the monotonic clock buys) while the DURATION of a capacity refusal is
   * bounded by the skew rather than by one window. Callers are given the condition
   * itself (`outcome: 'at_capacity'`) instead of a wait they would read as a
   * window they caused.
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
  /**
   * Drop keys whose every hit fell out of the window, and report how long until
   * the SOONEST surviving key frees its slot (its last hit plus the window).
   *
   * That wait is the honest `Retry-After` for a key refused at the cap: a slot
   * cannot appear before some tracked key's window closes. When the clock is
   * advancing, that is at most one window away — but the sweep measures against
   * the monotonic clock, so a backwards step makes it unbounded (see
   * `monotonicNow`), which is why the answer is reported as
   * `outcome: 'at_capacity'` and not as an ordinary per-caller limit.
   */
  const sweepExpired = (now: number): number => {
    let nextFreeInMs = Number.POSITIVE_INFINITY;

    for (const [key, timestamps] of attempts) {
      const last = timestamps[timestamps.length - 1];

      if (last === undefined || now - last >= windowMs) {
        attempts.delete(key);
      } else {
        nextFreeInMs = Math.min(nextFreeInMs, last + windowMs - now);
      }
    }

    return nextFreeInMs;
  };
  const limiter = ((key: string, ceilingOverride?: number): RateLimitResult => {
    // The effective ceiling for THIS probe. `?? maxRequests` rather
    // than a default parameter, so an explicit `undefined` (which is what an
    // optional constructor argument forwards under `exactOptionalPropertyTypes`)
    // falls back to the configured value instead of comparing against `undefined`.
    const ceiling = ceilingOverride ?? maxRequests;
    const now = monotonicNow();
    const known = attempts.get(key);
    let timestamps: number[];

    if (known === undefined) {
      // Admission is the ONLY place the map can grow, so the cap is a condition
      // on it. Stale keys are swept first (they cost nothing to keep and would
      // otherwise hold the map at the cap forever); if keys are still live the
      // new key is refused rather than a live counter being dropped to make
      // room — see the header note on failing open.
      if (attempts.size >= maxKeys) {
        const nextFreeInMs = sweepExpired(now);

        if (attempts.size >= maxKeys) {
          return {
            limited: true,
            // Reported as its own outcome, not as `limited`: nothing about THIS
            // caller has been spent. The wait below is bounded by when a tracked
            // key expires, which a caller can act on, but during a backwards
            // clock step nothing expires at all — see the note on
            // `monotonicNow` — so the honest report is "this limiter is full",
            // not "you are over budget".
            outcome: 'at_capacity',
            remaining: 0,
            // At least 1s, like every other rejection: a slot is a real
            // possibility but not this millisecond, and `Retry-After: 0` invites
            // an immediate retry that will be refused for the same reason.
            retryAfterSeconds: Math.max(1, Math.ceil(Math.min(nextFreeInMs, windowMs) / 1000)),
          };
        }
      }

      timestamps = [];
    } else {
      timestamps = known.filter((ts) => now - ts < windowMs);
    }

    if (timestamps.length >= ceiling) {
      attempts.set(key, timestamps);

      // The oldest in-window attempt is the first to fall out of the window,
      // so that is exactly when a slot frees up. At least 1s so a client that
      // retries immediately is not told "retry now".
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));

      return { limited: true, outcome: 'limited', remaining: 0, retryAfterSeconds };
    }

    timestamps.push(now);
    attempts.set(key, timestamps);

    return {
      limited: false,
      outcome: 'allowed',
      remaining: ceiling - timestamps.length,
      retryAfterSeconds: 0,
    };
  }) as RateLimiter;

  limiter.size = () => attempts.size;
  limiter.peek = (key: string): RateLimitPeek => {
    const known = attempts.get(key);

    if (known === undefined) {
      return { count: 0, retryAfterSeconds: 0 };
    }

    // Read-only: out-of-window entries are FILTERED here but not dropped from
    // the map, because dropping them is the sweep's job and a sweep during a
    // read would make `peek` a writer. The next real probe removes them.
    const now = monotonicNow();
    const inWindow = known.filter((ts) => now - ts < windowMs);
    const oldest = inWindow[0];

    return {
      count: inWindow.length,
      retryAfterSeconds: oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  };

  return limiter;
}
