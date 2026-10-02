/**
 * The counter pipeline, against a REAL MongoDB server.
 *
 * Everything the unit specs assert about this repository is a claim about a
 * document the driver handed back from a stub. The two claims that a stub cannot
 * establish — and that the whole ceiling rests on — are:
 *
 *   1. **Atomicity under concurrency.** `findOneAndUpdate` with an update
 *      pipeline is a single-document operation, so N concurrent probes on one
 *      `_id` cannot admit more than the ceiling. The read-then-write form of the
 *      same arithmetic does (measured at 100 admitted against a ceiling of 10),
 *      which is why the repository issues one operation and never two.
 *   2. **`E11000` on a first-time upsert.** Concurrent probes against a document
 *      that does not exist yet all try to INSERT it, and a loser — if the server
 *      raises one at all, which is a property of the deployment rather than of
 *      the code — gets `E11000`. The retry seam exists for exactly this; it has to
 *      be shown to converge against a server that really does raise the error,
 *      not against a stub that was told to.
 *
 * ## Why this file is skipped by default
 *
 * A unit suite that needs a database is a suite that fails on a machine without
 * one. The whole suite is therefore skipped unless `RATE_LIMIT_COUNTER_TEST_URI`
 * names a cluster; it runs against a scratch DATABASE inside that URI, never the
 * application's own, and drops its collection when it is done.
 *
 * It has a named script at both levels (`npm run test:integration`) so it is
 * reachable by name rather than only by remembering this file's path, and it is
 * deliberately NOT part of `npm run check` or of any workflow: a gate that needs a
 * database breaks on a machine without one. Run it by hand when the counter store
 * or its pipeline changes:
 *
 *     RATE_LIMIT_COUNTER_TEST_URI=mongodb://localhost:27017/taskboard npm run test:integration
 *
 * Without the variable the run is a SKIP, which reads as a pass — check the output
 * says the suite RAN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Collection, type Db } from 'mongodb';
import {
  RATE_LIMIT_COUNTER_TTL_GRACE_MS,
  RateLimitCounterRepository,
  type RateLimitCounterDocument,
} from './rate-limit-counter.repository.js';

const URI = process.env.RATE_LIMIT_COUNTER_TEST_URI;
const WINDOW_MS = 60_000;
const CEILING = 10;
/** Concurrent probes per round — enough for the upsert race to be seen. */
const CONCURRENCY = 60;

