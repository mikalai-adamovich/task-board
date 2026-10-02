import type { Collection, Document } from 'mongodb';
import { withRetryOnDuplicate } from '../db/duplicate-key.js';
import { QUERY_MAX_TIME_MS_COUNTER } from '../db/query-timeout.js';

// guardrail:no-base-repository 2026-10-02 — counter documents are keyed by the
// Mongo `_id` (a bucket prefix plus a hash), not by an `id` field, and the only
// operation is one atomic `findOneAndUpdate` whose post-image IS the verdict.
// `BaseRepository` addresses documents by `id` and exposes a hard `delete(id)`
// that would let any caller retire a live budget; neither has a meaning here.
// See `rules/guardrails.guardrail.test.ts` (P-03).

// ─── Document Shape ───────────────────────────────────────────────────────────

/**
 * The closed set of counters sharing one collection.
 *
 * The prefix is part of the document `_id` and is therefore MANDATORY, not
 * decoration: the registration bucket keys on a BARE client address while the
 * login buckets key on `account:<email>` / `source:<ip>`, so in a shared
 * collection those namespaces would meet — one address's registration budget
 * would silently become part of its login budget.
 */
export type RateLimitBucket = 'login-account' | 'login-source' | 'register-source' | 'forgot-email-ip';

export interface RateLimitCounterDocument {
  /** `<bucket>:<hex hash of the scope>` — see {@link RateLimitBucket}. */
  _id: string;
  bucket: RateLimitBucket;
  /**
   * Attempt timestamps inside the sliding window, ascending.
   *
   * BSON Dates, NOT epoch numbers: the update pipeline composes `$$NOW` with
   * `$dateSubtract` / `$dateAdd`, and those operators only accept dates. Epoch
   * numbers would force `$$NOW` out of the pipeline and put the window
   * arithmetic in the Worker, where two instances would each apply their own
   * clock.
   */
  ts: Date[];
  /** When the TTL sweep may retire the document; see the TTL index. */
  expiresAt: Date;
}

/** The post-image of one probe, and the whole of it. */
export interface RateLimitCounterProbe {
  /**
   * Attempts the window holds AFTER this probe.
   *
   * Capped at `ceiling + 1`: a refused attempt is still appended (that is what
   * makes the verdict derivable from one round trip) and the oldest entry is
   * sliced off, so the steady state while a key is over budget is exactly
   * `ceiling + 1`. Admission is therefore `inWindow <= ceiling`.
   */
  inWindow: number;
  /** Seconds until the OLDEST in-window attempt expires; 0 when admitted. */
  retryAfterSeconds: number;
}

export interface RateLimitCounterProbeRequest {
  /** The full document `_id`, bucket prefix included. */
  id: string;
  bucket: RateLimitBucket;
  windowMs: number;
  ceiling: number;
}

/**
 * How long past the window a counter document is kept.
 *
 * The TTL sweep is a BACKGROUND task with a coarse cadence (~60 s nominally),
 * so a document that expires exactly at the window edge can be collected while
 * one of its entries is still counted. The verdict never reads an expired
 * entry — the `$filter` drops it on the next probe — so the grace period costs
 * nothing but keeps the document readable for its whole useful life.
 */
