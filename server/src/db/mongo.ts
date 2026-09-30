import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientSession, Collection, Db, Document, MongoClient } from 'mongodb';
import { getServerTimings, trackDbCall, trackDbValue } from '../utils/timings.js';

/**
 * MongoDB client lifecycle for Cloudflare Workers.
 *
 * The `MongoClient` is cached per isolate (singleton) and shared across
 * requests: the driver's connection pool amortises the expensive handshake
 * (DNS-over-HTTPS SRV/TXT, TCP, TLS, SCRAM auth, topology discovery —
 * ~300 ms when paid per request) over the isolate lifetime. This is an
 * EXPERIMENT guarded by `DB_CLIENT_MODE`:
 *
 * - 'singleton' (default) — one client per isolate, reused across requests.
 *   workerd historically tied sockets to the request context that created
 *   them (workerd#2721: "Cannot perform I/O on behalf of a different
 *   request"); newer runtimes reportedly tolerate module-cached clients.
 *   When such an I/O-context error surfaces, the middleware resets the cache
 *   (see `resetSharedClient`) and the next request builds a fresh client.
 * - 'per-request' — the previous behaviour: a fresh client per request,
 *   closed after the response. Rollback switch, changeable via `--var`
 *   without a code deploy.
 *
 * `AsyncLocalStorage` still makes the per-request `Db` instance available to
 * all downstream code (`getDb()`, `getCollection()`) without threading it
 * through every function parameter.
 */
const dbStorage = new AsyncLocalStorage<Db>();

/** Client lifecycle mode — see module docstring. */
export type MongoClientMode = 'singleton' | 'per-request';

// ── TEMPORARY perf instrumentation (remove after the singleton experiment) ──

/**
 * Detect workerd I/O-context failures — signals that the cached client's
 * sockets were created in a request context that has since ended, so the
 * client must be discarded and rebuilt. Deliberately NARROW: ordinary
 * MongoDB/network errors must NOT reset the pool (the driver recovers from
 * those itself).
 */
export function isIoContextError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);

  return (
    message.includes('Cannot perform I/O on behalf of a different request') ||
    message.includes('hanging Promise was canceled')
  );
}

let sharedClientPromise: Promise<MongoClient> | undefined;

/** Drop the cached client; the next request builds a fresh one. */
export function resetSharedClient(): void {
  sharedClientPromise = undefined;
}

async function createConnectedClient(uri: string): Promise<MongoClient> {
  // Dynamic import required — MongoDB's BSON module calls crypto.randomBytes()
  // at module load time, which Cloudflare Workers forbids at global scope.
  const { MongoClient: MC } = await import('mongodb');
  // Do NOT set a non-default `connectTimeoutMS` here, and do not credit it with
  // an effect it does not have. What driver 7.6.0 actually does
  // (`node_modules/mongodb/lib/cmap/connect.js`):
  //   :303  socket.setTimeout(connectTimeoutMS)   — while ESTABLISHING;
  //   :337  socket.setTimeout(0)                  — in the `finally`, i.e. the
  //                                               timeout is REMOVED the moment
  //                                               the connection is up.
  // So it is a connection-ESTABLISHMENT timeout that the driver then clears, not
  // an idle-socket timeout: it cannot kill a pooled connection that is already
  // established. The earlier claim in this file (and in `AGENTS.md`) that the
  // non-default 5_000 value "was the root cause of the periodic latency spikes"
  // is REFUTED by that source and has been removed — the mitigation below is
  // kept on its own merits, not as a fix for an incident it did not cause.
  // Whether the periodic spikes are still unexplained: see
  // `product-analysis/100-performance-optimizations.md` and the two open items
  // in `AGENTS.md` §Performance forensics.
  const client = new MC(uri, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 5_000,
  });

  await client.connect();
  return client;
}

/**
 * Return the MongoDB client to use for a request.
 *
 * 'singleton' mode caches the connect promise at module level, so concurrent
 * requests all await the SAME `connect()` — no duplicate clients can be
 * created. A failed connect clears the cache so the next request retries
 * instead of awaiting a poisoned (rejected) promise forever.
 */
export async function getMongoClient(uri: string, mode: MongoClientMode = 'singleton'): Promise<MongoClient> {
  // Acquiring the client IS a database access — a cold connect costs
  // hundreds of milliseconds, and on a warm pool the awaited cached promise
  // costs ~0. That difference is the single most useful number for the
  // unexplained pre-DB stall, so it is measured here rather than
  // in the DB middleware of `app.ts`.
  return trackDbCall(() => resolveMongoClient(uri, mode));
}

async function resolveMongoClient(uri: string, mode: MongoClientMode): Promise<MongoClient> {
  if (mode === 'per-request') {
    return createConnectedClient(uri);
  }

  sharedClientPromise ??= createConnectedClient(uri).catch((err: unknown) => {
    sharedClientPromise = undefined;
    throw err;
  });
  return sharedClientPromise;
}

/**
 * Create a FRESH client + Db handle and return both. Used only by the
 * readiness probe, whose job is to verify that a brand-new connection works.
 * The caller is responsible for closing the client.
 */
export async function connectMongo(uri: string): Promise<{ client: MongoClient; db: Db }> {
  const client = await createConnectedClient(uri);

  return { client, db: client.db() };
}

/**
 * Run a function within a per-request MongoDB context.
 *
 * Call this from the middleware so that `getDb()` / `getCollection()` resolve
 * to the correct `Db` instance for the current request, even when multiple
 * requests are in flight concurrently.
 */
