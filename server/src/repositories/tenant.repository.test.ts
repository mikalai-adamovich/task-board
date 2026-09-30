import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantRepository } from './tenant.repository.js';
import type { TenantDocument } from './tenant.repository.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  } as unknown as Collection<TenantDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<TenantDocument> = {}): TenantDocument {
  return {
    id: 'tenant-123',
    name: 'Test Tenant',
    slug: 'test-tenant',
    description: null,
    status: 'ACTIVE',
    deletionScheduledAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TenantRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: TenantRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new TenantRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped tenant when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('tenant-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'tenant-123' });
      expect(result).toEqual({
        id: 'tenant-123',
        name: 'Test Tenant',
        slug: 'test-tenant',
        description: null,
        status: 'ACTIVE',
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

  // The `findAll` block moved with the method — `findAll()` was dead code
  // (an unscoped cross-tenant `find()` with no caller).

  describe('create', () => {
    it('inserts a document with ACTIVE status and returns the domain tenant', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({ name: 'New Tenant', slug: 'new-tenant' });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as TenantDocument;

      expect(insertedDoc.name).toBe('New Tenant');
      expect(insertedDoc.status).toBe('ACTIVE');
      expect(insertedDoc.deletionScheduledAt).toBeNull();
      expect(insertedDoc.id).toBeDefined();
      expect(insertedDoc.createdAt).toBeInstanceOf(Date);
      expect(insertedDoc.updatedAt).toBeInstanceOf(Date);

      expect(result.name).toBe('New Tenant');
      expect(result.status).toBe('ACTIVE');
      expect(result.deletionScheduledAt).toBeNull();
      // Domain object should have ISO string dates
      expect(typeof result.createdAt).toBe('string');
    });
  });

  describe('update', () => {
    it('returns the updated tenant', async () => {
      const updated = makeDoc({ name: 'Updated' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('tenant-123', { name: 'Updated' });

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'tenant-123' },
        { $set: { name: 'Updated', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.name).toBe('Updated');
    });

    it('can update status and deletionScheduledAt', async () => {
      const deletionDate = new Date('2025-02-01T00:00:00Z');
      const updated = makeDoc({ status: 'DELETION_PENDING', deletionScheduledAt: deletionDate });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('tenant-123', {
        status: 'DELETION_PENDING',
        deletionScheduledAt: deletionDate,
      });

      expect(result?.status).toBe('DELETION_PENDING');
      expect(result?.deletionScheduledAt).toBe('2025-02-01T00:00:00.000Z');
    });

    it('returns null when tenant not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.update('missing', { name: 'X' });

      expect(result).toBeNull();
    });
  });

  // The `findBySlug` block moved with the method — `findBySlug()` was dead
  // code (a global lookup by a conventionally-unique value, no caller).

  describe('slugExists', () => {
    it('returns true when a tenant claims the slug', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      await expect(repo.slugExists('test-tenant')).resolves.toBe(true);
    });

    it('returns false when the slug is free', async () => {
      collection.findOne.mockResolvedValue(null);

      await expect(repo.slugExists('free-slug')).resolves.toBe(false);
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('tenant-123');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('missing');

      expect(result).toBe(false);
    });
  });
});
