import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectRepository } from './project.repository.js';
import type { ProjectDocument } from './project.repository.js';
import { MAX_PROJECTS_PER_TENANT } from '../db/read-bounds.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  } as unknown as Collection<ProjectDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    id: 'project-123',
    tenantId: 'tenant-1',
    key: 'TEST',
    name: 'Test Project',
    description: 'A test project',
    status: 'ACTIVE',
    defaultStatusId: 'status-1',
    archiveReason: null,
    deletionScheduledAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ProjectRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: ProjectRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new ProjectRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped project when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('project-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'project-123' });
      expect(result).toEqual({
        id: 'project-123',
        tenantId: 'tenant-1',
        key: 'TEST',
        name: 'Test Project',
        description: 'A test project',
        status: 'ACTIVE',
        defaultStatusId: 'status-1',
        archiveReason: null,
        deletionScheduledAt: null,
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

  describe('findByTenant', () => {
    it('returns all projects for a tenant, under the row bound', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([
          makeDoc({ id: 'p1', name: 'Project 1' }),
          makeDoc({ id: 'p2', name: 'Project 2', key: 'PR2' }),
        ]);
      const limit = vi.fn(() => ({ toArray }));

      collection.find.mockReturnValue({ limit });

      const result = await repo.findByTenant('tenant-1');

      expect(collection.find).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      // The bound is part of the contract, not an implementation detail: this
      // list grows with the workspace's whole history.
      expect(limit).toHaveBeenCalledWith(MAX_PROJECTS_PER_TENANT);
      expect(result).toHaveLength(2);
    });
  });

  describe('findByTenantAndKey', () => {
    it('returns project by tenant and key', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByTenantAndKey('tenant-1', 'TEST');

      expect(collection.findOne).toHaveBeenCalledWith({ tenantId: 'tenant-1', key: 'TEST' });
      expect(result?.key).toBe('TEST');
    });
  });

  describe('create', () => {
    it('inserts a document and returns the domain project', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create('tenant-1', {
        key: 'TEST',
        name: 'New Project',
      });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as ProjectDocument;

      expect(insertedDoc.name).toBe('New Project');
      expect(insertedDoc.key).toBe('TEST');
      expect(insertedDoc.tenantId).toBe('tenant-1');
      expect(insertedDoc.status).toBe('ACTIVE');
      expect(insertedDoc.description).toBeNull();
      expect(insertedDoc.id).toBeDefined();

      expect(result.name).toBe('New Project');
      expect(result.key).toBe('TEST');
      expect(result.status).toBe('ACTIVE');
      expect(typeof result.createdAt).toBe('string');
    });
  });

  describe('update', () => {
    it('returns the updated project', async () => {
      const updated = makeDoc({ name: 'Updated' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('project-123', { name: 'Updated' });

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'project-123' },
        { $set: { name: 'Updated', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.name).toBe('Updated');
    });

    it('returns null when project not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.update('missing', { name: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('project-123');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('missing');

      expect(result).toBe(false);
    });
  });
});
