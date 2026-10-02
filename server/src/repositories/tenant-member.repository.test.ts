import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantMemberRepository } from './tenant-member.repository.js';
import type { TenantMemberDocument } from './tenant-member.repository.js';
import { MAX_INVITATIONS_PER_EMAIL } from '../db/read-bounds.js';
import type { Collection, InsertOneResult, DeleteResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    countDocuments: vi.fn(),
  } as unknown as Collection<TenantMemberDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    countDocuments: ReturnType<typeof vi.fn>;
  };
}

/**
 * A minimal chainable cursor: `find(...).sort(...).limit(...).toArray()`.
 * `findByTenant` sorts and every list read is bounded, so the mock has to carry
 * the whole chain rather than only `toArray` — and the recorded `sort` argument
 * is what the ordering test asserts on.
 */
function cursor(docs: TenantMemberDocument[]): {
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  toArray: ReturnType<typeof vi.fn>;
} {
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue(docs),
  };

  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);

  return cursor;
}

function makeDoc(overrides: Partial<TenantMemberDocument> = {}): TenantMemberDocument {
  return {
    id: 'member-123',
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'OWNER',
    status: 'ACTIVE',
    invitation: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeInvitation() {
  return {
    status: 'PENDING',
    tokenHash: 'abc123hash',
    invitedBy: 'user-owner',
    invitedOn: new Date('2025-01-01T00:00:00Z'),
  };
}

describe('TenantMemberRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: TenantMemberRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new TenantMemberRepository(collection);
  });

  describe('findByUserAndTenant', () => {
    it('returns a mapped member when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByUserAndTenant('user-1', 'tenant-1');

      expect(collection.findOne).toHaveBeenCalledWith({ userId: 'user-1', tenantId: 'tenant-1' });
      expect(result).toEqual({
        id: 'member-123',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'OWNER',
        status: 'ACTIVE',
        expiresAt: null,
        invitation: null,
        displayName: null,
        email: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findByUserAndTenant('missing', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('findByTenant', () => {
    it('returns all members for a tenant', async () => {
      const chain = cursor([makeDoc({ userId: 'user-1' }), makeDoc({ userId: 'user-2', role: 'MEMBER' })]);

      collection.find.mockReturnValue(chain);

      const result = await repo.findByTenant('tenant-1');

      expect(collection.find).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(result).toHaveLength(2);
    });

    // The order is a promise, not an accident of insertion. Natural
    // collection order let two readers disagree about what row three is.
    it('sorts by userId ascending so the order is total and testable', async () => {
      const chain = cursor([]);

      collection.find.mockReturnValue(chain);

      await repo.findByTenant('tenant-1');

      expect(chain.sort).toHaveBeenCalledWith({ userId: 1 });
    });
  });

  describe('findByTenantWithUsers ordering (N-10)', () => {
    /** Records the aggregation pipeline the repository built, so a test can
     *  assert the ORDER of the stages — a sort placed after its `$project`
     *  would sort on fields that no longer exist. */
    function stubAggregate(docs: unknown[]): () => Record<string, unknown>[] {
      const toArray = vi.fn().mockResolvedValue(docs);
      const aggregate = vi.fn().mockReturnValue({ toArray });

      collection.aggregate = aggregate as unknown as typeof collection.aggregate;

      return () => (aggregate.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[];
    }

    it('sorts by lower-cased display name, then e-mail, then userId', async () => {
      const pipeline = stubAggregate([]);

      await repo.findByTenantWithUsers('tenant-1');

      expect(pipeline()).toEqual(
        expect.arrayContaining([
          { $sort: { _sortName: 1, _sortEmail: 1, userId: 1 } },
          { $project: { _sortName: 0, _sortEmail: 0 } },
        ]),
      );
    });

    it('computes its sort keys case-insensitively (ada and Ada do not split by insertion)', async () => {
      const pipeline = stubAggregate([]);

      await repo.findByTenantWithUsers('tenant-1');

      const addFields = pipeline().find((stage) => '$addFields' in stage) as { $addFields: Record<string, unknown> };

      expect(addFields.$addFields).toEqual({
        _sortName: { $toLower: { $ifNull: ['$user.displayName', '$$REMOVE'] } },
        _sortEmail: { $toLower: { $ifNull: ['$user.email', '$$REMOVE'] } },
      });
    });

    it('sorts BEFORE projecting the helper keys away, so the sort can see them', async () => {
      const pipeline = stubAggregate([]);

      await repo.findByTenantWithUsers('tenant-1');

      const stages = pipeline();
      const sortIndex = stages.findIndex((stage) => '$sort' in stage);
      const projectIndex = stages.findIndex((stage) => '$project' in stage);

      expect(sortIndex).toBeGreaterThan(-1);
      expect(projectIndex).toBeGreaterThan(sortIndex);
    });

    it('does not leak the sort helper keys into the returned rows', async () => {
      stubAggregate([{ ...makeDoc({ userId: 'user-1' }), user: { displayName: 'Ada', email: 'ada@x.test' } }]);

      const result = await repo.findByTenantWithUsers('tenant-1');

      expect(result[0]).not.toHaveProperty('_sortName');
      expect(result[0]).not.toHaveProperty('_sortEmail');
      expect(result[0]?.userDisplayName).toBe('Ada');
    });
  });

  describe('findByUser', () => {
    it('returns all memberships for a user', async () => {
      const toArray = vi
        .fn()
        .mockResolvedValue([
          makeDoc({ tenantId: 't1', status: 'ACTIVE' }),
          makeDoc({ tenantId: 't2', role: 'MEMBER', status: 'ACTIVE' }),
        ]);

      collection.find.mockReturnValue({ limit: vi.fn().mockReturnValue({ toArray }) });

      const result = await repo.findByUser('user-1');

      expect(collection.find).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(result).toHaveLength(2);
    });
  });

  describe('findByInvitationToken', () => {
    it('finds by tokenHash and pending status', async () => {
      const doc = makeDoc({
        invitation: makeInvitation(),
        status: 'ACTIVE',
      });

      collection.findOne.mockResolvedValue(doc);

      const result = await repo.findByInvitationToken('abc123hash');

      expect(collection.findOne).toHaveBeenCalledWith({
        'invitation.tokenHash': 'abc123hash',
        'invitation.status': 'PENDING',
      });
      expect(result).toBe(doc);
    });
  });

  describe('findPendingByEmail', () => {
    it('queries for pending invitations by invited email, under the row bound', async () => {
      const toArray = vi.fn().mockResolvedValue([makeDoc({ invitation: makeInvitation() })]);
      const limit = vi.fn(() => ({ toArray }));

      collection.find.mockReturnValue({ limit });

      const result = await repo.findPendingByEmail('invited@example.com');

      expect(collection.find).toHaveBeenCalledWith({
        'invitation.invitedEmail': 'invited@example.com',
        'invitation.status': 'PENDING',
      });
      // The address arrives from an unauthenticated visitor, so the size of the
      // answer must not be theirs to choose.
      expect(limit).toHaveBeenCalledWith(MAX_INVITATIONS_PER_EMAIL);
      expect(result).toHaveLength(1);
    });
  });

  // The `countActiveByTenant` block moved with the method — it was dead code
  // (no route, service or quota check reads it).

  describe('countOwnedTenants', () => {
    it('returns the count of owned tenants', async () => {
      collection.countDocuments.mockResolvedValue(1);

      const result = await repo.countOwnedTenants('user-1');

      expect(collection.countDocuments).toHaveBeenCalledWith({ userId: 'user-1', role: 'OWNER' });
      expect(result).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns a member document by id', async () => {
      const doc = makeDoc({ id: 'member-42' });

      collection.findOne.mockResolvedValue(doc);

      const result = await repo.findById('member-42');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'member-42' });
      expect(result).toBe(doc);
    });
  });

  describe('create', () => {
    it('creates an active member without invitation', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'OWNER',
        status: 'ACTIVE',
      });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as TenantMemberDocument;

      expect(insertedDoc.userId).toBe('user-1');
      expect(insertedDoc.tenantId).toBe('tenant-1');
      expect(insertedDoc.role).toBe('OWNER');
      expect(insertedDoc.status).toBe('ACTIVE');
      expect(insertedDoc.invitation).toBeNull();
      expect(insertedDoc.id).toBeDefined();

      expect(result.role).toBe('OWNER');
      expect(result.invitation).toBeNull();
    });

    it('creates a member with embedded invitation', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({
        userId: 'user-2',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        status: 'ACTIVE',
        invitation: makeInvitation(),
      });
      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as TenantMemberDocument;

      expect(insertedDoc.invitation).not.toBeNull();
      expect(insertedDoc.invitation?.status).toBe('PENDING');
      expect(insertedDoc.invitation?.tokenHash).toBe('abc123hash');
      expect(result.invitation).not.toBeNull();
    });
  });

  describe('update', () => {
    it('updates status and clears invitation', async () => {
      const updated = makeDoc({ status: 'ACTIVE', invitation: null });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.update('member-123', {
        status: 'ACTIVE',
        invitation: null,
      });

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'member-123' },
        { $set: { status: 'ACTIVE', invitation: null, updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.status).toBe('ACTIVE');
      expect(result?.invitation).toBeNull();
    });

    it('returns null when member not found', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.update('missing', { status: 'ACTIVE' });

      expect(result).toBeNull();
    });
  });

  describe('updateRole', () => {
    it('returns the updated member', async () => {
      const updated = makeDoc({ role: 'ADMIN' });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.updateRole('tenant-1', 'user-1', 'ADMIN');

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: 'user-1', tenantId: 'tenant-1' },
        { $set: { role: 'ADMIN', updatedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(result?.role).toBe('ADMIN');
    });
  });

  describe('delete', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.delete('tenant-1', 'user-1');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.delete('tenant-1', 'missing');

      expect(result).toBe(false);
    });
  });

  describe('deleteById', () => {
    it('returns true when a document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 1 } as DeleteResult);

      const result = await repo.deleteById('member-123');

      expect(result).toBe(true);
    });

    it('returns false when no document was deleted', async () => {
      collection.deleteOne.mockResolvedValue({ deletedCount: 0 } as DeleteResult);

      const result = await repo.deleteById('missing');

      expect(result).toBe(false);
    });
  });
});
