/**
 * Tests for idempotent data migrations.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  migrateInvitedMembershipsToRevoked,
  renameSeedStatusNames,
  backfillTenantSlugs,
  ensureTenantSlugUniqueIndex,
  ensureTenantSlugIntegrity,
  backfillMemberExpiresAt,
  migrateToSingleBoardPerProject,
  backfillTaskSortNames,
  backfillTaskDescriptionText,
  AUDIT_RETENTION_DAYS,
  AUDIT_RETENTION_SECONDS,
  migrateTaskPriorityToLevel,
  listIndexesSafely,
  ensureCoreIndexes,
  dropSupersededIndexes,
  hasDuplicatesFor,
  indexNameFor,
  CORE_INDEXES,
  SUPERSEDED_INDEXES,
} from './migrations.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` clash.
const REPO_DIR = dirname(import.meta.filename);
const REPOSITORY_DIR = join(REPO_DIR, '..', 'repositories');
/**
 * The exact `(collection, keys, unique?)` triples F11 added, in the shape the
 * guardrail assertions consume. Written out literally rather than derived from
 * `CORE_INDEXES` on purpose: a test that reads the array it is supposed to police
 * proves nothing. If an index is dropped or re-ordered, THESE literals fail.
 *
 * Two entries were REMOVED from this list, matching the two `CORE_INDEXES`
 * entries removed in `migrations.ts`:
 *   - `tenant_members {tenantId, status}` — its only serving query was
 *     `TenantMemberRepository.countActiveByTenant`, dead code (no caller).
 *   - `projects {key}` — added for `ProjectRepository.findByKey`, which looked a
 *     project up by `key` ALONE (tenant-unsafe) and had no caller.
 * Both drops were an approved decision; the guardrail assertions themselves are
 * untouched and still police the remaining inventory in both directions.
 */
const F11_INDEXES: { collection: string; keys: Record<string, 1 | -1>; unique: boolean }[] = [
  { collection: 'users', keys: { 'passwordReset.tokenHash': 1 }, unique: false },
  { collection: 'tenant_members', keys: { userId: 1, role: 1 }, unique: false },
  { collection: 'project_members', keys: { userId: 1 }, unique: false },
  { collection: 'tasks', keys: { projectId: 1, typeId: 1 }, unique: false },
  { collection: 'comments', keys: { taskId: 1, createdAt: 1 }, unique: false },
  { collection: 'comments', keys: { id: 1 }, unique: true },
  {
    collection: 'task_relationships',
    keys: { projectId: 1, sourceTaskId: 1, targetTaskId: 1 },
    unique: true,
  },
  { collection: 'task_relationships', keys: { id: 1 }, unique: true },
  // The three audit sort indexes grew a `_id` tiebreaker (the `-1` on
  // `_id` is ALIGNED with `createdAt`, so one index serves both directions by
  // reverse traversal). The `createdAt`-only specs they replaced are listed in
  // `SUPERSEDED_INDEXES` and dropped by `dropSupersededIndexes`; a guardrail
  // below asserts every one of them has its replacement BEFORE the drop runs.
  { collection: 'audit_events', keys: { projectId: 1, 'actor.userId': 1, createdAt: -1, _id: -1 }, unique: false },
  { collection: 'audit_events', keys: { projectId: 1, entityId: 1, createdAt: -1, _id: -1 }, unique: false },
  { collection: 'audit_events', keys: { tenantId: 1, projectId: 1, createdAt: -1, _id: -1 }, unique: false },
  { collection: 'filters', keys: { userId: 1, projectId: 1, name: 1 }, unique: true },
  { collection: 'labels', keys: { projectId: 1, name: 1 }, unique: false },
  { collection: 'statuses', keys: { projectId: 1, position: 1 }, unique: false },
  { collection: 'task_types', keys: { projectId: 1, position: 1 }, unique: false },
  { collection: 'sprints', keys: { projectId: 1, createdAt: -1 }, unique: false },
];

/** The `CORE_INDEXES` entry for a `(collection, keys)` pair, if declared. */
function declared(collection: string, keys: Record<string, 1 | -1>) {
  return CORE_INDEXES.find((entry) => entry.collection === collection && sameKeyOrder(entry.spec, keys));
}

/**
 * Strips comments before a source check, so that DOCUMENTING a deleted query in
 * a comment (which the F22 deletion notes legitimately do) cannot satisfy a
 * contract row. Only executable code is inspected — this is the difference
 * between "the repository still runs this query" and "the repository mentions
 * this query", and one row here was satisfied by the latter alone.
 */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
/** Stable identity of an index: `collection` + the spec, key order included. */
const indexId = (collection: string, spec: Record<string, 1 | -1>): string => `${collection}|${JSON.stringify(spec)}`;

/**
 * Deep-equal on the KEY ORDER, not on the object. `{a:1,b:1}` and `{b:1,a:1}`
 * are different indexes to MongoDB and mean different things to the planner, so
 * a `toEqual` on the object would happily pass a re-ordered index.
 */
function sameKeyOrder(a: Record<string, 1 | -1>, b: Record<string, 1 | -1>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  return aKeys.length === bKeys.length && aKeys.every((key, i) => key === bKeys[i] && a[key] === b[key]);
}

describe('migrateInvitedMembershipsToRevoked', () => {
  it('rewrites ACTIVE members with PENDING invitations to ACCESS_REVOKED', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 3 });
    const collection = vi.fn().mockReturnValue({ updateMany });
    const db = { collection } as never;
    const count = await migrateInvitedMembershipsToRevoked(db);

    expect(count).toBe(3);
    expect(collection).toHaveBeenCalledWith('tenant_members');
    expect(updateMany).toHaveBeenCalledWith(
      { status: 'ACTIVE', 'invitation.status': 'PENDING' },
      { $set: { status: 'ACCESS_REVOKED' } },
    );
  });

  it('is idempotent — a conformed database yields modifiedCount 0', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const db = { collection: vi.fn().mockReturnValue({ updateMany }) } as never;
    const count = await migrateInvitedMembershipsToRevoked(db);

    expect(count).toBe(0);
  });
});

// ─── DEC-032 ─────────────────────────────────────────────────────────────────

function createBackfillDb(tenants: Record<string, unknown>[]) {
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });

  return {
    db: {
      collection: vi.fn().mockReturnValue({
        find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(tenants) }),
        findOne: vi.fn().mockResolvedValue(null),
        updateOne,
      }),
    },
    updateOne,
  };
}

describe('backfillTenantSlugs (DEC-032)', () => {
  it('generates a slug from the tenant name for legacy tenants', async () => {
    const { db, updateOne } = createBackfillDb([{ _id: 'oid-1', name: 'My Workspace' }]);
    const count = await backfillTenantSlugs(db as never);

    expect(count).toBe(1);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'oid-1' }, { $set: { slug: 'my-workspace' } });
  });

  it('appends a numeric suffix (-2, -3…) when the generated slug collides', async () => {
    const { db, updateOne } = createBackfillDb([{ _id: 'oid-1', name: 'My Workspace' }]);
    const tenants = (db as { collection: ReturnType<typeof vi.fn> }).collection();

    // First lookup (candidate 'my-workspace') collides; second ('my-workspace-2') is free
    tenants.findOne.mockResolvedValueOnce({ slug: 'my-workspace' }).mockResolvedValueOnce(null);

    const count = await backfillTenantSlugs(db as never);

    expect(count).toBe(1);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'oid-1' }, { $set: { slug: 'my-workspace-2' } });
  });

  it('is idempotent — a conformed database backfills nothing', async () => {
    const { db, updateOne } = createBackfillDb([]);
    const count = await backfillTenantSlugs(db as never);

    expect(count).toBe(0);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('ensureTenantSlugUniqueIndex (DEC-032)', () => {
  it('creates a unique index on { slug: 1 }', async () => {
    const createIndex = vi.fn().mockResolvedValue('slug_1');
    const db = { collection: vi.fn().mockReturnValue({ createIndex }) } as never;

    await ensureTenantSlugUniqueIndex(db);

    expect(createIndex).toHaveBeenCalledWith({ slug: 1 }, { unique: true });
  });
});

describe('ensureTenantSlugIntegrity (M-04)', () => {
  it('runs the backfill and the unique index creation back-to-back, in that order', async () => {
    const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const createIndex = vi.fn().mockResolvedValue('slug_1');
    const db = {
      collection: vi.fn().mockReturnValue({
        find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ _id: 'oid-1', name: 'My Workspace' }]) }),
        findOne: vi.fn().mockResolvedValue(null),
        updateOne,
        createIndex,
      }),
    } as never;

    await ensureTenantSlugIntegrity(db);

    expect(updateOne).toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledWith({ slug: 1 }, { unique: true });
    // the index must be created only after the backfill completed
    expect(updateOne.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      createIndex.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });
});

