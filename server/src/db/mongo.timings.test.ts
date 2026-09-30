/**
 * Instrumentation of the MongoDB access point.
 *
 * The whole point of instrumenting `getCollection()` (instead of every
 * repository) is that a repository added tomorrow is timed for free. These
 * tests pin that the wrapper is transparent — a proxy that swallowed a
 * driver's return value or changed `this` would be far worse than no timing at
 * all — and that it charges time to the right operations.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Collection, Db, Document } from 'mongodb';
import { getCollection, runWithDb } from './mongo.js';
import { createServerTimings, getServerTimings, runWithServerTimings, type ServerTimings } from '../utils/timings.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for the driver's `Collection`: promise methods + a lazy cursor. */
function createFakeCollection() {
  const cursor = {
    toArray: vi.fn(async () => {
      await delay(5);

      return [{ id: 't1' }];
    }),
    next: vi.fn(async () => null),
  };
  const collection = {
    collectionName: 'tasks',
    findOne: vi.fn(async () => ({ id: 't1' })),
    insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: 'x' })),
    deleteMany: vi.fn(async () => ({ deletedCount: 2 })),
    find: vi.fn(() => cursor),
  };

  return { collection, cursor };
}

function withTimings<T>(fn: (timings: ServerTimings) => Promise<T>): Promise<{ result: T; timings: ServerTimings }> {
  const timings = createServerTimings();

  return runWithServerTimings(timings, async () => ({ result: await fn(timings), timings }));
}

/** `runWithDb` around a fake Db whose only collection is the one under test. */
function inDbContext<T>(collection: object, fn: () => Promise<T>): Promise<T> {
  const db = { collection: () => collection } as unknown as Db;

  return runWithDb(db, fn);
}

describe('getCollection instrumentation (F15)', () => {
  it('times a promise-returning operation', async () => {
    const { collection } = createFakeCollection();
    const { result, timings } = await withTimings(() =>
      inDbContext(collection, async () => {
        const tasks = getCollection<Document>('tasks');

        return tasks.findOne({ id: 't1' });
      }),
    );

    expect(result).toEqual({ id: 't1' });
    expect(timings.dbCount).toBe(1);
    expect(timings.firstDbAt).toBeDefined();
  });

  it('times a lazy cursor only when it is consumed', async () => {
    const { collection, cursor } = createFakeCollection();
    const { result, timings } = await withTimings(() =>
      inDbContext(collection, async () => {
        const tasks = getCollection<Document>('tasks');
        const handle = tasks.find({ id: 't1' });

        // `find()` performs no I/O on its own — the round trip happens in
        // `toArray()`. Charging `find()` would have made `db` meaningless.
        expect(getServerTimings()?.dbCount).toBe(0);

        return handle.toArray();
      }),
    );

    expect(result).toEqual([{ id: 't1' }]);
    expect(timings.dbCount).toBe(1);
    expect(cursor.toArray).toHaveBeenCalledTimes(1);
  });

  it('passes driver properties and non-function values through untouched', async () => {
    const { collection } = createFakeCollection();
    const name = await withTimings(() =>
      inDbContext(collection, async () => getCollection<Document>('tasks').collectionName),
    );

    expect(name.result).toBe('tasks');
  });
  it('returns the raw collection when no request context is active', async () => {
    const { collection } = createFakeCollection();
    const tasks = await inDbContext(collection, async () => getCollection<Document>('tasks'));

    // No `Server-Timings` store outside a request (migrations, CLI scripts):
    // the wrapper must degrade to the plain collection, not a proxy that
    // silently discards a context it never had.
    expect(tasks).toBeInstanceOf(Object);
  });

  it('keeps the driver `this` binding (internal calls bypass the proxy)', async () => {
    const { collection } = createFakeCollection();
    const insertOne = vi.fn(function (this: unknown) {
      return Promise.resolve({ self: this });
    });
    const instrumented = { ...collection, insertOne } as unknown as Collection<Document>;
    const result = await withTimings(() =>
      inDbContext(instrumented, async () => {
        const tasks = getCollection<Document>('tasks');

        return (await tasks.insertOne({})) as unknown as { self: unknown };
      }),
    );

    expect(result.result.self).toBe(instrumented);
  });
});
