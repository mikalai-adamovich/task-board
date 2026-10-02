/**
 * The rate-limit AUTHORITY for the four authentication buckets.
 *
 * ## What this changes, and what it deliberately does not
 *
 * The abuse ceiling used to be whatever a reused isolate happened to remember,
 * which made it `limit × instances` — a product the repository does not control,
 * and one that resets on every deploy and isolate eviction. This service makes
 * MongoDB the place that answers, and MongoDB is already on the path every one
 * of these four buckets needs: login reads the user, registration reads and
 * writes `users`, and password reset reads the user and writes a token. So the
 * counter adds no availability coupling of its own, which is the reason it was
 * worth putting there rather than in a Durable Object.
 *
 * What that reason does NOT say, because it is false: that a counter outage
 * cannot break a login that would have worked. The counter op and the user
 * lookup are INDEPENDENT operations, so the two faults have to be separated. A
 * TOTAL MongoDB outage takes the lookup with it and the login fails either way.
 * A fault confined to the counter leaves the lookup working — which is exactly
 * why the counter's failure is now VISIBLE to the client rather than silently
 * degrading the ceiling: it costs the REQUEST, not just the ceiling, and the
 * client is told so with an ordinary, contract-compatible 429.
 *
 * ## Two tiers, in this order
 *
 * 1. **Advisory local map** (`createRateLimiter`, `utils/rate-limiter.ts`) —
 *    consulted first and able to REFUSE a saturated key without spending a store
 *    operation, never to record.
 * 2. **The authoritative store** (`RateLimitCounterRepository`) — one atomic
 *    `findOneAndUpdate` per probe; the verdict is its post-image.
 *
 * There is no third tier. When the store cannot produce a verdict the probe is
 * REFUSED, because the invariant this service exists to hold is that the
 * authoritative ceiling does not depend on the number of Worker/DO instances —
 * and a per-instance answer cannot honour it. Under a counter-only fault the
 * ceiling would degrade from `limit` to `limit ÷ instances` while the login
 * still succeeded, so the ceiling would be enforced by a number of instances the
 * operator does not choose (measured on the counter-only fault: `counterOk=0/20`
 * while `authLookupOk=20/20`, twenty successful logins under a degraded ceiling).
 * No admission is better than an admission nobody can account for.
 *
 * The counter is a DISTINCT operation from the user lookup, which is why a
 * counter-only fault is now a refusal the client can observe rather than a
 * silently looser ceiling on a request that would have worked.
 *
 * ## One ceiling, because there is one tier that can refuse on a stored count
 *
 * The store counts one document per bucket/scope pair, so its verdict does not
 * depend on how many isolates exist: the enforced ceiling is the configured
 * constant (10 / 30 / 20 / 5) in every deployment mode. The probe therefore
 * reads that number from the BUCKET'S OWN definition and takes no ceiling
 * argument at all, so no call site — and no deployment mode — can hand the store
 * a different one. That the instance-divided arithmetic still exists in
 * `utils/rate-limit-scope.ts` is reported on `/api/readyz`; it is not a ceiling
 * any of these probes applies, because the only tier that remains in-process may
 * refuse but may not admit.
 *
 * ## Why the advisory tier may refuse but never record
 *
 * While the store answers, a local timestamp is written ONLY after the
 * authoritative store admitted that same attempt, so
 *
 *     local timestamps ⊆ authoritative timestamps
 *
 * and `local count ≥ ceiling ⟹ authoritative count ≥ ceiling ⟹ the store would
 * refuse`. A local refusal is therefore never wrong; it can only be stricter
 * than the store's answer. That is the fail-closed direction and the only
 * direction an advisory cache may operate in: it can never admit an attempt the
 * store would have refused. Because the store also REFUSES when it cannot
 * decide, the subset property now holds unconditionally — there is no longer a
 * path that writes a local timestamp no store confirmed.
 *
 * ## The store's operation rate is bounded by configuration, not by traffic
 *
 * Under a sustained attack on ONE key the first `ceiling` attempts cost one store
 * operation each and every later attempt costs none. A login is not one key but
 * TWO — the account is probed first, the source second — so a sustained attack on
 * a single account+source pair costs `2 × ceiling` authoritative operations
 * (measured: 20, for 500 attempts on one pair), and the bound is per PAIR, not
 * per key. A store fault costs one operation per attempt instead, and each of
 * those is refused rather than admitted.
 *
 * ## The storage model: one document per live scope, and NO global cap
 *
 * The store holds one document per bucket/scope pair, its `_id` is
 * `<bucket>:<hash(scope)>`, and each probe sets `expiresAt = now + windowMs + the
 * 60 s grace` behind a TTL index (`db/migrations.ts`, which is where the constant
 * lives). A document therefore lives for at most one window plus the grace after
 * its LAST write — 16 minutes for the three 15-minute buckets, 61 for the
 * registration hour — and the per-document `ts` array is sliced to `ceiling + 1`
 * on every write, so one document cannot grow with traffic. The collection's size
 * is `document size × distinct scopes simultaneously live`, and nothing else.
 *
 * The scope cardinality is NOT naturally bounded for three of the four buckets,
 * and the account bucket is the only one whose key is a value the deployment owns:
 *
 *   - `login-account` — one per normalized email, and the probe runs BEFORE the
 *     credential lookup, so an attacker supplies any syntactically valid address
 *     and mints a document for an account that does not exist. Bounded by the
 *     number of distinct addresses an attacker cares to submit, not by the user
 *     base.
 *   - `login-source`, `register-source` — one per `CF-Connecting-IP` (a bare
 *     address for the registration bucket, which is why the bucket prefix is part
 *     of the key). The edge overwrites the header, so this cannot be spoofed from
 *     one host — but each distinct source address is one more document.
 *   - `forgot-email-ip` — one per (email, source) pair, so ONE address submitting
 *     distinct addresses to the password-reset route mints one document per pair,
 *     and the ceiling only asks five requests of it.
 *
 * There is deliberately NO global document cap, and the reason is that a cap is
 * itself an attack surface here: a shared ceiling is a single contended quantity
 * an attacker can fill with cheap minted scopes, and every legitimate scope behind
 * it is then refused by a limit that has nothing to do with its own budget — the
 * same fail-open-by-starvation shape the local key cap avoids by refusing rather
 * than evicting. The TTL already bounds the collection by TIME, which is the
 * dimension a flood actually controls; the measured worst case, the Free-tier
 * comparison and the residual exposure are in `docs/architecture.md` §2.7.
 *
 * ## Why the counters are module-level
 *
 * A limiter rebuilt per request would never trip, so the local map must outlive
 * the request-scoped service graph — exactly as the limiters in
 * `auth.service.ts` did before. It is not a DB-backed collaborator: it holds
 * nothing but `Map`s of epoch numbers and key strings and is constructed by
 * `createRateLimiter`, so P-02 (nothing DB-backed at module scope) does not
 * apply. The repository IS request-scoped and is a required constructor
 * parameter, so a mis-wired graph fails in `container.test.ts`.
 */
