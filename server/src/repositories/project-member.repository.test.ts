import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectMemberRepository } from './project-member.repository.js';
import type { ProjectMemberDocument } from './project-member.repository.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  } as unknown as Collection<ProjectMemberDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<ProjectMemberDocument> = {}): ProjectMemberDocument {
  return {
    id: 'pmember-1',
    userId: 'user-1',
    projectId: 'project-1',
    role: 'PROJECT_ADMIN',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ProjectMemberRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: ProjectMemberRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new ProjectMemberRepository(collection);
  });

  describe('findByUserAndProject', () => {
    it('returns a mapped member when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByUserAndProject('user-1', 'project-1');

      expect(collection.findOne).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'project-1' });
      expect(result).toEqual({
        id: 'pmember-1',
        userId: 'user-1',
        projectId: 'project-1',
        role: 'PROJECT_ADMIN',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findByUserAndProject('project-1', 'missing');

      expect(result).toBeNull();
    });
  });

  describe('findByProject', () => {
    it('returns all members of a project', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([
          makeDoc({ userId: 'user-1', role: 'PROJECT_ADMIN' }),
          makeDoc({ id: 'pm-2', userId: 'user-2', role: 'EDITOR' }),
        ]);

      // The cursor carries `limit` because the read is bounded — the mock models
      // the whole chain the repository issues.
      collection.find.mockReturnValue({ limit: vi.fn().mockReturnValue({ toArray }) });

      const result = await repo.findByProject('project-1');

      expect(collection.find).toHaveBeenCalledWith({ projectId: 'project-1' });
      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe('PROJECT_ADMIN');
      expect(result[1]?.role).toBe('EDITOR');
    });
  });

  describe('findByUser', () => {
    it('returns all project memberships for a user', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([makeDoc({ projectId: 'p1' }), makeDoc({ projectId: 'p2', role: 'VIEWER' })]);

      collection.find.mockReturnValue({ limit: vi.fn().mockReturnValue({ toArray }) });

      const result = await repo.findByUser('user-1');

      expect(collection.find).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(result).toHaveLength(2);
    });
  });

  describe('create', () => {
    it('inserts a document and returns the domain member', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({
        userId: 'user-1',
        projectId: 'project-1',
        role: 'PROJECT_ADMIN',
      });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as ProjectMemberDocument;

      expect(insertedDoc.userId).toBe('user-1');
      expect(insertedDoc.projectId).toBe('project-1');
      expect(insertedDoc.role).toBe('PROJECT_ADMIN');
      expect(insertedDoc.createdAt).toBeInstanceOf(Date);
      expect(insertedDoc.updatedAt).toBeInstanceOf(Date);
      expect(insertedDoc.id).toBeDefined();

      expect(result.role).toBe('PROJECT_ADMIN');
      expect(typeof result.createdAt).toBe('string');
    });
  });

  describe('updateRole', () => {
    it('returns the updated member', async () => {
      const updated = makeDoc({ role: 'VIEWER' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.updateRole('project-1', 'user-1', 'VIEWER');

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: 'user-1', projectId: 'project-1' },
        { $set: { role: 'VIEWER', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.role).toBe('VIEWER');
    });

    it('returns null when member not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.updateRole('project-1', 'missing', 'VIEWER');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('project-1', 'user-1');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('project-1', 'missing');

      expect(result).toBe(false);
    });
  });
});