// ─── Seed-status display names ───────────────────────────────────────────────

describe('renameSeedStatusNames (DR-1)', () => {
  function createStatusDb() {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });

    return { db: { collection: vi.fn().mockReturnValue({ updateMany }) } as never, updateMany };
  }

  it('renames raw-key seed statuses to human-readable names', async () => {
    const { db, updateMany } = createStatusDb();
    const count = await renameSeedStatusNames(db);

    // One update per seed status (todo, in_progress, in_review, reopened, done)
    expect(count).toBe(5);
    expect(updateMany).toHaveBeenCalledWith(
      { normalizedName: 'todo', name: 'TODO' },
      { $set: { name: 'To Do', updatedAt: expect.any(Date) } },
    );
    expect(updateMany).toHaveBeenCalledWith(
      { normalizedName: 'in_progress', name: 'IN_PROGRESS' },
      { $set: { name: 'In Progress', updatedAt: expect.any(Date) } },
    );
    expect(updateMany).toHaveBeenCalledWith(
      { normalizedName: 'done', name: 'DONE' },
      { $set: { name: 'Done', updatedAt: expect.any(Date) } },
    );
  });

  it('is idempotent — already-renamed statuses never match the raw-key filter', async () => {
    const { db, updateMany } = createStatusDb();

    // Simulate a conformed database: every rename touches 0 docs
    updateMany.mockResolvedValue({ modifiedCount: 0 });

    const count = await renameSeedStatusNames(db);

    expect(count).toBe(0);
  });

  it('never touches custom user-renamed statuses (match is by normalizedName + exact raw key)', async () => {
    const { db, updateMany } = createStatusDb();

    updateMany.mockResolvedValue({ modifiedCount: 0 });

    await renameSeedStatusNames(db);

    // Filters always pin the exact raw-key name — a status renamed by a user
    // (e.g. normalizedName 'todo' with name 'Backlog') cannot match.
    for (const call of updateMany.mock.calls) {
      expect(call[0].name).toBe(call[0].normalizedName.toUpperCase());
    }
  });
});

// ─── DEC-055 ─────────────────────────────────────────────────────────────────

describe('backfillMemberExpiresAt (DEC-055)', () => {
  it('sets expiresAt to null on legacy member documents missing the field', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 5 });
    const collection = vi.fn().mockReturnValue({ updateMany });
    const db = { collection } as never;
    const count = await backfillMemberExpiresAt(db);

    expect(count).toBe(5);
    expect(collection).toHaveBeenCalledWith('tenant_members');
    expect(updateMany).toHaveBeenCalledWith({ expiresAt: { $exists: false } }, { $set: { expiresAt: null } });
  });

  it('is idempotent — a conformed database yields modifiedCount 0', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const db = { collection: vi.fn().mockReturnValue({ updateMany }) } as never;
    const count = await backfillMemberExpiresAt(db);

    expect(count).toBe(0);
  });
});

// ─── Single-board migration (doc 102) ────────────────────────────────────────

function createBoardMigrationDb(boards: unknown[], projects: unknown[]) {
  const boardsCollection = {
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(boards) }),
    findOne: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    dropIndex: vi.fn().mockResolvedValue(undefined),
    indexes: vi.fn().mockResolvedValue([]),
  };
  const projectsCollection = {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(projects) }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
  const prefsCollection = { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) };
  const collections: Record<string, unknown> = {
    boards: boardsCollection,
    projects: projectsCollection,
    user_preferences: prefsCollection,
  };
  const db = {
    collection: vi.fn((name: string) => collections[name]),
  };

  return { db, boardsCollection, projectsCollection, prefsCollection };
}

describe('migrateToSingleBoardPerProject (doc 102)', () => {
  const columns = [{ id: 'col-1', statusIds: ['s1'], position: 0 }];

  it('keeps the board referenced by project.defaultBoardId and drops the extras', async () => {
    const boards = [
      { _id: 'oid-1', id: 'board-old', projectId: 'p1', name: 'Old', type: 'KANBAN', columns, createdAt: new Date(1) },
      {
        _id: 'oid-2',
        id: 'board-default',
        projectId: 'p1',
        name: 'Default',
        type: 'KANBAN',
        columns,
        createdAt: new Date(2),
      },
    ];
    const { db, boardsCollection, projectsCollection } = createBoardMigrationDb(boards, [
      { id: 'p1', defaultBoardId: 'board-default' },
    ]);

    projectsCollection.findOne.mockResolvedValue({ id: 'p1', defaultBoardId: 'board-default' });

    await migrateToSingleBoardPerProject(db as never);

    expect(boardsCollection.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['oid-1'] } });
    // The survivor is normalized: dead fields stripped, projectId preserved
    expect(boardsCollection.updateOne).toHaveBeenCalledWith(
      { _id: 'oid-2' },
      expect.objectContaining({
        $set: expect.objectContaining({ projectId: 'p1', columns }),
        $unset: { id: '', name: '', type: '' },
      }),
    );
  });

  it('falls back to the OLDEST board when the project has no defaultBoardId', async () => {
    const boards = [
      { _id: 'oid-2', projectId: 'p1', columns, createdAt: new Date(2) },
      { _id: 'oid-1', projectId: 'p1', columns, createdAt: new Date(1) },
    ];
    const { db, boardsCollection } = createBoardMigrationDb(boards, [{ id: 'p1', defaultBoardId: 'gone' }]);

    boardsCollection.findOne.mockResolvedValue(null);

    await migrateToSingleBoardPerProject(db as never);

    expect(boardsCollection.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['oid-2'] } });
    expect(boardsCollection.updateOne).toHaveBeenCalledWith({ _id: 'oid-1' }, expect.anything());
  });

  it('unsets dead defaultBoardId fields on projects and user_preferences', async () => {
    const { db, projectsCollection, prefsCollection } = createBoardMigrationDb([], [{ id: 'p1' }]);

    await migrateToSingleBoardPerProject(db as never);

    expect(projectsCollection.updateMany).toHaveBeenCalledWith(
      { defaultBoardId: { $exists: true } },
      { $unset: { defaultBoardId: '' } },
    );
    expect(prefsCollection.updateMany).toHaveBeenCalledWith(
      { defaultBoardId: { $exists: true } },
      { $unset: { defaultBoardId: '' } },
    );
  });

  it('is idempotent — a conformed database is a no-op', async () => {
    const boards = [{ _id: 'oid-1', projectId: 'p1', columns, createdAt: new Date(1) }];
    const { db, boardsCollection } = createBoardMigrationDb(boards, [{ id: 'p1' }]);

    await migrateToSingleBoardPerProject(db as never);

    expect(boardsCollection.deleteMany).not.toHaveBeenCalled();
  });

  // On a brand-new database the `boards` collection has never been
  // created, so `boards.indexes()` answers NamespaceNotFound (code 26) instead
  // of an empty list — which crashed the whole migration run and made a fresh
  // environment impossible to bootstrap.
  it('runs on a fresh database where the boards collection does not exist yet', async () => {
    const { db, boardsCollection, projectsCollection, prefsCollection } = createBoardMigrationDb([], []);

    // The driver raises NamespaceNotFound for a namespace that was never created.
    boardsCollection.indexes.mockRejectedValue(Object.assign(new Error('ns not found'), { code: 26 }));

    await expect(migrateToSingleBoardPerProject(db as never)).resolves.toBeUndefined();

    // No legacy projectId_1 index to drop, and the rest of the migration still ran.
    expect(boardsCollection.dropIndex).not.toHaveBeenCalledWith('projectId_1');
    expect(projectsCollection.updateMany).toHaveBeenCalled();
    expect(prefsCollection.updateMany).toHaveBeenCalled();
  });

  it('drops the legacy non-unique projectId_1 index when the collection does exist', async () => {
    const { db, boardsCollection } = createBoardMigrationDb([], []);

    boardsCollection.indexes.mockResolvedValue([{ name: 'projectId_1', key: { projectId: 1 }, unique: false }]);

    await migrateToSingleBoardPerProject(db as never);

    expect(boardsCollection.dropIndex).toHaveBeenCalledWith('projectId_1');
  });
});

