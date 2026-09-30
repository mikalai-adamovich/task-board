/**
 * The search projection's GUARDRAIL.
 *
 * `markdown-plain-text.test.ts` proves the projection function is correct. This
 * proves the two things that actually make it matter, and both are invisible
 * from the function alone:
 *
 *   1. **The projection is written on every save.** The projection is derived in
 *      the REPOSITORY, not in a service, because a service that forgets is a task
 *      whose description is invisible to search — with no error and no log. The
 *      assertion is on the write itself, not on a helper.
 *
 *   2. **The search regex runs over the projection.** This is the defect. A
 *      regression here is silent in the direction that matters: a search that
 *      matched the Markdown source again would still return results, just the
 *      wrong ones, and every test that only checks "search returns something"
 *      would stay green.
 *
 * A third assertion is deliberately included because it is easy to get wrong in
 * the fixing direction: the projection must not LEAK into a response. It is a
 * server-side search index, and a board card or a list row that ships it would
 * undo the payload work F5 did.
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskRepository, type TaskDocument } from './task.repository.js';
import { QUERY_MAX_TIME_MS_LIST } from '../db/query-timeout.js';

/** The repository only needs a snapshot's display name, but the type is exact. */
const IDENTITY = { id: 'user-1', displayName: 'Ann' };

