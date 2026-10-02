import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskTypeRepository } from './task-type.repository.js';
import type { TaskTypeDocument } from './task-type.repository.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    insertMany: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  } as unknown as Collection<TaskTypeDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    insertMany: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<TaskTypeDocument> = {}): TaskTypeDocument {
  return {
    id: 'type-123',
    projectId: 'project-1',
    key: 'TASK',
    name: 'Task',
    icon: '📋',
    position: 0,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TaskTypeRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: TaskTypeRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new TaskTypeRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped task type when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('type-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'type-123' });
      expect(result).toEqual({
        id: 'type-123',
        projectId: 'project-1',
        key: 'TASK',
        name: 'Task',
        icon: '📋',
        position: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('findByProject', () => {
    it('returns all task types for a project sorted by position', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([makeDoc({ id: 't1', key: 'TASK' }), makeDoc({ id: 't2', key: 'BUG' })]);
      // The cursor carries `limit` because the read is bounded — the mock models
      // the whole chain the repository issues.
      const limit = vi.fn().mockReturnValue({ toArray });
      const sort = vi.fn().mockReturnValue({ limit });

      collection.find.mockReturnValue({ sort });

      const result = await repo.findByProject('project-1');

      expect(collection.find).toHaveBeenCalledWith({ projectId: 'project-1' });
      expect(result).toHaveLength(2);
    });
  });

  describe('findByProjectAndKey', () => {
    it('returns task type by project and key', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByProjectAndKey('project-1', 'TASK');

      expect(collection.findOne).toHaveBeenCalledWith({ projectId: 'project-1', key: 'TASK' });
      expect(result?.key).toBe('TASK');
    });
  });

  describe('create', () => {
    it('inserts a document and returns domain task type', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create('project-1', { key: 'BUG', name: 'Bug', icon: '🐛', position: 1 });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as TaskTypeDocument;

      expect(insertedDoc.key).toBe('BUG');
      expect(insertedDoc.name).toBe('Bug');
      expect(insertedDoc.icon).toBe('🐛');
      expect(insertedDoc.projectId).toBe('project-1');

      expect(result.key).toBe('BUG');
      expect(result.name).toBe('Bug');
    });
  });

  describe('createMany', () => {
    it('inserts multiple documents', async () => {
      collection.insertMany.mockResolvedValue({ acknowledged: true, insertedCount: 2 } as never);

      const result = await repo.createMany('project-1', [
        { key: 'TASK', name: 'Task', icon: '📋', position: 0 },
        { key: 'BUG', name: 'Bug', icon: '🐛', position: 1 },
      ]);

      expect(collection.insertMany).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('returns the updated task type', async () => {
      const updated = makeDoc({ name: 'Updated' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('type-123', { name: 'Updated' });

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'type-123' },
        { $set: { name: 'Updated', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.name).toBe('Updated');
    });

    it('returns null when task type not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.update('missing', { name: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('type-123');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('missing');

      expect(result).toBe(false);
    });
  });
});