describe('listIndexesSafely (M-030)', () => {
  it('returns the real index list when the collection exists', async () => {
    const indexes = [{ name: '_id_', key: { _id: 1 } }];
    const collection = { indexes: vi.fn().mockResolvedValue(indexes) };

    await expect(listIndexesSafely(collection)).resolves.toEqual(indexes);
  });

  it('treats NamespaceNotFound (code 26) as "no indexes"', async () => {
    const collection = { indexes: vi.fn().mockRejectedValue(Object.assign(new Error('ns not found'), { code: 26 })) };

    await expect(listIndexesSafely(collection)).resolves.toEqual([]);
  });

  it('re-throws every other error so real failures are not silently swallowed', async () => {
    const collection = { indexes: vi.fn().mockRejectedValue(Object.assign(new Error('auth failed'), { code: 13 })) };

    await expect(listIndexesSafely(collection)).rejects.toThrow('auth failed');
  });
});

// ─── Denormalized task sort names ────────────────────────────────────────────

function createSortNamesDb(statuses: { id: string; name: string }[], sprints: { id: string; name: string }[]) {
  const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const entities = (name: string) => ({
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(name === 'statuses' ? statuses : sprints) }),
  });
  const collections: Record<string, unknown> = {
    statuses: entities('statuses'),
    sprints: entities('sprints'),
    tasks: { updateMany },
  };
  const db = { collection: vi.fn((n: string) => collections[n]) };

  return { db, updateMany };
}

describe('backfillTaskSortNames (TOP-2)', () => {
  it('propagates entity names into the denormalized task fields', async () => {
    const { db, updateMany } = createSortNamesDb([{ id: 's1', name: 'TODO' }], [{ id: 'sp1', name: 'Sprint 1' }]);
    const count = await backfillTaskSortNames(db as never);

    expect(updateMany).toHaveBeenCalledWith(
      { statusId: 's1', statusName: { $ne: 'TODO' } },
      { $set: { statusName: 'TODO' } },
    );
    expect(updateMany).toHaveBeenCalledWith(
      { sprintId: 'sp1', sprintName: { $ne: 'Sprint 1' } },
      { $set: { sprintName: 'Sprint 1' } },
    );
    expect(count).toBeGreaterThan(0);
  });

  it('normalizes orphaned references to null', async () => {
    const { db, updateMany } = createSortNamesDb([], []);

    await backfillTaskSortNames(db as never);

    // No known entities → every task holding a non-null stale name is normalized.
    expect(updateMany).toHaveBeenCalledWith(
      { statusId: { $nin: [] }, statusName: { $exists: true, $ne: null } },
      { $set: { statusName: null } },
    );
    expect(updateMany).toHaveBeenCalledWith(
      { sprintId: { $nin: [] }, sprintName: { $exists: true, $ne: null } },
      { $set: { sprintName: null } },
    );
  });

  it('is idempotent — a conformed database yields modifiedCount 0', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const db = {
      collection: vi.fn(() => ({
        find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        updateMany,
      })),
    } as never;
    const count = await backfillTaskSortNames(db);

    expect(count).toBe(0);
  });
});

// ── migrateTaskPriorityToLevel (priority string → numeric priorityLevel) ────

type MockTask = Record<string, unknown>;

function createPriorityDb(taskDocs: MockTask[], filterDocs: MockTask[] = []) {
  const tasks = [...taskDocs];
  const filters = [...filterDocs];
  const updateMany = vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    let n = 0;

    for (const doc of tasks) {
      const match = Object.entries(filter).every(([k, v]) => {
        if (v !== null && typeof v === 'object') {
          if ('$exists' in v && '$nin' in v)
            return (v.$exists ? k in doc : !(k in doc)) && !(v.$nin as unknown[]).includes(doc[k]);
          if ('$exists' in v) return v.$exists ? k in doc : !(k in doc);
          if ('$nin' in v) return !(v.$nin as unknown[]).includes(doc[k]);
          return false;
        }
        return doc[k] === v;
      });

      if (!match) continue;
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- emulating Mongo $unset on a plain mock object
          delete doc[k];
        }
      }
      n++;
    }
    return { modifiedCount: n };
  });
  const dropIndex = vi.fn(async () => undefined);
  const updateOne = vi.fn(async (_f: unknown, update: Record<string, unknown>) => {
    const setCriteria = (update.$set ?? {}) as { 'criteria.priorityLevel'?: number[] };
    const unsetKeys = Object.keys((update.$unset ?? {}) as Record<string, unknown>);

    for (const fl of filters) {
      const criteria = fl.criteria as Record<string, unknown>;

      if (setCriteria['criteria.priorityLevel']) criteria.priorityLevel = setCriteria['criteria.priorityLevel'];
      for (const k of unsetKeys) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- emulating Mongo $unset on a plain mock object
        delete criteria[k.replace('criteria.', '')];
      }
    }
    return { modifiedCount: 1 };
  });
  const db = {
    collection: vi.fn((name: string) =>
      name === 'tasks'
        ? {
            countDocuments: vi.fn(async (f: Record<string, unknown>) => {
              const docs: MockTask[] = tasks;

              return docs.filter((doc) =>
                Object.entries(f).every(([k, v]) => {
                  if (v !== null && typeof v === 'object') {
                    if ('$exists' in v && '$nin' in v)
                      return (v.$exists ? k in doc : !(k in doc)) && !(v.$nin as unknown[]).includes(doc[k]);
                    if ('$exists' in v) return v.$exists ? k in doc : !(k in doc);
                    if ('$nin' in v) return !(v.$nin as unknown[]).includes(doc[k]);
                    return false;
                  }
                  return doc[k] === v;
                }),
              ).length;
            }),
            updateMany,
            dropIndex,
          }
        : {
            find: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(filters.filter((f) => 'priority' in (f.criteria as object))),
            }),
            updateOne,
          },
    ),
  };

  return { db: db as never, tasks, updateMany, dropIndex, updateOne };
}