import { RateLimitCounterRepository, type RateLimitBucket } from '../repositories/rate-limit-counter.repository.js';
import { createRateLimiter, type RateLimitResult, type RateLimiter } from '../utils/rate-limiter.js';
import { logger } from '../utils/logger.js';

// ─── Buckets ──────────────────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;

/** Login, per ACCOUNT: brute force against one victim. */
export const LOGIN_ACCOUNT_MAX_REQUESTS = 10;
export const LOGIN_ACCOUNT_WINDOW_MS = 15 * MINUTE_MS;

/**
 * Login, per SOURCE: the spray of one attempt per address across many
 * addresses, which the per-account ceiling alone never sees. 30 / 15 min
 * tolerates a shared NAT egress — an office signing in together stays under it.
 */
export const LOGIN_SOURCE_MAX_REQUESTS = 30;
export const LOGIN_SOURCE_WINDOW_MS = 15 * MINUTE_MS;

/** Registration, per source: mass account creation. */
export const REGISTER_MAX_REQUESTS = 20;
export const REGISTER_WINDOW_MS = 60 * MINUTE_MS;

/** Password reset, per email+IP: reset-mail flooding against one victim. */
export const FORGOT_PASSWORD_MAX_REQUESTS = 5;
export const FORGOT_PASSWORD_WINDOW_MS = 15 * MINUTE_MS;

