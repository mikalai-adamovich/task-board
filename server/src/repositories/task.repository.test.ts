import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRepository } from './task.repository.js';
import type { TaskDocument } from './task.repository.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';
import { QUERY_MAX_TIME_MS_BOARD, QUERY_MAX_TIME_MS_LIST } from '../db/query-timeout.js';

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
    bulkWrite: vi.fn(),
  } as unknown as Collection<TaskDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    countDocuments: ReturnType<typeof vi.fn>;
    bulkWrite: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    id: 'task-123',
    projectId: 'project-1',
    number: 1,
    typeId: 'type-1',
    title: 'Test Task',
    description: 'A test task',
    statusId: 'status-1',
    statusName: 'Todo',
    sprintName: null,
    priorityLevel: 1,
    reporterId: 'user-1',
    reporterSnapshot: { displayName: 'Reporter' },
    assigneeId: 'user-2',
    assigneeSnapshot: { displayName: 'Assignee' },
    sprintId: null,
    labelIds: [],
    createdById: 'user-1',
    createdBySnapshot: { displayName: 'Creator' },
    version: 1,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TaskRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: TaskRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new TaskRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped task when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('task-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'task-123' });
      expect(result?.title).toBe('Test Task');
      expect(result?.number).toBe(1);
      expect(result?.version).toBe(1);
      expect(result?.assigneeId).toBe('user-2');
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('findByProject', () => {
    it('returns paginated tasks', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc()]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(1);

      const result = await repo.findByProject('project-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('F5: requests NO projection by default (description included)', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc()]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(1);

      await repo.findByProject('project-1', {});

      expect(collection.find).toHaveBeenCalledWith({ projectId: 'project-1' }, { maxTimeMS: QUERY_MAX_TIME_MS_LIST });
    });

    it('F5: projects description out when excludeDescription is set', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc()]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(1);

      await repo.findByProject('project-1', { excludeDescription: true });

      // `descriptionText` is a plain-text COPY of the description, so it
      // leaves with it. Excluding only `description` would ship the whole body to
      // a caller that asked not to receive it — the exact regression F5 removed.
      expect(collection.find).toHaveBeenCalledWith(
        { projectId: 'project-1' },
        { projection: { description: 0, descriptionText: 0 }, maxTimeMS: QUERY_MAX_TIME_MS_LIST },
      );
    });

    it('view=board projects out every non-card field (description, projectId, reporter, timestamps, metadata)', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc()]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(1);

      await repo.findByProject('project-1', { view: 'board' });

      expect(collection.find).toHaveBeenCalledWith(
        { projectId: 'project-1' },
        {
          projection: {
            description: 0,
            // The projection travels with the description out of a card.
            descriptionText: 0,
            projectId: 0,
            reporterId: 0,
            reporterSnapshot: 0,
            statusName: 0,
            sprintName: 0,
            sprintId: 0,
            labelIds: 0,
            createdById: 0,
            createdBySnapshot: 0,
            createdAt: 0,
            updatedAt: 0,
          },
          maxTimeMS: QUERY_MAX_TIME_MS_LIST,
        },
      );
    });
  });

  /**
   * The "no sprint" (backlog) filter.
   *
   * Two levels of proof:
   *  1. SHAPE — the exact Mongo filter the repository builds for each form.
   *  2. SEMANTICS — a small in-memory matcher applies the produced filter to a
   *     fixture project, proving the sprint set and the backlog set are
   *     DISJOINT and, together with the other sprint, COVER the whole project.
   *     Shape assertions alone would pass even if `sprintId: null` were built
   *     wrongly relative to how documents actually store a missing sprint.
   */
  describe('findByProject — sprint filter (F7)', () => {
    const SPRINT_A = '550e8400-e29b-41d4-a716-4466554400a1';
    const SPRINT_B = '550e8400-e29b-41d4-a716-4466554400a2';

    /**
     * Minimal Mongo matcher for the two filter shapes the repository can emit
     * for the sprint field: an exact id, `null` (equality on a stored null) and
     * `{ $ne: null }`. Anything else throws so a new shape cannot silently pass
     * an un-modelled test.
     */
    function matchesSprintFilter(doc: TaskDocument, filter: unknown): boolean {
      if (filter === undefined) return true;
      if (filter === null) return doc.sprintId === null;
      if (typeof filter === 'string') return doc.sprintId === filter;
      if (typeof filter === 'object' && filter !== null && '$ne' in filter) {
        return (filter as { $ne: unknown }).$ne === null ? doc.sprintId !== null : false;
      }
      throw new Error(`unmodelled sprint filter shape: ${JSON.stringify(filter)}`);
    }

    /** The `{projectId, sprintId}` part of the query the repository handed to Mongo. */
    function sprintFilterOf(query: Record<string, unknown>): unknown {
      return query.sprintId;
    }

    /** The sprint filter of the most recent `find` call — runs one query. */
    function lastSprintFilterOf(options: Parameters<TaskRepository['findByProject']>[1]): unknown {
      selectIds(options);

      const calls = collection.find.mock.calls;

      return sprintFilterOf(calls[calls.length - 1]?.[0] as Record<string, unknown>);
    }

    /**
     * Project fixture: 2 tasks in sprint A, 1 in sprint B, 2 with no sprint.
     * Exercises the real production shape — `sprintId: null` on backlog tasks.
     */
    const PROJECT_DOCS: TaskDocument[] = [
      makeDoc({ id: 'a1', number: 1, sprintId: SPRINT_A, sprintName: 'A' }),
      makeDoc({ id: 'a2', number: 2, sprintId: SPRINT_A, sprintName: 'A' }),
      makeDoc({ id: 'b1', number: 3, sprintId: SPRINT_B, sprintName: 'B' }),
      makeDoc({ id: 'n1', number: 4, sprintId: null, sprintName: null }),
      makeDoc({ id: 'n2', number: 5, sprintId: null, sprintName: null }),
    ];

    /**
     * Ids the repository's filter actually selects from the fixture.
     * `findByProject` is async, but the query is handed to `find` synchronously,
     * so the LAST recorded call reflects THIS invocation.
     */
    function selectIds(options: Parameters<TaskRepository['findByProject']>[1]): string[] {
      const toArray = vi.fn().mockResolvedValue([]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(0);

      void repo.findByProject('project-1', options);

      const calls = collection.find.mock.calls;
      const query = calls[calls.length - 1]?.[0] as Record<string, unknown>;

      return PROJECT_DOCS.filter((doc) => matchesSprintFilter(doc, sprintFilterOf(query))).map((doc) => doc.id);
    }

    it('sprintId=<uuid> selects exactly that sprint tasks', () => {
      expect(selectIds({ sprintId: SPRINT_A })).toEqual(['a1', 'a2']);
    });

    it('hasSprint=false selects exactly the tasks with no sprint', () => {
      expect(selectIds({ hasSprint: false })).toEqual(['n1', 'n2']);
    });

    it('hasSprint=true selects every task in some sprint', () => {
      expect(selectIds({ hasSprint: true })).toEqual(['a1', 'a2', 'b1']);
    });

    it('an absent filter selects the whole project (no sprint filtering)', () => {
      expect(selectIds({})).toEqual(['a1', 'a2', 'b1', 'n1', 'n2']);
    });

    it('DISJOINT + COVER: the sprint set and the backlog set partition the project', () => {
      const sprintA = new Set(selectIds({ sprintId: SPRINT_A }));
      const backlog = new Set(selectIds({ hasSprint: false }));
      const project = new Set(PROJECT_DOCS.map((d) => d.id));

      // Disjoint: no task is in both a sprint and the backlog.
      expect([...sprintA].filter((id) => backlog.has(id))).toEqual([]);

      // Cover: together with the other sprint they account for every task.
      const union = new Set([...sprintA, ...backlog, ...selectIds({ sprintId: SPRINT_B })]);

      expect(union).toEqual(project);
    });

    it('builds `sprintId: null` for the backlog — an equality match, index-served', () => {
      expect(lastSprintFilterOf({ hasSprint: false })).toBeNull();
    });

    it('builds `sprintId: { $ne: null }` for hasSprint=true', () => {
      expect(lastSprintFilterOf({ hasSprint: true })).toEqual({ $ne: null });
    });

    it('builds the plain equality filter for a sprint uuid', () => {
      expect(lastSprintFilterOf({ sprintId: SPRINT_A })).toBe(SPRINT_A);
    });

    it('sprintId wins over hasSprint when both reach the repository (schema rejects the pair first)', () => {
      // Defence in depth: the Zod refine already 400s this combination, so the
      // repository only has to stay deterministic.
      expect(selectIds({ sprintId: SPRINT_A, hasSprint: false })).toEqual(['a1', 'a2']);
    });

    it('applies the sprint filter to the countDocuments query too (pagination total matches the data)', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc({ id: 'n1', sprintId: null })]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(2);

      const result = await repo.findByProject('project-1', { hasSprint: false, limit: 1 });

      expect(collection.countDocuments).toHaveBeenCalledWith(
        { projectId: 'project-1', sprintId: null },
        { maxTimeMS: QUERY_MAX_TIME_MS_LIST },
      );
      expect(result.pagination.total).toBe(2);
    });

    it('composes with other filters and the project scope', async () => {
      const toArray = vi.fn().mockResolvedValue([]);
      const limit = vi.fn().mockReturnValue({ toArray });
      const skip = vi.fn().mockReturnValue({ limit });
      const sort = vi.fn().mockReturnValue({ skip });

      collection.find.mockReturnValue({ sort });
      collection.countDocuments.mockResolvedValue(0);

      await repo.findByProject('project-9', { hasSprint: false, statusId: 'status-1' });

      expect(collection.find).toHaveBeenCalledWith(
        { projectId: 'project-9', statusId: 'status-1', sprintId: null },
        { maxTimeMS: QUERY_MAX_TIME_MS_LIST },
      );
    });
  });

  describe('bulkUpdateWithVersion (TOP-3 №1)', () => {
    it('issues exactly ONE bulkWrite (ordered:false) with per-task {id, version} filters and $inc — no findOneAndUpdate', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc({ version: 2 })]);

      collection.find.mockReturnValue({ toArray });
      collection.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      await repo.bulkUpdateWithVersion(
        [
          { id: 'task-123', version: 1 },
          { id: 'task-456', version: 4 },
        ],
        { statusId: 'status-2', statusName: 'Done' },
      );

      expect(collection.bulkWrite).toHaveBeenCalledTimes(1);
      expect(collection.findOneAndUpdate).not.toHaveBeenCalled();

      const [ops, options] = collection.bulkWrite.mock.calls[0] ?? [];

      expect(options).toEqual({ ordered: false });
      expect(ops).toHaveLength(2);
      expect(ops[0]).toEqual({
        updateOne: {
          filter: { id: 'task-123', version: 1 },
          update: {
            $set: { statusId: 'status-2', statusName: 'Done', updatedAt: expect.any(Date) },
            $inc: { version: 1 },
          },
        },
      });
    });

    it('returns only the tasks whose version was incremented (conflicts are absent)', async () => {
      // $or filter by {id, version+1}: only the incremented doc comes back
      const toArray = vi.fn().mockResolvedValue([makeDoc({ id: 'task-123', version: 2 })]);

      collection.find.mockReturnValue({ toArray });
      collection.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const result = await repo.bulkUpdateWithVersion(
        [
          { id: 'task-123', version: 1 },
          { id: 'task-conflict', version: 5 },
        ],
        { priorityLevel: 2 },
      );

      expect(collection.find).toHaveBeenCalledWith({
        $or: [
          { id: 'task-123', version: 2 },
          { id: 'task-conflict', version: 6 },
        ],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.version).toBe(2);
    });

    it('is a no-op for an empty batch — no bulkWrite issued', async () => {
      const result = await repo.bulkUpdateWithVersion([], { priorityLevel: 2 });

      expect(result).toEqual([]);
      expect(collection.bulkWrite).not.toHaveBeenCalled();
    });
  });

  describe('findAssignedTo (audit #3: /tasks/my)', () => {
    function chain(docs: TaskDocument[]) {
      const toArray = vi.fn().mockResolvedValue(docs);
      const limit = vi.fn().mockReturnValue({ toArray });
      const sort = vi.fn().mockReturnValue({ limit });

      collection.find.mockReturnValue({ sort });

      return { toArray, limit, sort };
    }

    it('filters by assigneeId AND the membership scope, sorts by updatedAt desc and applies the minimal projection', async () => {
      const { sort, limit } = chain([makeDoc()]);

      await repo.findAssignedTo('user-9', ['project-1', 'project-2']);

      expect(collection.find).toHaveBeenCalledWith(
        { assigneeId: 'user-9', projectId: { $in: ['project-1', 'project-2'] } },
        {
          projection: {
            id: 1,
            projectId: 1,
            number: 1,
            title: 1,
            priorityLevel: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          maxTimeMS: QUERY_MAX_TIME_MS_LIST,
        },
      );
      expect(sort).toHaveBeenCalledWith({ updatedAt: -1 });
      expect(limit).toHaveBeenCalledWith(50);
    });

    it('D-17: an EMPTY membership scope matches nothing — a user id alone cannot reach a task', () => {
      // The property, stated as a query: there is no call shape in which the
      // assignee predicate stands alone. `$in: []` is MongoDB's "matches no
      // document", so a caller with no readable tenant gets an empty page
      // rather than every task ever assigned to them.
      chain([]);

      repo.findAssignedTo('user-9', []);

      const [filter] = collection.find.mock.calls[0] as [Record<string, unknown>];

      expect(filter).toHaveProperty('projectId');
      expect(filter).toEqual({ assigneeId: 'user-9', projectId: { $in: [] } });
    });

    it('maps projected documents — fields outside the projection are simply absent', async () => {
      const projected = {
        id: 'task-123',
        projectId: 'project-1',
        number: 7,
        title: 'Widget Task',
        priorityLevel: 2,
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-02T00:00:00Z'),
      } as unknown as TaskDocument;

      chain([projected]);

      const result = await repo.findAssignedTo('user-9', ['project-1']);

      expect(result).toHaveLength(1);

      const [task] = result;

      expect(task?.title).toBe('Widget Task');
      expect(task?.priorityLevel).toBe(2);
      // Excluded fields (description, snapshots, …) are not part of the response.
      expect(task?.description).toBeUndefined();
      expect(task?.assigneeSnapshot).toBeUndefined();
    });

    it('honours a custom limit', async () => {
      const { limit } = chain([]);

      await repo.findAssignedTo('user-9', ['project-1'], 10);

      expect(limit).toHaveBeenCalledWith(10);
    });
  });

  describe('create', () => {
    it('creates a task with version 1', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({
        projectId: 'project-1',
        number: 1,
        typeId: 'type-1',
        title: 'New Task',
        statusId: 'status-1',
        priorityLevel: 2,
        createdById: 'user-1',
        createdBySnapshot: { displayName: 'Creator' },
      });

      expect(result.title).toBe('New Task');
      expect(result.version).toBe(1);
    });
  });

  describe('updateWithVersion', () => {
    it('returns updated task on version match', async () => {
      collection.findOneAndUpdate.mockResolvedValue(makeDoc({ title: 'Updated', version: 2 }));

      const result = await repo.updateWithVersion('task-123', 1, { title: 'Updated' });

      expect(result?.title).toBe('Updated');
      expect(result?.version).toBe(2);
    });

    it('returns null on version mismatch', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.updateWithVersion('task-123', 999, { title: 'Updated' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('task-123');

      expect(result).toBe(true);
    });
  });

  describe('countByStatus', () => {
    it('returns count of tasks with status', async () => {
      collection.countDocuments.mockResolvedValue(5);

      const result = await repo.countByStatus('project-1', 'status-1');

      expect(result).toBe(5);
    });
  });

  describe('updateManyByStatus', () => {
    it('updates status on all matching tasks', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 3, modifiedCount: 3 } as never);

      await repo.updateManyByStatus('project-1', 'old-status', 'new-status');

      expect(collection.updateMany).toHaveBeenCalled();
    });
  });

  describe('countByType', () => {
    it('returns count of tasks with type', async () => {
      collection.countDocuments.mockResolvedValue(3);

      const result = await repo.countByType('project-1', 'type-1');

      expect(result).toBe(3);
    });
  });

  describe('updateManyByType', () => {
    it('updates type on all matching tasks', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 } as never);

      await repo.updateManyByType('project-1', 'old-type', 'new-type');

      expect(collection.updateMany).toHaveBeenCalled();
    });
  });

  describe('removeLabelFromAll', () => {
    it('removes label from all tasks', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

      await repo.removeLabelFromAll('project-1', 'label-1');

      expect(collection.updateMany).toHaveBeenCalled();
    });
  });

  describe('clearSprintFromTasks', () => {
    it('sets sprintId to null on all matching tasks', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 } as never);

      await repo.clearSprintFromTasks('project-1', 'sprint-1');

      expect(collection.updateMany).toHaveBeenCalled();
    });
  });

  describe('findBoardPage (board column keyset pagination)', () => {
    function chain(docs: ReturnType<typeof makeDoc>[]) {
      const toArray = vi.fn().mockResolvedValue(docs);
      const limit = vi.fn().mockReturnValue({ toArray });
      const sort = vi.fn().mockReturnValue({ limit });

      collection.find.mockReturnValue({ sort });

      return { toArray, limit, sort };
    }

    function makePageDocs(count: number, startNumber = 1): ReturnType<typeof makeDoc>[] {
      return Array.from({ length: count }, (_, i) =>
        makeDoc({ id: `task-${startNumber + i}`, number: startNumber + i, priorityLevel: 2 }),
      );
    }

    const BOARD_PROJECTION = {
      description: 0,
      // The plain-text projection is excluded with the description.
      descriptionText: 0,
      projectId: 0,
      reporterId: 0,
      reporterSnapshot: 0,
      statusName: 0,
      sprintName: 0,
      sprintId: 0,
      labelIds: 0,
      createdById: 0,
      createdBySnapshot: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    it('queries the fixed 50-card page with a 51 probe, board sort and projection', async () => {
      const { limit, sort } = chain(makePageDocs(51));
      const result = await repo.findBoardPage('project-1', { statusIds: ['status-1', 'status-2'] });

      expect(collection.find).toHaveBeenCalledWith(
        { projectId: 'project-1', statusId: { $in: ['status-1', 'status-2'] } },
        { projection: BOARD_PROJECTION, maxTimeMS: QUERY_MAX_TIME_MS_BOARD },
      );
      expect(sort).toHaveBeenCalledWith({ priorityLevel: -1, number: 1 });
      expect(limit).toHaveBeenCalledWith(51);
      expect(result.tasks).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toEqual({ priorityLevel: 2, number: 50 });
    });

    it('returns hasMore=false with the tail cursor on a short page', async () => {
      chain(makePageDocs(37, 100));

      const result = await repo.findBoardPage('project-1', { statusIds: ['status-1'] });

      expect(result.tasks).toHaveLength(37);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toEqual({ priorityLevel: 2, number: 136 });
    });

    it('returns an empty page with a null cursor when nothing matches', async () => {
      chain([]);

      const result = await repo.findBoardPage('project-1', { statusIds: ['status-1'] });

      expect(result).toEqual({ tasks: [], hasMore: false, nextCursor: null });
    });

    it('applies the keyset cursor predicate for follow-up pages', async () => {
      chain(makePageDocs(10));

      await repo.findBoardPage('project-1', {
        statusIds: ['status-1'],
        cursor: { priorityLevel: 2, number: 184 },
      });

      expect(collection.find).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          statusId: { $in: ['status-1'] },
          $or: [{ priorityLevel: { $lt: 2 } }, { priorityLevel: 2, number: { $gt: 184 } }],
        },
        { projection: BOARD_PROJECTION, maxTimeMS: QUERY_MAX_TIME_MS_BOARD },
      );
    });

    it('forwards board filters into the query', async () => {
      chain([]);

      await repo.findBoardPage('project-1', {
        statusIds: ['status-1'],
        sprintId: 'sprint-1',
        assigneeId: 'user-2',
        priorityLevel: 3,
      });

      expect(collection.find).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          statusId: { $in: ['status-1'] },
          sprintId: 'sprint-1',
          assigneeId: 'user-2',
          priorityLevel: 3,
        },
        { projection: BOARD_PROJECTION, maxTimeMS: QUERY_MAX_TIME_MS_BOARD },
      );
    });

    it('skips the round-trip for an empty status list', async () => {
      const result = await repo.findBoardPage('project-1', { statusIds: [] });

      expect(collection.find).not.toHaveBeenCalled();
      expect(result).toEqual({ tasks: [], hasMore: false, nextCursor: null });
    });

    it('never counts or skips on the board path', async () => {
      chain(makePageDocs(5));

      await repo.findBoardPage('project-1', { statusIds: ['status-1'] });

      expect(collection.countDocuments).not.toHaveBeenCalled();
    });
  });
});