describe('backfillTaskDescriptionText (N-5)', () => {
  /**
   * A `tasks` fake modelling only what the migration uses: a filtered, projected,
   * limited read and a `bulkWrite`. The read RETURNS NOTHING once every pending
   * document has been written, which is what makes the loop terminate — a fake
   * that always returned the same rows would hang, and one that never returned
   * any would pass every assertion vacuously.
   */
  function createTextBackfillDb(docs: { _id: string; description: string | null }[]) {
    const pending = [...docs];
    // The fake HONOURS `limit`, which is what makes the batching assertion
    // meaningful: a fake that ignored it would return everything in one read and
    // the loop's bound would be untested.
    let batchSize = Number.POSITIVE_INFINITY;
    const cursor = {
      limit: vi.fn((size: number) => {
        batchSize = size;

        return cursor;
      }),
      toArray: vi.fn(async () => pending.splice(0, batchSize)),
    };
    const find = vi.fn().mockReturnValue(cursor);
    // `modifiedCount` reflects the batch actually handed to it, not the total —
    // a constant here would make the returned count a lie in exactly the case the
    // test exists to exercise.
    const bulkWrite = vi.fn(async (ops: unknown[]) => ({ modifiedCount: (ops as unknown[]).length }));
    const db = { collection: vi.fn().mockReturnValue({ find, bulkWrite }) };

    return { db, find, bulkWrite };
  }

  it('projects the Markdown description into plain text', async () => {
    const { db, bulkWrite } = createTextBackfillDb([{ _id: 'oid-1', description: '**Bold** text' }]);
    const written = await backfillTaskDescriptionText(db as never);

    expect(written).toBe(1);

    const ops = bulkWrite.mock.calls[0]?.[0] as { updateOne: { filter: unknown; update: { $set: unknown } } }[];

    expect(ops[0]?.updateOne.filter).toEqual({ _id: 'oid-1' });
    expect(ops[0]?.updateOne.update.$set).toEqual({ descriptionText: 'Bold text' });
  });

  it('only selects documents that have NO projection yet', async () => {
    // The idempotence filter. A backfill that re-selected conformed documents
    // would rewrite every task on every deploy, for no change.
    const { db, find } = createTextBackfillDb([{ _id: 'oid-1', description: 'text' }]);

    await backfillTaskDescriptionText(db as never);

    expect(find).toHaveBeenCalledWith(
      { descriptionText: { $exists: false }, description: { $exists: true, $ne: null } },
      { projection: { _id: 1, description: 1 } },
    );
  });

  it('is idempotent — a conformed database writes nothing and does not loop forever', async () => {
    const { db, bulkWrite } = createTextBackfillDb([]);
    const written = await backfillTaskDescriptionText(db as never);

    expect(written).toBe(0);
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('never materialises a full task document', async () => {
    // The reason the read is projected: a migration over a large table must not
    // pull every field of every task into the Worker's heap to compute a string.
    const { db, find } = createTextBackfillDb([{ _id: 'oid-1', description: 'text' }]);

    await backfillTaskDescriptionText(db as never);

    const options = find.mock.calls[0]?.[1] as { projection: Record<string, number> };

    expect(Object.keys(options.projection).sort()).toEqual(['_id', 'description']);
  });

  it('handles several batches rather than loading the whole table', async () => {
    const many = Array.from({ length: 1200 }, (_, index) => ({ _id: `oid-${index}`, description: 'x' }));
    const { db, bulkWrite } = createTextBackfillDb(many);
    const written = await backfillTaskDescriptionText(db as never);

    // Bounded batches (TASK_TEXT_BACKFILL_BATCH = 500) rather than one
    // unbounded read.
    expect(bulkWrite).toHaveBeenCalledTimes(3);
    expect(written).toBe(1200);
  });
});

describe('the audit retention window (C-8)', () => {
  it('is a positive number of days, and the seconds match it', () => {
    // The window is a policy, not a constant someone typed once: these two rows
    // fail if either becomes zero, negative, or inconsistent.
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(AUDIT_RETENTION_DAYS)).toBe(true);
    expect(AUDIT_RETENTION_SECONDS).toBe(AUDIT_RETENTION_DAYS * 24 * 60 * 60);
  });

  it('is declared as a time-to-live index on createdAt', () => {
    // The mechanism, asserted rather than described. A retention window that
    // nothing enforces is a comment.
    const ttl = CORE_INDEXES.find(
      (entry) => entry.collection === 'audit_events' && JSON.stringify(entry.spec) === JSON.stringify({ createdAt: 1 }),
    );

    expect(ttl).toBeDefined();
    expect(ttl?.options?.expireAfterSeconds).toBe(AUDIT_RETENTION_SECONDS);
  });

  it('is a single-field index, because a TTL index must be', () => {
    // A compound TTL index is silently ignored by some server versions, which
    // would leave the log unbounded while every comment claimed otherwise.
    // Scoped to `audit_events` by COLLECTION, not by position: the rate-limit
    // counters carry a TTL index too, so a predicate that took "the first entry
    // with `expireAfterSeconds`" would silently start asserting about whichever
    // of the two happened to be declared first.
    const ttl = CORE_INDEXES.find(
      (entry) => entry.collection === 'audit_events' && entry.options?.expireAfterSeconds !== undefined,
    );

    expect(ttl).toBeDefined();
    expect(Object.keys(ttl?.spec ?? {})).toEqual(['createdAt']);
  });

  it('the rate-limit counter TTL index is single-field on expiresAt and sweeps on the date itself', () => {
    // The counters are swept for the same reason the audit log is, and by the
    // same rule: a compound key here would be ignored by the server and the
    // collection would grow one document per distinct address forever. The
    // audit index measures a fixed retention window from `createdAt`; these
    // documents carry their own `expiresAt` (window end + grace), so the
    // index must carry `expireAfterSeconds: 0` — expire exactly AT the field's
    // value, not `value + N seconds`.
    const ttl = CORE_INDEXES.find(
      (entry) => entry.collection === 'rate_limit_counters' && entry.options?.expireAfterSeconds !== undefined,
    );

    expect(ttl).toBeDefined();
    expect(Object.keys(ttl?.spec ?? {})).toEqual(['expiresAt']);
    expect(ttl?.options?.expireAfterSeconds).toBe(0);
  });

  it('every TTL index in CORE_INDEXES is a single-field date index', () => {
    // The property, not the two rows above: whatever TTL index is added next,
    // the sweep has to be one the server will honour.
    const compound = CORE_INDEXES.filter(
      (entry) => entry.options?.expireAfterSeconds !== undefined && Object.keys(entry.spec).length !== 1,
    );

    expect(compound.map((entry) => `${entry.collection} ${JSON.stringify(entry.spec)}`)).toEqual([]);
  });

  it('the purge selection query is indexed on both entity collections', () => {
    // Without these the once-a-day purge is a COLLSCAN of `projects` and
    // `tenants`, both of which grow with the product.
    for (const collection of ['projects', 'tenants']) {
      const index = CORE_INDEXES.find(
        (entry) => entry.collection === collection && entry.spec.status === 1 && entry.spec.deletionScheduledAt === 1,
      );

      expect(index, `${collection} has no {status, deletionScheduledAt} index`).toBeDefined();
    }
  });
});

describe('migrateTaskPriorityToLevel', () => {
  it('backfills LOW/MEDIUM/HIGH/CRITICAL → 0/1/2/3, unsets the old field and drops the legacy index', async () => {
    const docs: MockTask[] = [
      { id: 't1', priority: 'LOW' },
      { id: 't2', priority: 'MEDIUM' },
      { id: 't3', priority: 'HIGH' },
      { id: 't4', priority: 'CRITICAL' },
    ];
    const { db, dropIndex } = createPriorityDb(docs);
    const stats = await migrateTaskPriorityToLevel(db);

    expect(stats.tasksTotal).toBe(4);
    expect(stats.tasksMigrated).toBe(4);
    expect(stats.oldFieldRemoved).toBe(4);
    expect(stats.oldIndexDropped).toBe(true);
    expect(docs.map((d) => d.priorityLevel)).toEqual([0, 1, 2, 3]);
    expect(docs.every((d) => !('priority' in d))).toBe(true);
    // legacy index dropped by name
    expect(dropIndex).toHaveBeenCalledWith('projectId_1_priority_1_number_1');
  });

  it('migrates saved-filter criteria arrays', async () => {
    const filters: MockTask[] = [{ id: 'f1', criteria: { priority: ['HIGH', 'CRITICAL'] } }];
    const { db } = createPriorityDb([{ id: 't1', priority: 'LOW' }], filters);
    const stats = await migrateTaskPriorityToLevel(db);

    expect(stats.filtersMigrated).toBe(1);
    expect(filters[0]?.criteria).toEqual({ priorityLevel: [2, 3] });
  });

  it('refuses to run when a task is missing priority (and does not touch data)', async () => {
    const docs: MockTask[] = [{ id: 't1', priority: 'LOW' }, { id: 't2' }];
    const { db, updateMany } = createPriorityDb(docs);

    await expect(migrateTaskPriorityToLevel(db)).rejects.toThrow(/missing priority/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses to run on unexpected priority values', async () => {
    const docs: MockTask[] = [{ id: 't1', priority: 'WHATEVER' }];
    const { db, updateMany } = createPriorityDb(docs);

    await expect(migrateTaskPriorityToLevel(db)).rejects.toThrow(/unexpected/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent — a migrated database is a no-op', async () => {
    const docs: MockTask[] = [{ id: 't1', priorityLevel: 2 }];
    const { db, updateMany } = createPriorityDb(docs);
    const stats = await migrateTaskPriorityToLevel(db);

    expect(stats.tasksMigrated).toBe(0);
    expect(stats.oldFieldRemoved).toBe(0);
    // only the legacy-field removal pass ran (matching nothing)
    expect(updateMany).toHaveBeenCalledTimes(5); // 4 no-op backfill passes + the removal pass
  });
});

// ─── The missing-index backlog ────────────────────────────────────────────────

describe('CORE_INDEXES (F11 additions)', () => {
  it('declares every F11 index with the exact key order', () => {
    const missing = F11_INDEXES.filter((index) => declared(index.collection, index.keys) === undefined).map(
      (index) => `${index.collection} ${JSON.stringify(index.keys)}`,
    );

    expect(missing).toEqual([]);
  });

  it('declares the unique option on exactly the indexes that must be unique', () => {
    for (const { collection, keys, unique } of F11_INDEXES) {
      const entry = declared(collection, keys);

      expect(entry, `${collection} ${JSON.stringify(keys)}`).toBeDefined();
      expect(entry?.options?.unique ?? false, `${collection} ${JSON.stringify(keys)} unique`).toBe(unique);
    }
  });

  it('declares no duplicate (collection, key) pairs', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const entry of CORE_INDEXES) {
      // The key ORDER is part of the identity — `createIndex` would treat a
      // re-ordered duplicate as a second index on the same collection.
      const id = `${entry.collection}|${JSON.stringify(entry.spec)}`;

      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }

    expect(duplicates).toEqual([]);
  });

  it('guards the risky unique indexes with the duplicate pre-check', () => {
    // `createIndex({unique:true})` FAILS the whole build on existing duplicates,
    // and this migration runs from CD against a database the old Worker still
    // serves. Exactly the three check-then-act keys carry the guard; the
    // `comments {id}` index deliberately does not (see the docblock).
    const guarded = CORE_INDEXES.filter((entry) => entry.requiresDuplicateFreeData).map(
      (entry) => `${entry.collection}|${JSON.stringify(entry.spec)}`,
    );

    expect(guarded.sort()).toEqual(
      [
        'filters|{"userId":1,"projectId":1,"name":1}',
        'task_relationships|{"id":1}',
        'task_relationships|{"projectId":1,"sourceTaskId":1,"targetTaskId":1}',
      ].sort(),
    );
  });
});

describe('hasDuplicatesFor', () => {
  function collectionReturning(groups: unknown[]) {
    return { aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(groups) }) };
  }

  it('reports no duplicates for an empty result (a fresh collection)', async () => {
    await expect(hasDuplicatesFor(collectionReturning([]), { id: 1 })).resolves.toEqual({
      duplicate: false,
      sample: [],
    });
  });

  it('reports the offending groups so the migration can name them', async () => {
    const group = { _id: { userId: 'u1', projectId: 'p1', name: 'Bug' }, count: 2 };
    const result = await hasDuplicatesFor(collectionReturning([group]), { userId: 1, projectId: 1, name: 1 });

    expect(result.duplicate).toBe(true);
    expect(result.sample).toEqual([group]);
  });

  it('groups by the index keys and caps the materialised groups', async () => {
    const collection = collectionReturning([]);
    const spec: Record<string, 1 | -1> = { projectId: 1, sourceTaskId: 1, targetTaskId: 1 };

    await hasDuplicatesFor(collection, spec);

    const [pipeline] = collection.aggregate.mock.calls[0] as [Record<string, unknown>[]];

    // The `_id` is asserted STRUCTURALLY below, not pinned to a literal: the
    // previous test pinned `{_id: spec}` — the exact shape the server rejects —
    // so it went green on code that made every probe-guarded index fail.
    expect(Object.keys(pipeline[0] as object)).toEqual(['$group']);
    expect(Object.keys(pipeline[1] as object)).toEqual(['$match']);
    expect(pipeline[2]).toEqual({ $limit: 5 });
    expect(aggregateGroupIdIsServable(pipeline[0] as { $group: { _id: unknown } })).toBe(true);
  });
});