/**
 * The back-off reported when the store could not decide at all.
 *
 * REASON: a bounded retry, and neither of the two numbers a genuine refusal
 * could honestly use. The window length is what an over-budget caller is told,
 * and it is a lie here — the authority has no deadline, because it cannot know
 * when the store recovers, so promising 15 minutes would turn a transient
 * counter-only fault into a quarter-hour lockout. Zero is the other lie: it
 * invites a hot retry loop against a store that is already failing. Five seconds
 * is the smallest value that is neither.
 */
export const AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The buckets this service answers for, and the local tier behind each.
 *
 * `limiter` lives here rather than on the service because its counters must
 * survive the request-scoped graph. One limiter per bucket — so two buckets
 * keyed on the same raw value (the login source and the registration source are
 * both a bare address) never share a counter, exactly as the four documents
 * never share a `_id`.
 */
interface BucketDefinition {
  readonly ceiling: number;
  readonly windowMs: number;
  readonly limiter: RateLimiter;
}

const BUCKETS: Readonly<Record<RateLimitBucket, BucketDefinition>> = {
  'login-account': {
    ceiling: LOGIN_ACCOUNT_MAX_REQUESTS,
    windowMs: LOGIN_ACCOUNT_WINDOW_MS,
    limiter: createRateLimiter(LOGIN_ACCOUNT_MAX_REQUESTS, LOGIN_ACCOUNT_WINDOW_MS),
  },
  'login-source': {
    ceiling: LOGIN_SOURCE_MAX_REQUESTS,
    windowMs: LOGIN_SOURCE_WINDOW_MS,
    limiter: createRateLimiter(LOGIN_SOURCE_MAX_REQUESTS, LOGIN_SOURCE_WINDOW_MS),
  },
  'register-source': {
    ceiling: REGISTER_MAX_REQUESTS,
    windowMs: REGISTER_WINDOW_MS,
    limiter: createRateLimiter(REGISTER_MAX_REQUESTS, REGISTER_WINDOW_MS),
  },
  'forgot-email-ip': {
    ceiling: FORGOT_PASSWORD_MAX_REQUESTS,
    windowMs: FORGOT_PASSWORD_WINDOW_MS,
    limiter: createRateLimiter(FORGOT_PASSWORD_MAX_REQUESTS, FORGOT_PASSWORD_WINDOW_MS),
  },
};

// ─── Scope hashing ────────────────────────────────────────────────────────────

/**
 * How much of the SHA-256 digest becomes the counter key, in BITS.
 *
 * 128, i.e. the first 32 hex characters of a 256-bit digest. The hash exists so
 * that a reader of the collection is not handed a plaintext address book; it is
 * not a secret, and truncation does not weaken it against that purpose because a
 * preimage attack is not what it defends. 128 bits leaves a collision space
 * larger than any plausible key count while keeping the `_id` short enough to
 * stay a small index key.
 */
export const RATE_LIMIT_SCOPE_HASH_BITS = 128;

/** Hex characters a {@link RATE_LIMIT_SCOPE_HASH_BITS}-bit digest occupies. */
export const RATE_LIMIT_SCOPE_HASH_HEX_LENGTH = RATE_LIMIT_SCOPE_HASH_BITS / 4;

/**
 * The authoritative document key for one bucket/scope pair.
 *
 * `<bucket>:<truncated sha256(scope)>`. The scope is hashed rather than stored
 * so the collection is not an enumeration oracle for anyone who can read it,
 * and the bucket prefix is part of the KEY (not just of the document) so the
 * four buckets cannot share a document — the registration bucket's scope is a
 * bare address, and without the prefix it would collide with the login source
 * bucket's.
 *
 * Web Crypto (`crypto.subtle`) rather than `node:crypto`, because this module
 * runs inside a Worker.
 */
