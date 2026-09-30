import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRepository } from './user.repository.js';
import type { UserDocument } from './user.repository.js';
import type { Collection, InsertOneResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    insertOne: vi.fn(),
  } as unknown as Collection<UserDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
  };
}

function makeDoc(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    id: 'user-123',
    email: 'test@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    passwordHash: 'hashed-pw',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('UserRepository', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: UserRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new UserRepository(collection);
  });

  describe('findById', () => {
    it('returns a mapped user when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('user-123');

      expect(collection.findOne).toHaveBeenCalledWith({ id: 'user-123', deletedAt: null });
      expect(result).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
        avatarUrl: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: null,
      });
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });

    it('does not expose passwordHash in domain object', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findById('user-123');

      expect(result).not.toHaveProperty('passwordHash');
    });

    it('returns null for soft-deleted users', async () => {
      collection.findOne.mockResolvedValue(null); // filtered by deletedAt: null in query

      const result = await repo.findById('deleted-user');

      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('returns the raw document when found', async () => {
      const doc = makeDoc();

      collection.findOne.mockResolvedValue(doc);

      const result = await repo.findByEmail('test@example.com');

      expect(collection.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(result).toBe(doc);
    });

    it('normalizes email to lowercase and trimmed', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      await repo.findByEmail('  TEST@EXAMPLE.COM  ');

      expect(collection.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
    });

    it('returns null when not found', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findByEmail('missing@example.com');

      expect(result).toBeNull();
    });

    it('D-12: deliberately MATCHES a soft-deleted user — the uniqueness check it guards needs to see them', async () => {
      // The counter-intuitive half of the fix, asserted so it cannot be "tidied
      // up" later. `users.email` carries a plain (not partial) unique index, so
      // a soft-deleted row is one a re-registration WOULD collide with. If this
      // method filtered `deletedAt: null`, register would report the address as
      // free and the insert would fail on E11000 instead of the intended
      // "already taken" — a worse answer than the one it replaced.
      collection.findOne.mockResolvedValue(makeDoc({ deletedAt: new Date('2025-06-01T00:00:00Z') }));

      const result = await repo.findByEmail('test@example.com');

      expect(collection.findOne).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(result?.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('D-12: the method authentication may use', () => {
    it('findActiveByEmail filters deletedAt — the soft-delete predicate is the query, not the caller', async () => {
      collection.findOne.mockResolvedValue(null);

      await repo.findActiveByEmail('test@example.com');

      expect(collection.findOne).toHaveBeenCalledWith({ email: 'test@example.com', deletedAt: null });
    });
  });

  describe('create', () => {
    it('inserts a document and returns the domain user', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create({
        email: 'new@example.com',
        displayName: 'New User',
        passwordHash: 'hashed',
      });

      expect(collection.insertOne).toHaveBeenCalledTimes(1);

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as UserDocument;

      expect(insertedDoc.email).toBe('new@example.com');
      expect(insertedDoc.displayName).toBe('New User');
      expect(insertedDoc.passwordHash).toBe('hashed');
      expect(insertedDoc.avatarUrl).toBeNull();
      expect(insertedDoc.deletedAt).toBeNull();
      expect(insertedDoc.id).toBeDefined();
      expect(insertedDoc.createdAt).toBeInstanceOf(Date);
      expect(insertedDoc.updatedAt).toBeInstanceOf(Date);

      expect(result.email).toBe('new@example.com');
      expect(result.displayName).toBe('New User');
      expect(result.avatarUrl).toBeNull();
      expect(result.deletedAt).toBeNull();
      expect(result).not.toHaveProperty('passwordHash');
      expect(typeof result.createdAt).toBe('string');
    });

    it('normalizes email before insert', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      await repo.create({
        email: '  NEW@EXAMPLE.COM  ',
        displayName: 'New User',
        passwordHash: 'hashed',
      });

      const insertedDoc = collection.insertOne.mock.calls[0]?.[0] as UserDocument;

      expect(insertedDoc.email).toBe('new@example.com');
    });
  });
});