/**
 * Would MongoDB accept this `$group` `_id`?
 *
 * A `$group` `_id` is an EXPRESSION. Two shapes are rejected by the server, and
 * neither can be detected by a mocked `aggregate` — both fail only when a real
 * mongod parses the pipeline, which is why the whole guardrail slipped through a
 * green CI and failed the first production migration run:
 *
 *   - an inclusion-style object (`{projectId: 1}`) → code 17390,
 *     `$group does not support inclusion-style expressions`;
 *   - a document KEY containing a dot (`{'actor.userId': …}`) → code 16412,
 *     `FieldPath field names may not contain '.'`.
 *
 * There is also a silent third case this rejects on purpose: a flat `$getField`
 * on a dotted path is ACCEPTED but resolves every document to `null`, so a
 * clean collection reads as "all duplicates" and a valid unique index is
 * skipped for the wrong reason. A guardrail that only rejected the two loud
 * errors would let that through, so a `_id` key must resolve a real traversal
 * from `$$ROOT` rather than a single flat lookup.
 *
 * Walks the value rather than pattern-matching the known-good output, so any
 * future rewrite is judged by the same rule the server applies.
 */
describe('the duplicate probe builds a servable aggregation (guardrail)', () => {
  /**
   * Every spec the probe is ever handed, checked against the rule the SERVER
   * applies. The regression this exists for failed 100% of probe-guarded
   * indexes on a real deploy while the whole suite stayed green, because every
   * test mocked `aggregate` and one test asserted the broken shape as correct.
   * A mocked `aggregate` cannot catch it: nothing is parsed until a real mongod
   * sees the pipeline. The nested-key cases are included deliberately — this
   * repository indexes `actor.userId` and `passwordReset.tokenHash`, and a
   * non-nested key would be a spec the server rejects for a DIFFERENT reason
   * (code 16412) while testing for 17390.
   */
  const SPECS: { label: string; spec: Record<string, 1 | -1> }[] = [
    { label: 'single flat key', spec: { id: 1 } },
    { label: 'descending key', spec: { createdAt: -1 } },
    { label: 'compound key (the task_relationships edge)', spec: { projectId: 1, sourceTaskId: 1, targetTaskId: 1 } },
    { label: 'mixed directions (the filters name)', spec: { userId: 1, projectId: -1, name: 1 } },
    { label: 'nested key (actor.userId)', spec: { 'actor.userId': 1 } },
    { label: 'deeply nested key', spec: { 'a.b.c': 1 } },
    { label: 'nested inside a compound', spec: { projectId: 1, 'actor.userId': -1 } },
    // The three specs actually probe-guarded in CORE_INDEXES, read from the
    // array so a redefinition cannot quietly escape the check.
    ...CORE_INDEXES.filter((entry) => entry.requiresDuplicateFreeData).map((entry) => ({
      label: `CORE_INDEXES ${entry.collection} ${JSON.stringify(entry.spec)}`,
      spec: entry.spec,
    })),
  ];

  function capturedPipelineFor(spec: Record<string, 1 | -1>): { $group: { _id: unknown } } {
    const collection = { aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }) };

    void hasDuplicatesFor(collection, spec);

    const [pipeline] = collection.aggregate.mock.calls[0] as [Record<string, unknown>[]];

    return pipeline[0] as { $group: { _id: unknown } };
  }

  it.each(SPECS)('builds a $group._id MongoDB will accept — $label', ({ spec }) => {
    expect(aggregateGroupIdIsServable(capturedPipelineFor(spec))).toBe(true);
  });

  it('never passes a bare sort direction as a group key (the code 17390 regression)', () => {
    // The historical failure verbatim: the B-tree spec reused as `_id`. A
    // structural check on the pipeline, so it holds for any spec, not just the
    // three in CORE_INDEXES.
    for (const { spec } of SPECS) {
      const { _id } = capturedPipelineFor(spec).$group;

      expect(_id).not.toEqual(spec);
      expect(JSON.stringify(_id)).not.toContain(':1,');
      for (const value of Object.values(_id as Record<string, unknown>)) {
        expect([1, -1]).not.toContain(value);
      }
    }
  });

  it('rejects the historical broken shape and the other server-rejected forms', () => {
    // Positive control: the guardrail must actually be able to fail. If these
    // ever pass, the guardrail above protects nothing.
    const servable = capturedPipelineFor({ projectId: 1, sourceTaskId: 1, targetTaskId: 1 });

    // (a) the shipped bug: an inclusion-style object as `_id` → code 17390.
    expect(aggregateGroupIdIsServable({ $group: { _id: { projectId: 1, sourceTaskId: 1, targetTaskId: 1 } } })).toBe(
      false,
    );
    // (b) a dotted `_id` KEY → code 16412.
    expect(
      aggregateGroupIdIsServable({
        $group: { _id: { 'actor.userId': { $getField: { field: 'actor.userId', input: '$$ROOT' } } } },
      }),
    ).toBe(false);
    // (c) a flat `$getField` on a dotted path: ACCEPTED by the server but
    //     silently resolves every document to null, so it must still be refused.
    expect(
      aggregateGroupIdIsServable({
        $group: { _id: { k0: { $getField: { field: 'actor.userId', input: '$$ROOT' } } } },
      }),
    ).toBe(false);
    // (d) a field name that is not a `$$` reference resolves nothing.
    expect(aggregateGroupIdIsServable({ $group: { _id: { k0: 'projectId' } } })).toBe(false);
    // and the shipped pipeline is the one that survives all of it.
    expect(aggregateGroupIdIsServable(servable)).toBe(true);
  });
});