export async function rateLimitCounterId(bucket: RateLimitBucket, scope: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `${bucket}:${hex.slice(0, RATE_LIMIT_SCOPE_HASH_HEX_LENGTH)}`;
}

// ─── Results ──────────────────────────────────────────────────────────────────

/** Which of the two tiers decided a probe, or that the store could not decide. */
export type RateLimitTier = 'advisory' | 'authoritative' | 'authority_unavailable';

/**
 * A probe's result plus the ceiling the deciding tier measured against.
 *
 * `ceiling` is what the caller must report in `RateLimit-Limit`: the client is
 * being held to the number this service actually applied, which is the bucket's
 * own configured constant in every case — there is no per-instance ceiling left
 * for a caller to be held to instead.
 */
export interface RateLimitProbeResult extends RateLimitResult {
  readonly tier: RateLimitTier;
  readonly ceiling: number;
}

/** What the caller may do with a probed bucket, and which one said so. */
export type LoginBucket = 'account' | 'source';

export type LoginRateLimitDecision =
  | { allowed: true }
  /**
   * `bucket` is the ACCOUNT or the SOURCE, which the caller needs only to pick
   * the message it throws. It is an internal discriminator: nothing derived from
   * it reaches a response body, so a 429 cannot be told apart from the other 429.
   * The ceiling the caller reports comes from `result.ceiling`, which is the one
   * the deciding tier applied.
   */
  | { allowed: false; bucket: LoginBucket; result: RateLimitProbeResult };

