/**
 * `AuditEventRepository` — the LIST contract, not the shape of it.
 *
 * The property under test: the order the repository pages with
 * `.skip()/.limit()` must be a TOTAL order. `createdAt` is a wall-clock
 * millisecond, so two events written in the same millisecond share it, and a
 * sort over a non-unique key lets the database return a tied group in a
 * different order on each query — the same event then appears on two pages, or
 * on none. `_id` is the one field MongoDB guarantees unique, so it is the
 * tiebreaker, and a total order makes skip/limit paging exact.
 *
 * The fake collection below models the two database behaviours this depends on
 * and no others: `insertMany` assigns an increasing `_id` to each document (an
 * ObjectId is timestamp + counter, so it increases in insertion order), and a
 * sort whose key does not separate two documents leaves their order to the
 * server — which is what `tiesIn()` measures.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { AuditEventRepository, type AuditEventDocument } from './audit-event.repository.js';

type Doc = Record<string, unknown>;
type SortSpec = Record<string, 1 | -1>;

/** A document as the fake stores it: the repository's shape plus an `_id`. */
type Stored = AuditEventDocument & { _id: ObjectId };

/**
 * A comparator derived from a sort spec, exactly as the database would apply
 * it: keys in order, each one able to break the previous one's tie. Returning
 * 0 means the spec does NOT order the two documents.
 */
function comparatorFor(spec: SortSpec): (a: Doc, b: Doc) => number {
  return (a, b) => {
    for (const [field, direction] of Object.entries(spec)) {
      const left = a[field];
      const right = b[field];

      if (left === undefined) return 1;
      if (right === undefined) return -1;
      // Two `Date`s for the same instant are NOT `===` in JavaScript, so the
      // wall-clock field must be compared by TIME — otherwise this fake would
      // report two events in the same millisecond as ordered and the guardrail
      // could never fire.
      if (left instanceof Date && right instanceof Date) {
        if (left.getTime() === right.getTime()) continue;

        return (left.getTime() < right.getTime() ? -1 : 1) * direction;
      }
      if (left === right) continue;

      return (String(left) < String(right) ? -1 : 1) * direction;
    }

    return 0;
  };
}

interface FakeCollection {
  collection: Record<string, ReturnType<typeof vi.fn>>;
  /** The sort spec the repository issued on the last `find()`. */
  lastSort: () => SortSpec | null;
  /** The documents `insertMany` actually stored, with their assigned `_id`. */
  stored: () => Stored[];
  /** How many pairs of documents the issued sort does NOT order. */
  tiesIn: () => number;
  /** One page, applied the way the database would. */
  page: (docs: Doc[], offset: number, take: number) => Doc[];
}

function fakeCollection(): FakeCollection {
  const state = { sort: null as SortSpec | null, docs: [] as Stored[] };
  let counter = 0;
  /** Equality on every query key, following dotted paths the way MongoDB does. */
  const matches = (doc: unknown, query: Doc): boolean => {
    const fields = doc as Doc;

    return Object.entries(query).every(([path, value]) => {
      let value_: unknown = fields;

      for (const segment of path.split('.')) value_ = (value_ as Doc | undefined)?.[segment];

      return value_ === value;
    });
  };
  // A 24-char hex id that increases with the counter — the ordering guarantee
  // an ObjectId gives (timestamp + per-process counter).
  const assignId = (doc: AuditEventDocument): Stored => {
    const id = new ObjectId(counter.toString(16).padStart(24, '0'));

    counter += 1;

    return { _id: id, ...doc };
  };
  const page = (docs: Doc[], offset: number, take: number): Doc[] => {
    const compare = comparatorFor(state.sort ?? {});

    return [...docs].sort(compare).slice(offset, offset + take);
  };
  const find = vi.fn((query: Doc) => {
    let offset = 0;
    let take = Infinity;
    const cursor = {
      sort(spec: SortSpec) {
        state.sort = spec;

        return cursor;
      },
      skip(n: number) {
        offset = n;

        return cursor;
      },
      limit(n: number) {
        take = n;

        return cursor;
      },
      async toArray() {
        return page(state.docs.filter((doc) => matches(doc, query)) as unknown as Doc[], offset, take);
      },
    };

    return cursor;
  });

  return {
    collection: {
      find,
      findOne: vi.fn((query: Doc) => Promise.resolve(state.docs.find((doc) => matches(doc, query)) ?? null)),
      countDocuments: vi.fn((query: Doc) => Promise.resolve(state.docs.filter((doc) => matches(doc, query)).length)),
      insertOne: vi.fn((doc: AuditEventDocument) => {
        state.docs.push(assignId(doc));

        return Promise.resolve({ acknowledged: true });
      }),
      insertMany: vi.fn((docs: AuditEventDocument[]) => {
        for (const doc of docs) state.docs.push(assignId(doc));

        return Promise.resolve({ acknowledged: true });
      }),
      deleteMany: vi.fn(() => Promise.resolve({ deletedCount: 0 })),
    },
    lastSort: () => state.sort,
    stored: () => state.docs,
    tiesIn: () => {
      const compare = comparatorFor(state.sort ?? {});
      let ties = 0;

      for (let i = 0; i < state.docs.length; i += 1) {
        for (let j = i + 1; j < state.docs.length; j += 1) {
          if (compare(state.docs[i] as unknown as Doc, state.docs[j] as unknown as Doc) === 0) ties += 1;
        }
      }

      return ties;
    },
    page,
  };
}