function aggregateGroupIdIsServable(stage: { $group: { _id: unknown } }): boolean {
  if (typeof stage.$group._id !== 'object' || stage.$group._id === null || Array.isArray(stage.$group._id)) {
    return false;
  }

  return Object.entries(stage.$group._id as Record<string, unknown>).every(([key, value]) => {
    if (key.includes('.') || key.includes('$')) {
      return false; // code 16412 — a key is read as a field PATH
    }

    return isResolvableFieldExpression(value);
  });
}

/** A `$group._id` value must resolve the key, and must not be the literal sort direction. */
function isResolvableFieldExpression(value: unknown): boolean {
  if (value === 1 || value === -1) {
    return false; // code 17390 — the inclusion-style value that caused the outage
  }

  if (typeof value === 'string') {
    // A bare `$$ROOT`-style field reference is fine; a field name is not.
    return value.startsWith('$$');
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const operators = Object.keys(value as Record<string, unknown>);

  if (operators.length !== 1) {
    return false;
  }

  const [operator] = operators;
  const operand = (value as Record<string, unknown>)[operator as string];

  if (operator === '$getField') {
    const { field, input } = (operand ?? {}) as { field?: unknown; input?: unknown };

    if (typeof field !== 'string' || field.includes('.')) {
      return false; // a dotted `field` does NOT traverse — it silently yields null
    }

    // A single flat `$getField` is the silent-wrong-answer shape: it must be
    // rooted at `$$ROOT`, either directly or through further nesting.
    return isResolvableFieldExpression(input);
  }

  return isResolvableFieldExpression(operand);
}

describe('ensureCoreIndexes (F11)', () => {
  /** A db whose collections all answer the duplicate probe with "clean". */
  function cleanDb() {
    const createIndex = vi.fn().mockResolvedValue('built');
    const collections = new Map<string, ReturnType<typeof cleanCollection>>();

    function cleanCollection() {
      return {
        createIndex,
        aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      };
    }

    return {
      createIndex,
      aggregateCalls: () => collections,
      db: {
        collection: vi.fn((name: string) => {
          if (!collections.has(name)) collections.set(name, cleanCollection());

          return collections.get(name);
        }),
      },
    };
  }

  it('creates every declared index (idempotency: createIndex on an identical index is a server no-op)', async () => {
    const { db, createIndex } = cleanDb();

    await ensureCoreIndexes(db as never);

    expect(createIndex).toHaveBeenCalledTimes(CORE_INDEXES.length);
    expect(createIndex).toHaveBeenCalledWith({ projectId: 1, 'actor.userId': 1, createdAt: -1, _id: -1 }, undefined);
  });

  it('probes the duplicate-free key BEFORE building a guarded unique index', async () => {
    const { db, createIndex } = cleanDb();

    await ensureCoreIndexes(db as never);

    expect(createIndex).toHaveBeenCalledWith({ userId: 1, projectId: 1, name: 1 }, { unique: true });
    expect(createIndex).toHaveBeenCalledWith({ projectId: 1, sourceTaskId: 1, targetTaskId: 1 }, { unique: true });
  });

  it('SKIPS a guarded unique index when duplicates exist, and keeps going', async () => {
    const duplicate = { _id: { projectId: 'p1', sourceTaskId: 'a', targetTaskId: 'b' }, count: 2 };
    const createIndex = vi.fn().mockResolvedValue('built');
    const collection = {
      createIndex,
      aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([duplicate]) }),
    };
    const db = { collection: vi.fn().mockReturnValue(collection) };

    // A duplicate is reported, not thrown: the deploy must not be blocked and
    // the pre-existing (readable) rows must not be deleted.
    await expect(ensureCoreIndexes(db as never)).resolves.toBeUndefined();

    // Every guarded key is skipped …the non-guarded indexes are still built.
    const built = createIndex.mock.calls.map((call) => JSON.stringify(call[0]));

    expect(built).not.toContain(JSON.stringify({ projectId: 1, sourceTaskId: 1, targetTaskId: 1 }));
    expect(built).not.toContain(JSON.stringify({ userId: 1, projectId: 1, name: 1 }));
    expect(built).toContain(JSON.stringify({ projectId: 1, key: 1 }));
  });

  it('still builds the non-unique indexes when a guarded one is skipped', async () => {
    const guardedId = JSON.stringify({ projectId: 1, sourceTaskId: 1, targetTaskId: 1 });
    const built: string[] = [];
    const db = {
      collection: vi.fn((name: string) => ({
        createIndex: vi.fn((keys: unknown) => {
          built.push(JSON.stringify(keys));

          return Promise.resolve('built');
        }),
        // Only the relationship-edge key reports duplicates; every other
        // collection probes clean. Selected by COLLECTION + the number of
        // resolved group keys, because the previous selector compared the raw
        // `$group._id` against the spec's JSON — which only ever matched
        // because the probe reused the spec verbatim, the very defect being
        // fixed. The edge key is the only 3-key probe on task_relationships.
        aggregate: vi.fn((pipeline: [{ $group: { _id: unknown } }]) => {
          const groupId = pipeline[0]?.$group._id;
          const keyCount =
            typeof groupId === 'object' && groupId !== null && !Array.isArray(groupId)
              ? Object.keys(groupId).length
              : 0;
          const isGuardedEdge = name === 'task_relationships' && keyCount === 3;

          return { toArray: vi.fn().mockResolvedValue(isGuardedEdge ? [{ _id: {}, count: 2 }] : []) };
        }),
      })),
    };

    await ensureCoreIndexes(db as never);

    expect(built).not.toContain(guardedId);
    // …and the additive, duplicate-free part of the backlog was still applied.
    expect(built).toContain(JSON.stringify({ projectId: 1, 'actor.userId': 1, createdAt: -1, _id: -1 }));
    expect(built).toContain(JSON.stringify({ taskId: 1, createdAt: 1 }));
  });

  it('D-10: REJECTS when an index build fails, and still ATTEMPTS every other index', async () => {
    // This assertion used to be the opposite (`resolves.toBeUndefined`,
    // "one bad index never aborts the run") and it pinned the defect: an
    // `IndexOptionsConflict` or a `DuplicateKey` on `users.email` was logged
    // and the deploy went green with the constraint existing only in the source
    // tree. `scripts/migrate.ts` turns this rejection into a non-zero exit, so
    // the CD job fails BEFORE the Worker deploy.
    const createIndex = vi.fn().mockRejectedValue(Object.assign(new Error('IndexOptionsConflict'), { code: 85 }));
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    const db = {
      collection: vi.fn().mockReturnValue({
        createIndex,
        dropIndex,
        aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      }),
    };

    // Every index is still ATTEMPTED: one failure must not hide the state of
    // the others, and the operator needs the full list in one run.
    await expect(ensureCoreIndexes(db as never)).rejects.toThrow(/index build\(s\) failed/);
    expect(createIndex).toHaveBeenCalledTimes(CORE_INDEXES.length);
    expect(createIndex.mock.calls.map((call) => JSON.stringify(call[0]))).toContain(JSON.stringify({ id: 1 }));

    // …and nothing is DROPPED on a failed run: the superseded indexes are
    // still the only ones serving the old sort shape.
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('D-10: the failure names the count AND the reason, so the log is actionable', async () => {
    let call = 0;
    const createIndex = vi.fn().mockImplementation(() => {
      call += 1;

      return call === 1
        ? Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))
        : Promise.resolve('built');
    });
    const db = {
      collection: vi.fn().mockReturnValue({
        createIndex,
        dropIndex: vi.fn().mockResolvedValue(undefined),
        aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      }),
    };

    await expect(ensureCoreIndexes(db as never)).rejects.toThrow(
      /1 of \d+ index build\(s\) failed.*E11000 duplicate key/s,
    );
  });
});

