import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusRepository } from './status.repository.js';
import type { StatusDocument } from './status.repository.js';
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
  } as unknown as Collection<StatusDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    insertMany: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<StatusDocument> = {}): StatusDocument {
  return {
    id: 'status-123',
    projectId: 'project-1',
    name: 'TODO',
    normalizedName: 'todo',
    position: 0,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('StatusRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: StatusRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new StatusRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped status when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('status-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'status-123' });
      expect(result).toEqual({
        id: 'status-123',
        projectId: 'project-1',
        name: 'TODO',
        normalizedName: 'todo',
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
    it('returns all statuses for a project sorted by position', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([
          makeDoc({ id: 's1', name: 'TODO', position: 0 }),
          makeDoc({ id: 's2', name: 'DONE', normalizedName: 'done', position: 1 }),
        ]);
      // The cursor carries `limit` because the read is bounded — the mock has to
      // model the whole chain the repository issues, not just `sort`/`toArray`.
      const limit = vi.fn().mockReturnValue({ toArray });
      const sort = vi.fn().mockReturnValue({ limit });

      collection.find.mockReturnValue({ sort });

      const result = await repo.findByProject('project-1');

      expect(collection.find).toHaveBeenCalledWith({ projectId: 'project-1' });
      expect(result).toHaveLength(2);
    });
  });

  describe('findByProjectAndNormalizedName', () => {
    it('returns status by project and normalized name', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByProjectAndNormalizedName('project-1', 'todo');

      expect(collection.findOne).toHaveBeenCalledWith({ projectId: 'project-1', normalizedName: 'todo' });
      expect(result?.normalizedName).toBe('todo');
    });
  });

  describe('create', () => {
    it('inserts a document with normalizedName and returns domain status', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create('project-1', { name: 'In Progress', position: 1 });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as StatusDocument;

      expect(insertedDoc.name).toBe('In Progress');
      expect(insertedDoc.normalizedName).toBe('in progress');
      expect(insertedDoc.projectId).toBe('project-1');
      expect(insertedDoc.position).toBe(1);
      expect(insertedDoc.id).toBeDefined();

      expect(result.name).toBe('In Progress');
      expect(result.normalizedName).toBe('in progress');
    });
  });

  describe('createMany', () => {
    it('inserts multiple documents', async () => {
      collection.insertMany.mockResolvedValue({ acknowledged: true, insertedCount: 2 } as never);

      const result = await repo.createMany('project-1', [
        { name: 'TODO', position: 0 },
        { name: 'DONE', position: 1 },
      ]);

      expect(collection.insertMany).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]?.normalizedName).toBe('todo');
      expect(result[1]?.normalizedName).toBe('done');
    });

    it('does not call insertMany for empty array', async () => {
      const result = await repo.createMany('project-1', []);

      expect(collection.insertMany).not.toHaveBeenCalled();
      expect(result).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('returns the updated status', async () => {
      const updated = makeDoc({ name: 'Updated', normalizedName: 'updated' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('status-123', { name: 'Updated', normalizedName: 'updated' });

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'status-123' },
        { $set: { name: 'Updated', normalizedName: 'updated', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.name).toBe('Updated');
    });

    it('returns null when status not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.update('missing', { name: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('status-123');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('missing');

      expect(result).toBe(false);
    });
  });
});