function eventDoc(overrides: Partial<AuditEventDocument> = {}): AuditEventDocument {
  return {
    id: 'e-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    entityType: 'TASK',
    entityId: 'task-1',
    action: 'UPDATED',
    actor: { userId: 'user-1', displayName: 'A' },
    changes: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function repository(): { repo: AuditEventRepository; fake: FakeCollection } {
  const fake = fakeCollection();

  return { repo: new AuditEventRepository(fake.collection as never), fake };
}

/** `logMany`'s pre-fix behaviour: the whole batch shares one millisecond. */
async function sameMillisecondBatch(repo: AuditEventRepository, count: number): Promise<void> {
  const same = new Date('2026-01-01T00:00:00.000Z');

  await repo.createMany(Array.from({ length: count }, (_unused, i) => eventDoc({ id: `e-${i}`, createdAt: same })));
}

describe('AuditEventRepository — the list order is total (D-11)', () => {
  it('D-11: the issued sort separates documents that share a createdAt', async () => {
    const { repo, fake } = repository();

    await sameMillisecondBatch(repo, 5);
    await repo.findByProject('project-1', { limit: 20 });

    expect(fake.stored()).toHaveLength(5);
    expect(fake.tiesIn(), 'the sort left two events unordered — the database may return them in any order').toBe(0);
  });

  it('D-11: every event of a same-millisecond batch is reachable exactly once across the pages', async () => {
    const { repo, fake } = repository();

    await sameMillisecondBatch(repo, 5);

    // Page through with the real repository — the tie would make a page's
    // contents depend on the server's mood, not on the data.
    const seen: string[] = [];

    for (const page of [1, 2, 3]) {
      const result = await repo.findByProject('project-1', { page, limit: 2 });

      seen.push(...result.data.map((event) => event.id));
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size, 'an event was returned on more than one page').toBe(5);
    expect(fake.lastSort()).not.toBeNull();
  });

  it('the sort direction flips with the requested order, on every key', async () => {
    const { repo, fake } = repository();

    await repo.findByProject('project-1', { sort: 'asc' });

    const asc = fake.lastSort() ?? {};

    await repo.findByProject('project-1', { sort: 'desc' });

    const desc = fake.lastSort() ?? {};

    expect(Object.keys(asc).length).toBeGreaterThan(1);
    expect(Object.keys(desc)).toEqual(Object.keys(asc));

    for (const key of Object.keys(asc)) {
      // Every key flips together: a tiebreaker pointing the other way would
      // order the tied group BACKWARDS relative to the key it breaks.
      expect(desc[key], `${key} did not flip`).toBe(-(asc[key] as number));
    }
  });

  it('the total order also holds for the tenant-wide list, not just the project list', async () => {
    const { repo, fake } = repository();

    await sameMillisecondBatch(repo, 3);
    await repo.findByTenant('tenant-1', { limit: 20 });

    expect(fake.tiesIn()).toBe(0);
  });
});

describe('AuditEventRepository — filters and cascade', () => {
  it('scopes the project list to the addressed project', async () => {
    const { repo, fake } = repository();

    await repo.createMany([eventDoc({ id: 'a' }), eventDoc({ id: 'c', projectId: 'project-2' })]);

    const all = await repo.findByProject('project-1');

    expect(all.data.map((e) => e.id)).toEqual(['a']);
    expect(fake.collection.find).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      expect.objectContaining({ maxTimeMS: expect.any(Number) as number }),
    );
  });

  it('applies each drill-down filter to the query, not in memory', async () => {
    const { repo, fake } = repository();

    await repo.createMany([eventDoc({ id: 'a' }), eventDoc({ id: 'b', entityId: 'task-9' })]);

    const drilled = await repo.findByProject('project-1', { entityId: 'task-9', action: 'UPDATED', actorId: 'user-1' });

    expect(drilled.data.map((e) => e.id)).toEqual(['b']);
    expect(fake.collection.find).toHaveBeenCalledWith(
      { projectId: 'project-1', entityId: 'task-9', action: 'UPDATED', 'actor.userId': 'user-1' },
      expect.anything(),
    );
  });

  it('reports the total from the whole filtered set, not the page', async () => {
    const { repo } = repository();

    await repo.createMany(Array.from({ length: 5 }, (_unused, i) => eventDoc({ id: `e-${i}` })));

    const page = await repo.findByProject('project-1', { page: 2, limit: 2 });

    expect(page.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('cascade delete removes only the addressed project', async () => {
    const { repo, fake } = repository();

    await repo.deleteByProject('project-1');

    expect(fake.collection.deleteMany).toHaveBeenCalledWith({ projectId: 'project-1' });
  });
});