describe('superseded indexes (D-11)', () => {
  /**
   * The ONLY document field MongoDB itself guarantees is unique. A sort whose
   * last key is one of these is a total order, which is the property the audit
   * list's paging needs. A platform guarantee, not a list of this project's
   * fields — the same kind of fact as the 16 MB BSON ceiling.
   */
  const MONGODB_UNIQUE_FIELDS = ['_id'];

  it('every superseded index has a live replacement that is a strict extension of it', () => {
    // A drop with no replacement would leave the query that the old index served
    // unindexed. Derived, not listed: the replacement is found by asking
    // CORE_INDEXES for an entry whose keys are the old keys plus at least one
    // more, so adding a superseding index needs no edit here.
    const orphans = SUPERSEDED_INDEXES.filter(({ collection, spec }) => {
      const oldKeys = JSON.stringify(Object.entries(spec));

      return !CORE_INDEXES.some((entry) => {
        if (entry.collection !== collection) return false;

        const newKeys = JSON.stringify(Object.entries(entry.spec));

        return newKeys.startsWith(oldKeys.slice(0, -1)) && newKeys.length > oldKeys.length;
      });
    }).map(({ collection, spec }) => `${collection}|${indexNameFor(spec)}`);

    expect(orphans).toEqual([]);
  });

  it('a superseded index is not still declared — it would be re-created on every deploy', () => {
    const reDeclared = SUPERSEDED_INDEXES.filter(({ collection, spec }) =>
      CORE_INDEXES.some((entry) => entry.collection === collection && sameKeyOrder(entry.spec, spec)),
    );

    expect(reDeclared).toEqual([]);
  });

  it('D-11: the sort the audit list issues ends on a field MongoDB guarantees unique', () => {
    // The sort spec is READ FROM THE REPOSITORY, not copied here, so a fix
    // written differently still passes and a regression cannot hide behind a
    // stale literal. The property: an order over a field MongoDB guarantees is
    // unique per document (`_id` is the only one) is a TOTAL order, so
    // `.skip()/.limit()` paging over it neither duplicates nor drops a document.
    // `createdAt` alone is a wall-clock millisecond and is not.
    const source = readFileSync(join(REPOSITORY_DIR, 'audit-event.repository.ts'), 'utf8');
    const sort = source.match(/\.sort\(\{([^}]*)\}\)/);

    expect(sort, 'audit-event.repository.ts must still issue exactly one .sort({…})').not.toBeNull();

    const fields = [...(sort?.[1] ?? '').matchAll(/([\w.]+)\s*:/g)].map((match) => match[1]);
    const last = fields[fields.length - 1];

    expect(fields.length, 'the sort must name its keys').toBeGreaterThan(1);
    expect(MONGODB_UNIQUE_FIELDS, `${last} is not a MongoDB-unique field`).toContain(last);
  });

  it('D-11: the sort stays index-served — a declared audit index carries every sort key, in order', () => {
    // Without this the tiebreaker would turn the list sort into a blocking SORT
    // over the whole matched range, which on an append-only collection is worse
    // than the tie it fixes. Derived from the SAME sort spec the test above
    // reads, so the two cannot disagree.
    const source = readFileSync(join(REPOSITORY_DIR, 'audit-event.repository.ts'), 'utf8');
    const sort = source.match(/\.sort\(\{([^}]*)\}\)/);
    const sortFields = [...(sort?.[1] ?? '').matchAll(/([\w.]+)\s*:/g)].map((match) => match[1] as string);
    const serving = CORE_INDEXES.filter((entry) => {
      if (entry.collection !== 'audit_events') return false;

      const keys = Object.keys(entry.spec);

      return sortFields.every((field, i) => keys[keys.length - sortFields.length + i] === field);
    });

    expect(serving.map((entry) => indexNameFor(entry.spec))).not.toEqual([]);
  });

  it('drops each superseded index by the name MongoDB would have given it', async () => {
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    const db = { collection: vi.fn().mockReturnValue({ dropIndex }) };

    await dropSupersededIndexes(db as never);

    expect(dropIndex.mock.calls.map((call) => call[0])).toEqual(
      SUPERSEDED_INDEXES.map(({ spec }) => indexNameFor(spec)),
    );
  });

  it('a re-run is a no-op: an index that is already gone is not a failure', async () => {
    const dropIndex = vi.fn().mockRejectedValue(Object.assign(new Error('index not found'), { code: 27 }));
    const db = { collection: vi.fn().mockReturnValue({ dropIndex }) };

    await expect(dropSupersededIndexes(db as never)).resolves.toBeUndefined();
    expect(dropIndex).toHaveBeenCalledTimes(SUPERSEDED_INDEXES.length);
  });
});

// ─── F11 guardrail: migrations ↔ repositories ─────────────────────────────────

/**
 * The query shapes F11 added an index for, cross-referenced against the
 * repository source that issues them.
 *
 * The point of this file is that the two lists cannot drift apart silently. A
 * query without a supporting index is the exact defect this guardrail exists to prevent
 * (COLLSCANs, blocking SORTs, count-unfriendly prefixes), and nothing about it
 * is visible at runtime — it only shows up as latency. Two assertions make it
 * structural instead:
 *
 *   1. the repository really does filter/sort on those fields (the field literal
 *      is present in the source that owns the query), and
 *   2. a supporting index exists whose key list starts with the equality fields
 *      in the same order, followed by the sort field.
 *
 * Deliberately scoped to the fields F11 touched: a general "every field in every
 * repository must be indexed" check would have to parse arbitrary query
 * construction, which is not what a test can assert honestly.
 */
interface ContractRow {
  repository: string;
  collection: string;
  /**
   * `query` (the default): the repository still runs a query this index serves,
   * and `queryFields` must appear in its CODE (comments stripped).
   * `constraint`: the serving query is gone and the index is retained as a
   * uniqueness constraint, so the pairing this guardrail enforces is "no
   * read-before-write pre-check replaced the index" instead of "the query is
   * still there".
   */
  kind?: 'query' | 'constraint';
  /** Field literals that must appear in the repository source (comments stripped). */
  queryFields: string[];
  /** Equality fields, in index order. */
  equality: string[];
  /** Sort field appended after the equality fields (omit for a pure filter). */
  sort?: string;
  sortDirection?: 1 | -1;
}

const F11_QUERY_CONTRACT: ContractRow[] = [
  // The thread read walks the window NEWEST-FIRST, so the sort is descending
  // while the index below is ascending — a B-tree is traversed in reverse for
  // the opposite direction, and `supportingIndex` accepts exactly that
  // (uniformly negated sort directions) rather than demanding a second index
  // that differs from the ascending one only in its flags.
  {
    repository: 'comment.repository.ts',
    collection: 'comments',
    queryFields: ['{ taskId }', '.sort({ createdAt: -1, _id: -1 })'],
    equality: ['taskId'],
    sort: 'createdAt',
    sortDirection: -1,
  },
  {
    repository: 'sprint.repository.ts',
    collection: 'sprints',
    queryFields: ['{ projectId }', '.sort({ createdAt: -1 })'],
    equality: ['projectId'],
    sort: 'createdAt',
    sortDirection: -1,
  },
  {
    repository: 'status.repository.ts',
    collection: 'statuses',
    queryFields: ['{ projectId }', '.sort({ position: 1 })'],
    equality: ['projectId'],
    sort: 'position',
  },
  {
    repository: 'label.repository.ts',
    collection: 'labels',
    queryFields: ['{ projectId }', '.sort({ name: 1 })'],
    equality: ['projectId'],
    sort: 'name',
  },
  {
    repository: 'task-type.repository.ts',
    collection: 'task_types',
    queryFields: ['{ projectId }', '.sort({ position: 1 })'],
    equality: ['projectId'],
    sort: 'position',
  },
  // The `project.repository.ts / projects / key` contract entry was REMOVED
  // together with `ProjectRepository.findByKey` (dead code) and its index. The
  // remaining project lookups are `findOne({ tenantId, key })` (served by the
  // pre-existing unique `{tenantId, key}`) and `findOne({ id })` (served by
  // `{id: 1}`), neither of which F11 introduced.
  {
    repository: 'user.repository.ts',
    collection: 'users',
    queryFields: ["'passwordReset.tokenHash': tokenHash"],
    equality: ['passwordReset.tokenHash'],
  },
  {
    repository: 'project-member.repository.ts',
    collection: 'project_members',
    queryFields: ['find({ userId })'],
    equality: ['userId'],
  },
  {
    repository: 'task.repository.ts',
    collection: 'tasks',
    queryFields: ['countDocuments({ projectId, typeId }'],
    equality: ['projectId', 'typeId'],
  },
  // The `{tenantId, status}` contract entry was REMOVED together with
  // `TenantMemberRepository.countActiveByTenant` (dead code) and its F11 compound
  // index. The sibling `{userId, role}` counter entry below is kept.
  {
    repository: 'tenant-member.repository.ts',
    collection: 'tenant_members',
    queryFields: ['countDocuments({ userId, role: TenantRole.OWNER })'],
    equality: ['userId', 'role'],
  },
  {
    repository: 'filter.repository.ts',
    collection: 'filters',
    queryFields: ['findOne({ userId, projectId, name })'],
    equality: ['userId', 'projectId', 'name'],
  },
  // F22 deleted the serving query (`findBySourceAndTarget`) as dead code, but
  // the row kept naming it — and kept passing, because the fragment it matched
  // (`sourceTaskId, targetTaskId`) only survives in the comment that documents
  // the deletion. The index stayed deliberately: it IS the duplicate guard
  // `create()` relies on now (F11 + `withConflictOnDuplicate`), so the row
  // became a constraint row. A `constraint` row asserts the index is still the
  // thing preventing the duplicate: no exact-match pre-check reader may exist in
  // the repository, because a pre-check is the race this index was added to
  // close. Comments are stripped, so this cannot be satisfied by documentation.
  {
    kind: 'constraint',
    repository: 'task-relationship.repository.ts',
    collection: 'task_relationships',
    queryFields: [],
    equality: ['projectId', 'sourceTaskId', 'targetTaskId'],
  },
  // The three audit query shapes F11 indexed — one entry per shape, because the
  // index each one needs has a different key list.
  {
    repository: 'audit-event.repository.ts',
    collection: 'audit_events',
    queryFields: ["query['actor.userId'] = options.actorId"],
    equality: ['projectId', 'actor.userId'],
    sort: 'createdAt',
    sortDirection: -1,
  },
  {
    repository: 'audit-event.repository.ts',
    collection: 'audit_events',
    queryFields: ['query.entityId = options.entityId'],
    equality: ['projectId', 'entityId'],
    sort: 'createdAt',
    sortDirection: -1,
  },
  {
    repository: 'audit-event.repository.ts',
    collection: 'audit_events',
    queryFields: ['= { tenantId }'],
    equality: ['tenantId', 'projectId'],
    sort: 'createdAt',
    sortDirection: -1,
  },
];