function makeDoc(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    id: 'task-1',
    projectId: 'project-1',
    number: 1,
    typeId: 'type-1',
    title: 'A task',
    description: null,
    descriptionText: '',
    statusId: 'status-1',
    statusName: 'To Do',
    sprintName: null,
    priorityLevel: 1,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'user-1',
    createdBySnapshot: IDENTITY,
    version: 1,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A collection stub that records what the repository asked of it. */
function fakeCollection(overrides: Record<string, unknown> = {}) {
  const find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const findOneAndUpdate = vi.fn().mockResolvedValue(makeDoc());
  const countDocuments = vi.fn().mockResolvedValue(0);
  const aggregate = vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

  return {
    collection: { find, insertOne, findOneAndUpdate, countDocuments, aggregate, ...overrides },
    find,
    insertOne,
    findOneAndUpdate,
  };
}

describe('N-5 — the projection is written on every save', () => {
  it('create derives it from the Markdown description', async () => {
    const { collection, insertOne } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.create({
      projectId: 'project-1',
      number: 1,
      typeId: 'type-1',
      title: 'A task',
      description: '**Bold** text',
      statusId: 'status-1',
      priorityLevel: 1,
      createdById: 'user-1',
      createdBySnapshot: IDENTITY,
    });

    const inserted = insertOne.mock.calls[0]?.[0] as TaskDocument;

    // The Markdown is preserved (the editor's contract) AND the projection is
    // written. Losing the first would break the editor; losing the second is the
    // defect.
    expect(inserted.description).toBe('**Bold** text');
    expect(inserted.descriptionText).toBe('Bold text');
  });

  it('create writes an empty projection for a task with no description', async () => {
    const { collection, insertOne } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.create({
      projectId: 'project-1',
      number: 1,
      typeId: 'type-1',
      title: 'A task',
      statusId: 'status-1',
      priorityLevel: 1,
      createdById: 'user-1',
      createdBySnapshot: IDENTITY,
    });

    expect((insertOne.mock.calls[0]?.[0] as TaskDocument).descriptionText).toBe('');
  });

  it('update re-derives it whenever the description is in the payload', async () => {
    const { collection, findOneAndUpdate } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.updateWithVersion('task-1', 1, { description: 'a [link](https://example.com)' });

    const $set = (findOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;

    expect($set.description).toBe('a [link](https://example.com)');
    expect($set.descriptionText).toBe('a link');
  });

  it('a payload WITHOUT a description leaves the stored projection alone', async () => {
    // Re-deriving unconditionally would blank the projection of every task whose
    // status, assignee or label was edited — a far worse search regression than
    // the one being fixed, and one no "search returns results" test would catch.
    const { collection, findOneAndUpdate } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.updateWithVersion('task-1', 1, { statusId: 'status-2' });

    const $set = (findOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;

    expect($set).not.toHaveProperty('descriptionText');
  });

  it('the bulk path applies the same rule', async () => {
    const bulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const { collection } = fakeCollection({ bulkWrite });
    const repo = new TaskRepository(collection as never);

    await repo.bulkUpdateWithVersion([{ id: 'task-1', version: 1 }], { description: '# Heading' });

    // The assertion is on the bulkWrite payload, which is where the rule lives —
    // not on the documents read back afterwards, which the fake would let pass
    // regardless of what was written.
    const ops = bulkWrite.mock.calls[0]?.[0] as { updateOne: { update: { $set: Record<string, unknown> } } }[];

    expect(ops[0]?.updateOne.update.$set.descriptionText).toBe('Heading');
  });
});

describe('N-5 — the search regex runs over the projection', () => {
  async function searchQuery(search: string) {
    const { collection, find } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.findByProject('project-1', { page: 1, limit: 20, search });

    return find.mock.calls[0]?.[0] as { $or: Record<string, unknown>[] };
  }

  it('matches the plain-text projection', async () => {
    const query = await searchQuery('bold text');

    expect(query.$or).toContainEqual({ descriptionText: { $regex: 'bold text', $options: 'i' } });
  });

  it('does NOT match the Markdown source for a document that has a projection', async () => {
    const query = await searchQuery('bold text');

    // The defect, in its exact shape: before, this branch matched the raw
    // `description` and a description stored as `**bold** text` was unfindable by
    // the phrase on screen.
    expect(query.$or.some((clause) => 'description' in clause && !('descriptionText' in clause))).toBe(false);
  });

  it('falls back to the source ONLY for a document with no projection yet', async () => {
    // The transitional branch. It is bounded by the backfill migration and is the
    // reason a task saved between the code shipping and the backfill running does
    // not become unsearchable. It is asserted explicitly so that widening it (by
    // dropping the `$exists: false` guard) is a visible change.
    const query = await searchQuery('bold text');

    expect(query.$or).toContainEqual({
      description: { $regex: 'bold text', $options: 'i' },
      descriptionText: { $exists: false },
    });
  });

  it('still matches the title and the three identity snapshots', async () => {
    const query = await searchQuery('ann');

    expect(query.$or).toContainEqual({ title: { $regex: 'ann', $options: 'i' } });
    expect(query.$or).toContainEqual({ 'createdBySnapshot.displayName': { $regex: 'ann', $options: 'i' } });
    expect(query.$or).toContainEqual({ 'assigneeSnapshot.displayName': { $regex: 'ann', $options: 'i' } });
    expect(query.$or).toContainEqual({ 'reporterSnapshot.displayName': { $regex: 'ann', $options: 'i' } });
  });

  it('escapes the search term, so a regex metacharacter cannot reach MongoDB', async () => {
    const query = await searchQuery('a.*b');

    expect(query.$or).toContainEqual({ descriptionText: { $regex: 'a\\.\\*b', $options: 'i' } });
  });
});

describe('N-5 — the projection never reaches a response', () => {
  it('the board projection excludes it alongside the description', async () => {
    const { collection, find } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.findByProject('project-1', { page: 1, limit: 20, view: 'board' });

    const options = find.mock.calls[0]?.[1] as { projection: Record<string, 0>; maxTimeMS: number };

    // Both, or the payload work F5 did is undone: the projection is a full copy
    // of the body, so excluding the description alone saves nothing.
    expect(options.projection.description).toBe(0);
    expect(options.projection.descriptionText).toBe(0);
    expect(options.maxTimeMS).toBe(QUERY_MAX_TIME_MS_LIST);
  });

  it('the lightweight list projection excludes it too', async () => {
    const { collection, find } = fakeCollection();
    const repo = new TaskRepository(collection as never);

    await repo.findByProject('project-1', { page: 1, limit: 20, excludeDescription: true });

    const options = find.mock.calls[0]?.[1] as { projection: Record<string, 0> };

    expect(options.projection).toEqual({ description: 0, descriptionText: 0 });
  });

  it('the domain object does not carry it, even when the document has it', async () => {
    // The strongest form of the same rule: the projection is not part of the `Task`
    // contract, so a read that returns a document carrying the field still cannot
    // hand it to a consumer. Driven through a real read rather than the protected
    // mapper, because calling `toDomain` directly would prove nothing about the
    // path a consumer actually takes.
    const findOne = vi.fn().mockResolvedValue(makeDoc({ descriptionText: 'bold text' }));
    const { collection } = fakeCollection({ findOne });
    const repo = new TaskRepository(collection as never);
    const task = await repo.findByProjectAndNumber('project-1', 1);

    expect(task).not.toBeNull();
    expect(Object.keys(task ?? {})).not.toContain('descriptionText');
  });
});