export const RATE_LIMIT_COUNTER_TTL_GRACE_MS = 60_000;

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * The AUTHORITATIVE sliding-window counter behind the four authentication
 * buckets.
 *
 * ## What one probe costs in storage: one small document, for one window
 *
 * The collection holds one document per bucket/scope pair and nothing else — no
 * per-attempt rows, no history. The document's only unbounded-looking field is
 * `ts`, and the pipeline slices it to `-(ceiling + 1)` on every write, so it is
 * capped at 31 BSON Dates at worst (the login-source bucket, the largest ceiling)
 * whatever a caller sends. `expiresAt` is recomputed on every probe to
 * `now + windowMs + grace`, so a document is retired by the TTL index shortly
 * after its last write and the live set is whatever was probed inside the current
 * window. The collection's size is therefore `document size × distinct scopes
 * currently live` — measured at 124-475 B per document, so roughly a million
 * documents to reach half a gigabyte — and NOT the `maxKeys` of the in-process
 * advisory limiter, which is a different quantity in a different tier
 * (`utils/rate-limiter.ts`). The full calculation is in `docs/architecture.md`
 * §2.7.
 *
 * One probe is ONE atomic `findOneAndUpdate` with an update pipeline, `upsert:
 * true` and `returnDocument: 'after'`. There is deliberately no read-then-write
 * form: MongoDB's atomicity guarantee is per DOCUMENT, so a read followed by an
 * update loses every increment a concurrent caller made in between — measured
 * at 100 admitted against a ceiling of 10 where the atomic form admits 10. And
 * there is no second read: `returnDocument: 'after'` returns the post-image, so
 * the verdict, `remaining` and `retryAfterSeconds` all come out of the round
 * trip that recorded the attempt.
 */
export class RateLimitCounterRepository {
  constructor(private readonly collection: Collection<RateLimitCounterDocument>) {}

  /**
   * Record one attempt for `id` and report the window as it now stands.
   *
   * `$$NOW` is the SERVER's clock, evaluated once for the whole pipeline, so
   * every instance sliding the same window uses one reading — the wall-clock
   * skew that `createRateLimiter` compensates for locally is solved here, once,
   * centrally.
   *
   * The `$gt` boundary matches `createRateLimiter`'s `now - ts < windowMs`: an
   * attempt exactly `windowMs` old has LEFT the window.
   */
  async probe(request: RateLimitCounterProbeRequest): Promise<RateLimitCounterProbe> {
    const { id, bucket, windowMs, ceiling } = request;
    const updated = await withRetryOnDuplicate(() =>
      this.collection.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              bucket,
              // `$ifNull` covers the upsert path, where the document does not
              // exist yet and therefore has no `ts` at all.
              ts: {
                $slice: [
                  {
                    $concatArrays: [
                      {
                        $filter: {
                          input: { $ifNull: ['$ts', []] },
                          as: 'hit',
                          cond: {
                            $gt: [
                              '$$hit',
                              { $dateSubtract: { startDate: '$$NOW', unit: 'millisecond', amount: windowMs } },
                            ],
                          },
                        },
                      },
                      ['$$NOW'],
                    ],
                  },
                  // Negative bound = keep the LAST `ceiling + 1`. The document
                  // therefore cannot grow whatever a caller sends, and the extra
                  // slot is what distinguishes "this attempt pushed the window
                  // to the ceiling" (admitted) from "the window was already
                  // full" (refused) in one round trip.
                  -(ceiling + 1),
                ],
              },
              expiresAt: {
                $dateAdd: {
                  startDate: '$$NOW',
                  unit: 'millisecond',
                  amount: windowMs + RATE_LIMIT_COUNTER_TTL_GRACE_MS,
                },
              },
            },
          },
        ] as Document[],
        { upsert: true, returnDocument: 'after', maxTimeMS: QUERY_MAX_TIME_MS_COUNTER },
      ),
    );
    // `upsert: true` + `returnDocument: 'after'` always yields the document; the
    // null branch is a concurrent removal of the same key, which resolves to the
    // same verdict a fresh window would: nothing is counted against this caller.
    const inWindow = updated?.ts?.length ?? 0;

    if (inWindow > ceiling) {
      return { inWindow, retryAfterSeconds: retryAfterSeconds(updated?.ts ?? [], windowMs) };
    }

    return { inWindow, retryAfterSeconds: 0 };
  }
}

/**
 * Seconds until the OLDEST attempt in `ts` leaves the window — the same number
 * `createRateLimiter` derives, so `buildRateLimitHeaders` reports an identical
 * back-off whichever tier decided.
 *
 * `ts` holds the SERVER's clock and the arithmetic runs on the Worker's, so the
 * two readings can disagree by the usual NTP drift. Both ends are therefore
 * clamped to the window: at 1 s, because a client that retries immediately is
 * refused for the same reason ("retry now" is never the honest answer), and at
 * `windowMs`, because a skew reading a back-off LONGER than the window is the
 * point at which the caller stops trusting the header and starts hammering.
 */
function retryAfterSeconds(ts: Date[], windowMs: number): number {
  const oldest = ts[0];

  if (oldest === undefined) {
    return 1;
  }

  const seconds = Math.ceil((oldest.getTime() + windowMs - Date.now()) / 1000);

  return Math.min(Math.max(1, seconds), Math.ceil(windowMs / 1000));
}