describe('index coverage guardrail (F11)', () => {
  it('0: the scan actually reads repository sources (a rename must not silently disable it)', () => {
    expect(F11_QUERY_CONTRACT.length).toBeGreaterThan(10);

    for (const entry of F11_QUERY_CONTRACT) {
      const source = readFileSync(join(REPOSITORY_DIR, entry.repository), 'utf8');

      expect(source.length, entry.repository).toBeGreaterThan(0);
    }
  });

  it('1: every query the F11 indexes serve still exists in its repository (comments stripped)', () => {
    const missing: string[] = [];

    for (const entry of F11_QUERY_CONTRACT) {
      // Comments stripped: a deletion note that quotes the query it removed must
      // not keep the row green. One row did exactly that until this change.
      const source = code(readFileSync(join(REPOSITORY_DIR, entry.repository), 'utf8'));

      if (entry.kind === 'constraint') {
        // The index no longer serves a read — it IS the duplicate guard. The
        // pairing it must keep is with the WRITE path: an exact-match pre-check
        // (`findOne` / `findOneAndUpdate` / `countDocuments`) is the
        // check-then-act race the unique index exists to close, so if one is
        // present the index is no longer the guard.
        const preCheck = source.match(/\b(?:findOneAndUpdate|findOne|countDocuments)\s*\(/);

        if (preCheck) {
          missing.push(
            `${entry.repository}: read-before-write pre-check \`${preCheck[0]}\` — the unique index is the guard`,
          );
        }

        continue;
      }

      for (const field of entry.queryFields) {
        if (!source.includes(field)) missing.push(`${entry.repository}: ${field}`);
      }
    }

    // A repository that dropped the query must also drop the index — this
    // failure points at exactly that stale index.
    expect(missing).toEqual([]);
  });

  it('2: every one of those queries has a supporting index with the right key order', () => {
    const unsupported = F11_QUERY_CONTRACT.filter((entry) => supportingIndex(entry) === undefined).map(
      ({ collection, equality, sort }) => `${collection}: ${[...equality, ...(sort ? [sort] : [])].join(' + ')}`,
    );

    expect(unsupported).toEqual([]);
  });

  it('2b: the reverse-traversal match is the ONLY reason the comment page needs no new index', () => {
    // The comment thread is queried `{ createdAt: -1, _id: -1 }` over the
    // equality field `taskId`, and the index in the tree is ascending. A B-tree
    // answers the opposite direction by being traversed backwards, so the index
    // serves the window as it stands; what must not happen is the matcher
    // accepting ANY index with the right field NAMES, which would let a
    // collection that has no usable index at all pass this row.
    const descending: ContractRow = {
      repository: 'comment.repository.ts',
      collection: 'comments',
      queryFields: ['{ taskId }'],
      equality: ['taskId'],
      sort: 'createdAt',
      sortDirection: -1,
    };

    expect(supportingIndex(descending)).toBe(indexId('comments', { taskId: 1, createdAt: 1 }));
    // Same fields, no sort term: a bare `{ taskId }` is a filter index only.
    expect(
      supportingIndex({
        repository: 'comment.repository.ts',
        collection: 'comments',
        queryFields: [],
        equality: ['taskId'],
      }),
    ).toBe(indexId('comments', { taskId: 1 }));
    // A sort the index does not carry at all is still unsupported.
    expect(
      supportingIndex({ ...descending, collection: 'sprints', sort: 'position', sortDirection: -1 }),
    ).toBeUndefined();
  });

  it('3: every F11 index is explained — a declared query it serves, or a uniqueness constraint', () => {
    // The third direction, and the one that was missing: the two directions
    // above both walk CONTRACT → index. Nothing walked index → contract, so an
    // F11 index added for a query nobody declared (or for nothing at all) was
    // invisible: it would be created on every deploy and serve nothing.
    const servedBy = new Set(
      F11_QUERY_CONTRACT.map((entry) => supportingIndex(entry)).filter((id): id is string => id !== undefined),
    );
    const unexplained = F11_INDEXES.filter(
      ({ collection, keys, unique }) => !unique && !servedBy.has(indexId(collection, keys)),
    ).map(({ collection, keys }) => indexId(collection, keys));

    expect(unexplained).toEqual([]);
  });

  it('3b: a contract row is either a served query or a uniqueness constraint — never neither', () => {
    // A row that declares neither would make direction 3 pass vacuously for the
    // index it names, so the two kinds are kept distinct and checked.
    const queryRows = F11_QUERY_CONTRACT.filter((entry) => entry.kind !== 'constraint');

    expect(queryRows.filter((entry) => entry.queryFields.length === 0)).toEqual([]);
    expect(F11_QUERY_CONTRACT.filter((entry) => entry.kind === 'constraint').length).toBeGreaterThan(0);
  });
});

/**
 * The `CORE_INDEXES` entry that supports a contract row — it starts with the
 * row's equality fields in order and either ends there (filter-only) or
 * continues with the row's sort field — or `undefined` when nothing supports it.
 */
function supportingIndex(entry: ContractRow): string | undefined {
  const { collection, equality, sort, sortDirection } = entry;
  const matching = CORE_INDEXES.filter((candidate) => {
    if (candidate.collection !== collection) return false;

    const keys = Object.entries(candidate.spec);
    const prefixMatches = equality.every((field, i) => keys[i]?.[0] === field && keys[i]?.[1] === 1);

    if (!prefixMatches) return false;
    if (!sort) return keys.length >= equality.length;
    if (keys[equality.length]?.[0] !== sort) return false;

    // The sort term may be served either by a matching-direction index or by a
    // reverse traversal of an opposite-direction one: a B-tree is ordered, so
    // the same index answers `{ field: -1 }` by being walked backwards. Only a
    // UNIFORMLY negated direction qualifies — an index is not re-orderable
    // field by field, so `{ taskId: 1, createdAt: 1, number: -1 }` does not
    // serve `{ createdAt: -1, number: 1 }`.
    const indexDirection = keys[equality.length]?.[1];
    const wanted = sortDirection ?? 1;

    return indexDirection === wanted || indexDirection === -wanted;
  });
  // Several indexes can start with the equality fields (`{projectId, typeId}` and
  // `{projectId, typeId, number}` both serve `countDocuments({projectId, typeId})`).
  // The row is about the most specific one, so the shortest match wins — and the
  // choice is deterministic rather than an artefact of declaration order.
  const found = [...matching].sort((a, b) => Object.keys(a.spec).length - Object.keys(b.spec).length)[0];

  return found === undefined ? undefined : indexId(found.collection, found.spec);
}