export function runWithDb<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  return dbStorage.run(db, fn);
}

/**
 * Get the active MongoDB database instance for the current request.
 * Throws if called outside a `runWithDb()` context.
 */
export function getDb(): Db {
  const db = dbStorage.getStore();

  if (!db) {
    throw new Error('MongoDB not connected. Ensure the MongoDB middleware is active.');
  }
  return db;
}

/**
 * Get a typed MongoDB collection from the current request's database.
 * This is the primary way to access collections throughout the application.
 *
 * @param name - The collection name
 * @returns A typed Collection reference
 *
 * @example
 * ```ts
 * const users = getCollection<UserDocument>('users');
 * const user = await users.findOne({ email: 'test@example.com' });
 * ```
 */
export function getCollection<T extends Document>(name: string): Collection<T> {
  return timedCollection(getDb().collection<T>(name));
}

/**
 * Wrap a collection so that every operation issued through it is measured
 * for the `Server-Timings` header.
 *
 * This is the ONLY place repositories are instrumented — no per-repository
 * opt-in, so a repository added tomorrow is timed automatically and the 20
 * existing ones did not have to be touched. The wrapper is a transparent proxy:
 * non-function properties (and symbol-keyed driver internals) are passed
 * through, and methods are invoked with the RAW collection as `this` so the
 * driver's own internal property access can never re-enter the proxy.
 *
 * Outside a request (migrations, CLI scripts, unit tests) there is no timings
 * store and the wrapper short-circuits to the plain collection.
 */
function timedCollection<T extends Document>(collection: Collection<T>): Collection<T> {
  const timings = getServerTimings();

  if (!timings) {
    return collection;
  }

  return new Proxy(collection, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);

      if (typeof prop === 'symbol' || typeof value !== 'function') {
        return value;
      }

      const method = value as (...args: unknown[]) => unknown;

      return (...args: unknown[]) => trackDbValue(() => method.apply(target, args), timings);
    },
  });
}

// ─── Transactions ────────────────────────────────────────────────────────────

/**
 * Thrown when the connected MongoDB topology does not support multi-document
 * transactions (e.g. a standalone `mongod` without a replica set).
 *
 * Callers may catch this to fall back to a non-transactional code path —
 * see {@link withTransaction} and `ProjectService.createProject`.
 */
export class TransactionsUnsupportedError extends Error {
  constructor(message = 'This MongoDB deployment does not support transactions', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransactionsUnsupportedError';
  }
}

/**
 * Minimal view of the driver-internal topology surface used by
 * {@link topologySupportsTransactions}. `client.topology` is not part of the
 * public `MongoClient` type in driver 7.x, so the introspection shape is
 * declared explicitly here; every field is optional and the check degrades to
 * `true` (see below) if the driver removes or reshapes it.
 */
interface TopologyIntrospection {
  topology?: { description?: { type?: string } };
}

/**
 * Best-effort topology check using the driver's public-ish surface.
 *
 * Transactions require a replica set (`ReplicaSetWithPrimary` /
 * `ReplicaSetNoPrimary`), sharded cluster (`Sharded`) or load balancer
 * (`LoadBalanced`). A `Single`/`Standalone`/`Unknown` topology cannot run
 * them. If the topology description is not reachable we return `true` and
 * rely on the runtime error detection in {@link isTransactionsUnsupportedError}
 * instead of blocking a potentially capable deployment.
 */
function topologySupportsTransactions(client: MongoClient): boolean {
  const topologyType = (client as TopologyIntrospection).topology?.description?.type;

  if (!topologyType) {
    return true;
  }

  return /ReplicaSet|Sharded|LoadBalanced/.test(topologyType);
}

/**
 * Detect the driver/server errors raised when a transaction is attempted
 * against a topology that does not support it. Known messages:
 * - "Transaction numbers are only allowed on a replica set member or mongos"
 * - "This MongoDB deployment does not support sessions/transactions" variants
 */
export function isTransactionsUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);

  return (
    /transaction/i.test(message) &&
    /(not supported|only allowed on a replica set|replica set member|mongos)/i.test(message)
  );
}

/**
 * Run `fn` inside a MongoDB multi-document transaction on the current
 * request's client. The session is committed automatically by the
 * driver's `withTransaction` retry wrapper; any error thrown by `fn` aborts
 * the transaction so **nothing becomes visible** (atomic project seed).
 *
 * Must be called within a `runWithDb()` context — the underlying
 * `MongoClient` is taken from the request-scoped `Db`.
 *
 * @throws {@link TransactionsUnsupportedError} if the topology cannot run
 *   transactions (checked up-front via topology description, or detected at
 *   runtime from driver errors). Callers decide whether to fall back.
 *
 * @example
 * ```ts
 * await withTransaction(async (session) => {
 *   await collection.insertOne(doc, { session });
 * });
 * ```
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const db = getDb();
  const client = db.client;

  if (!topologySupportsTransactions(client)) {
    throw new TransactionsUnsupportedError();
  }

  const session = client.startSession();

  try {
    let result!: T;

    await session.withTransaction(async () => {
      result = await fn(session);
    });

    return result;
  } catch (err) {
    // Some drivers/servers only surface the unsupported-topology condition
    // when the first command actually runs — normalize it for callers.
    if (isTransactionsUnsupportedError(err)) {
      throw new TransactionsUnsupportedError(undefined, { cause: err });
    }

    throw err;
  } finally {
    await session.endSession().catch(() => {
      /* swallow — socket may already be dead */
    });
  }
}
