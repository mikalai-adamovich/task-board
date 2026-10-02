import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintRepository } from './sprint.repository.js';
import type { SprintDocument } from './sprint.repository.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  } as unknown as Collection<SprintDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<SprintDocument> = {}): SprintDocument {
  return {
    id: 'sprint-123',
    projectId: 'project-1',
    name: 'Sprint 1',
    status: 'FUTURE',
    startDate: new Date('2025-01-01T00:00:00Z'),
    endDate: new Date('2025-01-15T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('SprintRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: SprintRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new SprintRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped sprint when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('sprint-123');

      expect(result?.name).toBe('Sprint 1');
      expect(result?.status).toBe('FUTURE');
      expect(result?.projectId).toBe('project-1');
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('findByProject', () => {
    it('returns all sprints for a project', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc()]);
      // The cursor carries `limit` because the read is bounded — the mock models
      // the whole chain the repository issues.
      const limit = vi.fn().mockReturnValue({ toArray });
      const sort = vi.fn().mockReturnValue({ limit });

      collection.find.mockReturnValue({ sort });

      const result = await repo.findByProject('project-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('creates a sprint with FUTURE status', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create('project-1', {
        name: 'Sprint 1',
        startDate: '2025-01-01',
        endDate: '2025-01-15',
      });

      expect(result.name).toBe('Sprint 1');
      expect(result.status).toBe('FUTURE');
    });
  });

  describe('update', () => {
    it('returns the updated sprint', async () => {
      collection.findOneAndUpdate.mockResolvedValue(makeDoc({ name: 'Updated' }));

      const result = await repo.update('sprint-123', { name: 'Updated' });

      expect(result?.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('returns true when deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('sprint-123');

      expect(result).toBe(true);
    });
  });
});
