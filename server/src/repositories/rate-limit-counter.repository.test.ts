/**
 * The counter repository, against a recording collection double.
 *
 * What a unit test CAN establish about the pipeline: its shape (one atomic
 * `findOneAndUpdate`, an update PIPELINE, `upsert`, `returnDocument: 'after'`,
 * the server-side `$$NOW`), the arithmetic of the verdict derived from the
 * post-image, and that a lost insert race is retried instead of surfacing as a
 * 500. What it cannot establish is that MongoDB executes it — that is
 * `rate-limit-counter.repository.integration.test.ts`, which runs the same class
 * against a real cluster when `RATE_LIMIT_COUNTER_TEST_URI` names one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Collection } from 'mongodb';
import {
  RATE_LIMIT_COUNTER_TTL_GRACE_MS,
  RateLimitCounterRepository,
  type RateLimitCounterDocument,
} from './rate-limit-counter.repository.js';
import { DUPLICATE_KEY_CODE } from '../db/duplicate-key.js';
import { QUERY_MAX_TIME_MS_COUNTER } from '../db/query-timeout.js';

const WINDOW_MS = 15 * 60 * 1000;
const CEILING = 10;

/** A collection double that records every call and answers with `document`. */
function recordingCollection(document: Partial<RateLimitCounterDocument> | null) {
  const findOneAndUpdate = vi.fn().mockResolvedValue(document);

  return {
    findOneAndUpdate,
    collection: {
      findOneAndUpdate,
      findOne: vi.fn(),
      find: vi.fn(),
    } as unknown as Collection<RateLimitCounterDocument>,
  };
}

function repositoryOver(document: Partial<RateLimitCounterDocument> | null): {
  repo: RateLimitCounterRepository;
  findOneAndUpdate: ReturnType<typeof vi.fn>;
} {
  const { collection, findOneAndUpdate } = recordingCollection(document);

  return { repo: new RateLimitCounterRepository(collection), findOneAndUpdate };
}

function postImage(length: number, ageMs = 0): Partial<RateLimitCounterDocument> {
  return {
    ts: Array.from({ length }, (_, index) => new Date(Date.now() - ageMs + index)),
  };
}

const request = { id: 'login-account:abc123', bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING } as const;

describe('one probe is ONE atomic operation', () => {
  it('issues a single findOneAndUpdate with a pipeline update, upsert and the post-image', async () => {
    const { repo, findOneAndUpdate } = repositoryOver(postImage(1));

    await repo.probe(request);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);

    const [filter, update, options] = findOneAndUpdate.mock.calls[0] ?? [];

    expect(filter).toEqual({ _id: 'login-account:abc123' });
    // An array is an update PIPELINE; a plain object would be a modifier update
    // and could not express "keep the in-window attempts AND append one" without
    // a read.
    expect(Array.isArray(update)).toBe(true);
    expect(options).toMatchObject({ upsert: true, returnDocument: 'after' });
    // A zero would mean "no limit" to the server, so the budget is passed as a
    // named constant rather than inline.
    expect(options.maxTimeMS).toBe(QUERY_MAX_TIME_MS_COUNTER);
    expect(options.maxTimeMS).toBeGreaterThan(0);
  });

  it('reads nothing — the verdict comes out of the same round trip', async () => {
    const { repo, findOneAndUpdate } = repositoryOver(postImage(1));

    await repo.probe(request);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    // Any read-then-write form is the race the atomic update exists to remove:
    // every concurrent caller would see the pre-image and decide "under
    // ceiling" at the same time.
    expect(findOneAndUpdate.mock.calls[0]?.length).toBe(3);
  });

  it('builds a window filter, a bounded slice and an expiry from the SERVER clock', async () => {
    const { repo, findOneAndUpdate } = repositoryOver(postImage(1));

    await repo.probe(request);

    const update = (findOneAndUpdate.mock.calls[0]?.[1] ?? []) as Record<string, Record<string, unknown>>[];
    const stage = update[0]?.['$set'] ?? {};
    const ts = (stage['ts'] ?? {}) as Record<string, unknown>;
    const expiresAt = (stage['expiresAt'] ?? {}) as Record<string, Record<string, unknown>>;

    // `$$NOW` is the server's clock, so every instance sliding this window uses
    // one reading rather than its own.
    expect(JSON.stringify(update)).toContain('$$NOW');
    // `ceiling + 1`, negative bound = keep the newest N. The extra slot is what
    // makes "admitted" and "refused" distinguishable in one round trip.
    expect(JSON.stringify(ts)).toContain(String(-(CEILING + 1)));
    expect(JSON.stringify(ts)).toContain('$$hit');
    expect(expiresAt['$dateAdd']).toMatchObject({
      unit: 'millisecond',
      amount: WINDOW_MS + RATE_LIMIT_COUNTER_TTL_GRACE_MS,
    });
  });
});