export interface LoginRateLimitRequest {
  /** Already normalized (lowercased, trimmed) — the account key is the email. */
  email: string;
  /** The client identifier; `'unknown'` when the edge supplied none. */
  source: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class RateLimitAuthorityService {
  /**
   * REQUIRED, not optional: the whole point of the service is the store, and an
   * `if (this.repo)` guard would turn a mis-wired graph into a per-instance
   * ceiling nobody would notice — or, now that there is no per-instance ceiling
   * to fall back to, into a service that cannot answer at all.
   */
  constructor(private readonly counterRepo: RateLimitCounterRepository) {}

  /** Login, per account. */
  probeLoginAccount(email: string): Promise<RateLimitProbeResult> {
    return this.probe('login-account', email);
  }

  /** Login, per source address. */
  probeLoginSource(source: string): Promise<RateLimitProbeResult> {
    return this.probe('login-source', source);
  }

  /** Registration, per source address. */
  probeRegisterSource(source: string): Promise<RateLimitProbeResult> {
    return this.probe('register-source', source);
  }

  /** Password reset, per email AND source address. */
  probeForgotPassword(email: string, source: string): Promise<RateLimitProbeResult> {
    return this.probe('forgot-email-ip', `${email}:${source}`);
  }

  /**
   * Both login ceilings, with the ACCOUNT decided first.
   *
   * The order is load-bearing rather than incidental: a caller whose account is
   * refused never reaches the source probe — the source bucket's count for an
   * attempt that is already refused is not observable, and skipping it halves
   * what one sustained attack against one account costs the store. It is also
   * sequential by design: an account that cannot be decided ends the request, so
   * no second operation is spent on a caller who is not being admitted.
   */
  async probeLogin(request: LoginRateLimitRequest): Promise<LoginRateLimitDecision> {
    const account = await this.probeLoginAccount(request.email);

    if (account.limited) {
      return { allowed: false, bucket: 'account', result: account };
    }

    const source = await this.probeLoginSource(request.source);

    return source.limited ? { allowed: false, bucket: 'source', result: source } : { allowed: true };
  }

  /**
   * Probe one bucket: advisory refusal, then the authoritative store — returning
   * whichever tier decided, in that order of authority, or refusing when the
   * store could not decide.
   *
   * The ceiling is the bucket's own constant rather than an argument, so no call
   * site can hand the store a number that is not the one the deployment is
   * documented to enforce.
   */
  async probe(bucket: RateLimitBucket, scope: string): Promise<RateLimitProbeResult> {
    const definition = BUCKETS[bucket];
    const authoritative = definition.ceiling;
    const local = definition.limiter.peek(scope);

    // Tier 1 — advisory. `peek` records nothing, so reaching the store below
    // cannot spend an admission the store has not granted.
    //
    // It is compared against the AUTHORITATIVE ceiling: its soundness rests on
    // `local timestamps ⊆ authoritative timestamps`, which only implies a store
    // refusal at the store's own ceiling.
    if (local.count >= authoritative) {
      return {
        limited: true,
        outcome: 'limited',
        remaining: 0,
        retryAfterSeconds: local.retryAfterSeconds,
        tier: 'advisory',
        ceiling: authoritative,
      };
    }

    try {
      const id = await rateLimitCounterId(bucket, scope);
      const probe = await this.counterRepo.probe({
        id,
        bucket,
        windowMs: definition.windowMs,
        ceiling: authoritative,
      });

      // Recorded for BOTH verdicts, because the store appends a refused attempt
      // too: mirroring it is what keeps the subset property true, and what keeps
      // the advisory bound at `ceiling` operations per key while the local record
      // is being rebuilt. A key the local map is already full of is not tracked
      // (the limiter's key cap refuses new keys rather than evicting live ones);
      // the store still counts it, so the ceiling holds either way. The
      // AUTHORITATIVE ceiling is the one it records against, for the same reason
      // the peek above compares against it.
      //
      // The return value is deliberately DISCARDED, `at_capacity` included, and
      // the request continues on the store's verdict above. That is sound in this
      // direction only because this call happens after the store has already
      // answered: a local refusal here could not un-admit an attempt the store
      // admitted, and the store is the tier that may admit at all. The local
      // record is a rebuild accelerator, so the worst a capacity refusal costs
      // here is that this key keeps spending one store operation per attempt
      // until a tracked key's window closes. The mirror direction — treating a
      // local answer as permission to admit — is exactly what the subset property
      // forbids, and it is why the call site is the mirror and never a gate.
      definition.limiter(scope, authoritative);

      if (probe.inWindow > authoritative) {
        return {
          limited: true,
          outcome: 'limited',
          remaining: 0,
          retryAfterSeconds: probe.retryAfterSeconds,
          tier: 'authoritative',
          ceiling: authoritative,
        };
      }

      return {
        limited: false,
        outcome: 'allowed',
        remaining: Math.max(0, authoritative - probe.inWindow),
        retryAfterSeconds: 0,
        tier: 'authoritative',
        ceiling: authoritative,
      };
    } catch (err) {
      // The store could not produce a verdict, so there is no correct answer to
      // give — and never "log and allow". The in-process limiter is consulted
      // above and may REFUSE, but it cannot answer for a global ceiling: it is
      // this instance's count, so using it here would enforce `limit ÷
      // instances` and the caller would be admitted under a ceiling the
      // deployment does not document. Failing closed is the only direction that
      // preserves "the authoritative ceiling does not depend on the instance
      // count", and a refusal is the ordinary, contract-compatible 429 the caller
      // already handles — with `Retry-After`, so the client backs off instead of
      // hammering a store that is already failing.
      //
      // The log names the FAILURE CLASS only. The driver's message can carry the
      // collection, the filter and the document `_id` — which is the hashed scope
      // — and the bucket name says which of the four keys is under attack, so
      // none of it belongs in a log a reader of the deployment may see.
      logger.warn(
        `[rate-limit] the authoritative counter store could not decide this request; ` +
          `the attempt is refused and not admitted (${failureClass(err)})`,
      );

      return {
        limited: true,
        outcome: 'limited',
        remaining: 0,
        retryAfterSeconds: AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS,
        tier: 'authority_unavailable',
        ceiling: authoritative,
      };
    }
  }
}

/**
 * The error's class, for the failure log — never its message.
 *
 * REASON: the message is driver-controlled and routinely embeds the collection,
 * the filter and the document `_id`, and the `_id` of a counter document is the
 * hashed scope — an identity the client must never be able to correlate, least
 * of all in a log that outlives the request. The class is what identifies the
 * fault (timeout, network, server) and carries none of that.
 */
function failureClass(err: unknown): string {
  if (err instanceof Error) {
    return err.name === '' ? 'Error' : err.name;
  }

  return 'non-error';
}