describe.skipIf(!URI)('the counter pipeline on a real MongoDB server', () => {
  // Built inside `beforeAll`, not at collection time: `describe.skipIf` still
  // EVALUATES the describe body, so constructing the client here would throw on a
  // machine with no URI — turning "skipped" into "the suite cannot be collected".
  let client: MongoClient;
  let db: Db;
  let collection: Collection<RateLimitCounterDocument>;
  let repo: RateLimitCounterRepository;
  let counter = 0;
  const nextId = (label: string) => `login-account:${label}-${(counter += 1)}`;

  beforeAll(async () => {
    client = new MongoClient(URI as string, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    // A scratch database inside the supplied URI, so a URI that points at a real
    // cluster cannot have this suite touch an application collection.
    db = client.db('taskboard_counter_probe');
    collection = db.collection<RateLimitCounterDocument>('rate_limit_counters');
    // The migration's index, built the same way the migration builds it.
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    repo = new RateLimitCounterRepository(collection);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('executes the pipeline and stores BSON Dates, not epoch numbers', async () => {
    const id = nextId('shape');
    const probe = await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });

    expect(probe).toEqual({ inWindow: 1, retryAfterSeconds: 0 });

    const stored = await collection.findOne({ _id: id });

    // Epoch numbers would force the window arithmetic out of `$$NOW` and into
    // each Worker; dates keep it on the server, where it is solved once.
    expect(stored?.ts).toHaveLength(1);
    expect(stored?.ts[0]).toBeInstanceOf(Date);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    expect(stored?.bucket).toBe('login-account');
  });

  it('refuses at ceiling + 1 and never grows the document past it', async () => {
    const id = nextId('ceiling');

    for (let i = 0; i < CEILING; i += 1) {
      await expect(repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING })).resolves.toEqual(
        {
          inWindow: i + 1,
          retryAfterSeconds: 0,
        },
      );
    }

    const refusal = await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });

    expect(refusal.inWindow).toBe(CEILING + 1);
    expect(refusal.retryAfterSeconds).toBeGreaterThan(0);

    const stored = await collection.findOne({ _id: id });

    // Bounded by the update expression itself: however many refused attempts
    // follow, the document cannot grow.
    expect(stored?.ts.length).toBeLessThanOrEqual(CEILING + 1);
  });

  it('admits exactly `ceiling` of 60 CONCURRENT probes, on an existing document', async () => {
    const id = nextId('concurrent-existing');

    // One probe first, so the round measures atomicity and not the upsert race —
    // that race has its own case below.
    await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });

    const probes = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING }),
      ),
    );
    const admitted = probes.filter((probe) => probe.inWindow <= CEILING).length;

    // One attempt was already recorded above, so `ceiling - 1` here.
    expect(admitted).toBe(CEILING - 1);

    const stored = await collection.findOne({ _id: id });

    expect(stored?.ts.length).toBeLessThanOrEqual(CEILING + 1);
  });

  it('never lets concurrent FIRST-TIME upserts lose a ceiling or raise a 500', async () => {
    const id = nextId('concurrent-upsert');
    // No pre-creation here: every probe races to insert, so a loser that gets
    // E11000 has to be absorbed by the retry. Whether this server ever raises
    // one is its own business — the assertion below is that the ceiling holds and
    // nothing reaches the caller either way, which is the property, not a rate.
    const probes = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING }),
      ),
    );
    const rejected = probes.filter((outcome) => outcome.status === 'rejected');

    expect(rejected.map((outcome) => String((outcome as PromiseRejectedResult).reason))).toEqual([]);

    const admitted = probes
      .filter((outcome) => outcome.status === 'fulfilled')
      .filter((outcome) => outcome.status === 'fulfilled' && outcome.value.inWindow <= CEILING).length;

    expect(admitted).toBeLessThanOrEqual(CEILING);

    const stored = await collection.findOne({ _id: id });

    expect(stored?.ts.length).toBeLessThanOrEqual(CEILING + 1);
  });

  it('DROPS an attempt exactly at the window edge, and keeps one a millisecond younger', async () => {
    // The boundary, decided by the server rather than asserted about the
    // pipeline's shape. A shape check (`$$hit` appears in the update) restates
    // the implementation and cannot tell `$gt` from `$gte`, so the claim is put
    // where it can be falsified: a document whose `ts` is a 1 ms LATTICE
    // straddling the boundary. One of those entries is therefore exactly at
    // `$$NOW - windowMs` by construction — `$$NOW` is an integral millisecond,
    // so a lattice of consecutive milliseconds contains it whatever the round
    // trip costs — and one is a millisecond younger.
    //
    // The boundary itself is then read back out of the post-image rather than
    // guessed: the entry the pipeline appended IS its `$$NOW`.
    const id = nextId('window-edge');
    const span = 400;
    const anchor = Date.now() - WINDOW_MS;
    const seeded = Array.from({ length: 2 * span + 1 }, (_, index) => new Date(anchor - span + index));
    // A ceiling tall enough that `$slice` keeps the whole lattice: this case is
    // about which entries the FILTER drops, not about the bound.
    const ceiling = seeded.length + 1;

    await collection.insertOne({
      _id: id,
      bucket: 'login-account',
      ts: seeded,
      expiresAt: new Date(Date.now() + 10 * WINDOW_MS),
    });

    await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling });

    const stored = await collection.findOne({ _id: id });
    const ts = stored?.ts ?? [];
    const probedAt = ts[ts.length - 1]?.getTime() ?? 0;
    const boundary = probedAt - WINDOW_MS;
    const kept = new Set(ts.map((entry) => entry.getTime()));
    const dropped = seeded.map((entry) => entry.getTime()).filter((ms) => !kept.has(ms));

    // The lattice really did straddle the boundary — otherwise the two cases
    // below would be vacuous, and a vacuous boundary test is the thing this
    // replaces.
    expect(seeded.map((entry) => entry.getTime())).toContain(boundary);
    expect(dropped.length).toBeGreaterThan(0);

    // THE BOUNDARY: an attempt exactly `windowMs` old has left the window …
    expect(kept.has(boundary)).toBe(false);
    // … and one a millisecond younger is still in it.
    expect(kept.has(boundary + 1)).toBe(true);

    // One boundary, not two lucky entries: everything the filter dropped is at
    // or older than it, and everything it kept is younger.
    expect(dropped.every((ms) => ms <= boundary)).toBe(true);
    expect([...kept].filter((ms) => ms !== probedAt).every((ms) => ms > boundary)).toBe(true);
  });

  it('starts a FRESH window for a key after its document has been swept', async () => {
    const id = nextId('ttl');

    for (let i = 0; i < CEILING; i += 1) {
      await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });
    }

    // The TTL sweep is a background task with a coarse cadence, so a test cannot
    // wait for it. What it can do is put the document in the state the sweep
    // leaves behind — gone — because that is the state the next probe observes.
    await collection.deleteOne({ _id: id });

    const afterSweep = await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });

    expect(afterSweep).toEqual({ inWindow: 1, retryAfterSeconds: 0 });
  });

  it('sweeps a document whose expiresAt has passed, using the migration index', async () => {
    // The TTL MONITOR runs about once a minute, so this waits rather than
    // assuming: it is the only assertion that the index really is honoured by
    // the server rather than merely declared. That is why it needs its own
    // timeout — the whole point of it is that it is slow.
    const doomed = nextId('ttl-monitor');

    await collection.insertOne({
      _id: doomed,
      bucket: 'login-account',
      ts: [new Date()],
      expiresAt: new Date(Date.now() - 60_000),
    });

    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      if ((await collection.findOne({ _id: doomed })) === null) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    expect(await collection.findOne({ _id: doomed }), 'the TTL monitor did not sweep the document in 90s').toBeNull();
  }, 120_000);

  it('keeps a document alive for its whole window plus the grace period', async () => {
    const id = nextId('grace');

    await repo.probe({ id, bucket: 'login-account', windowMs: WINDOW_MS, ceiling: CEILING });

    const stored = await collection.findOne({ _id: id });
    const ttlMs = (stored?.expiresAt.getTime() ?? 0) - (stored?.ts[0]?.getTime() ?? 0);

    // Without the grace the sweeper could collect a document while one of its
    // attempts is still inside the window.
    expect(ttlMs).toBe(WINDOW_MS + RATE_LIMIT_COUNTER_TTL_GRACE_MS);
  });
});