describe('the verdict, derived from the post-image', () => {
  it('admits while the window holds at most `ceiling` attempts', async () => {
    const { repo } = repositoryOver(postImage(CEILING));

    await expect(repo.probe(request)).resolves.toEqual({ inWindow: CEILING, retryAfterSeconds: 0 });
  });

  it('refuses at `ceiling + 1` and reports a back-off from the OLDEST attempt', async () => {
    // Seeded one minute into the past, so the reported back-off is the window
    // minus that minute rather than the window itself.
    const { repo } = repositoryOver(postImage(CEILING + 1, 60_000));
    const probe = await repo.probe(request);

    expect(probe.inWindow).toBe(CEILING + 1);
    // The oldest entry is the first to fall out of the window, and the answer is
    // clamped to the window at both ends — the two clocks (the server's inside
    // `ts`, the Worker's here) can disagree, and a back-off longer than the
    // window is the reading a client would stop trusting.
    expect(probe.retryAfterSeconds).toBeGreaterThan(0);
    expect(probe.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000));
  });

  it('never tells a caller to wait longer than the window itself', async () => {
    // A `ts` entry ahead of the Worker's clock — a server ahead by more than the
    // window — must still yield a back-off inside the window.
    const { repo } = repositoryOver({
      ts: Array.from({ length: CEILING + 1 }, () => new Date(Date.now() + 10 * WINDOW_MS)),
    });
    const probe = await repo.probe(request);

    expect(probe.retryAfterSeconds).toBe(Math.ceil(WINDOW_MS / 1000));
  });
  it('a vanished document counts as an empty window rather than an error', async () => {
    // `upsert: true` always returns the document; null means a concurrent
    // removal of the same key, which resolves exactly like a fresh window —
    // nothing is counted against this caller.
    const { repo } = repositoryOver(null);

    await expect(repo.probe(request)).resolves.toEqual({ inWindow: 0, retryAfterSeconds: 0 });
  });
});

describe('E11000 on a concurrent first-time upsert', () => {
  const duplicateKey = Object.assign(new Error('Plan executor error during findAndModify :: E11000 duplicate key'), {
    code: DUPLICATE_KEY_CODE,
    codeName: 'DuplicateKey',
  });

  it('retries once and returns the winner document instead of throwing', async () => {
    const { collection, findOneAndUpdate } = recordingCollection(postImage(1));

    findOneAndUpdate.mockRejectedValueOnce(duplicateKey).mockResolvedValueOnce(postImage(2));

    const probe = await new RateLimitCounterRepository(collection).probe(request);

    expect(probe.inWindow).toBe(2);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    // The same operation both times — the retry finds the document the winner
    // inserted rather than issuing a second, different write.
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toEqual(findOneAndUpdate.mock.calls[1]?.[0]);
  });

  it('propagates a SECOND duplicate key instead of looping', async () => {
    const { collection, findOneAndUpdate } = recordingCollection(postImage(1));

    findOneAndUpdate.mockRejectedValue(duplicateKey);

    await expect(new RateLimitCounterRepository(collection).probe(request)).rejects.toThrow(/E11000/);
    // An unbounded retry on the unauthenticated login path would turn a storage
    // anomaly into a hot loop.
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrelated failure', async () => {
    const { collection, findOneAndUpdate } = recordingCollection(postImage(1));

    findOneAndUpdate.mockRejectedValue(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));

    await expect(new RateLimitCounterRepository(collection).probe(request)).rejects.toThrow(/time limit/);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
