import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoardRepository } from './board.repository.js';
import type { BoardDocument } from './board.repository.js';
import { LEGACY_BOARD_VERSION } from './board.repository.js';
import type { Collection, InsertOneResult } from 'mongodb';

// ─── Mock Collection Helper ──────────────────────────────────────────────────

function createMockCollection() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  } as unknown as Collection<BoardDocument> & {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    insertOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
}

/**
 * `version: undefined` models a document written before the version field existed — the
 * `Partial<...>` override cannot express it under `exactOptionalPropertyTypes`,
 * so the legacy document is built by deleting the key (which is exactly what
 * MongoDB holds for such a row).
 */
function makeLegacyDoc(): BoardDocument {
  const doc = makeDoc();

  delete doc.version;

  return doc;
}

function makeDoc(overrides: Partial<BoardDocument> = {}): BoardDocument {
  return {
    projectId: 'project-1',
    columns: [
      { id: 'col-1', statusIds: ['status-1', 'status-2'], position: 0 },
      { id: 'col-2', statusIds: ['status-3'], position: 1 },
    ],
    version: 1,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('BoardRepository (single-board model)', () => {
  let collection: ReturnType<typeof createMockCollection>;
  let repo: BoardRepository;

  beforeEach(() => {
    collection = createMockCollection();
    repo = new BoardRepository(collection);
  });

  describe('findByProject', () => {
    it('returns the mapped board when found', async () => {
      collection.findOne.mockResolvedValue(makeDoc());

      const result = await repo.findByProject('project-1');

      expect(collection.findOne).toHaveBeenCalledWith({ projectId: 'project-1' });
      expect(result).toEqual({
        projectId: 'project-1',
        columns: [
          { id: 'col-1', statusIds: ['status-1', 'status-2'], position: 0 },
          { id: 'col-2', statusIds: ['status-3'], position: 1 },
        ],
        version: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
    });

    // A board document written before the version field existed must
    // still be usable, with NO migration. It reads as LEGACY_BOARD_VERSION so
    // the version a client sends back is the one the write path will accept.
    it('reads a pre-N-2 document (no version field) as LEGACY_BOARD_VERSION', async () => {
      collection.findOne.mockResolvedValue(makeLegacyDoc());

      const result = await repo.findByProject('project-1');

      expect(result?.version).toBe(LEGACY_BOARD_VERSION);
    });

    it('returns null when the project has no board', async () => {
      collection.findOne.mockResolvedValue(null);

      const result = await repo.findByProject('missing');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts a projectId-keyed document with generated column ids', async () => {
      collection.insertOne.mockResolvedValue({ acknowledged: true } as InsertOneResult);

      const result = await repo.create('project-1', [
        { statusIds: ['s1'], position: 0 },
        { statusIds: ['s2'], position: 1 },
      ]);

      expect(collection.insertOne).toHaveBeenCalledTimes(1);
      expect(collection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1', columns: expect.any(Array) }),
      );
      expect(result.projectId).toBe('project-1');
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0]?.id).toEqual(expect.any(String));
    });
  });

  describe('updateColumnsWithVersion', () => {
    it('returns the updated board', async () => {
      const updated = makeDoc({ columns: [{ id: 'col-9', statusIds: ['s1'], position: 0 }], version: 2 });

      collection.findOneAndUpdate.mockResolvedValue(updated);

      const result = await repo.updateColumnsWithVersion(
        'project-1',
        [{ id: 'col-9', statusIds: ['s1'], position: 0 }],
        1,
      );

      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
        expect.objectContaining({ $set: expect.objectContaining({ columns: expect.any(Array) }) }),
        expect.objectContaining({ returnDocument: 'after' }),
      );
      expect(result?.columns[0]?.id).toBe('col-9');
    });

    // THE guardrail target. The write is filtered on the version the
    // client read and bumps it, exactly like `TaskRepository.updateWithVersion`.
    // Remove either half and two admins editing the board lose one edit again.
    it('filters on the version AND increments it in the same atomic update', async () => {
      collection.findOneAndUpdate.mockResolvedValue(makeDoc({ version: 5 }));

      await repo.updateColumnsWithVersion('project-1', [{ statusIds: ['s1'], position: 0 }], 4);

      const [filter, update] = collection.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $inc: { version: number } },
      ];

      expect(filter.$or).toEqual([{ version: 4 }]);
      expect(update.$inc).toEqual({ version: 1 });
    });

    // The migration-free escape hatch: a pre-version document has no `version`
    // field, and a client that read it sends LEGACY_BOARD_VERSION — so THAT
    // value alone also matches a version-less document.
    it('accepts a version-less document when the client sends LEGACY_BOARD_VERSION', async () => {
      collection.findOneAndUpdate.mockResolvedValue(makeLegacyDoc());

      await repo.updateColumnsWithVersion('project-1', [{ statusIds: ['s1'], position: 0 }], LEGACY_BOARD_VERSION);

      const [filter] = collection.findOneAndUpdate.mock.calls[0] as [Record<string, unknown>];

      expect(filter.$or).toEqual([{ version: LEGACY_BOARD_VERSION }, { version: { $exists: false } }]);
    });

    it('does NOT offer the version-less branch for any other version', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      await repo.updateColumnsWithVersion('project-1', [{ statusIds: ['s1'], position: 0 }], 7);

      const [filter] = collection.findOneAndUpdate.mock.calls[0] as [Record<string, unknown>];

      expect(filter.$or).toEqual([{ version: 7 }]);
    });

    it('generates column ids when the payload omits them', async () => {
      collection.findOneAndUpdate.mockResolvedValue(makeDoc());

      await repo.updateColumnsWithVersion('project-1', [{ statusIds: ['s1'], position: 0 }], 1);

      const call = collection.findOneAndUpdate.mock.calls[0]?.[1] as { $set: { columns: { id: string }[] } };

      expect(call.$set.columns[0]?.id).toEqual(expect.any(String));
    });

    it('returns null when the version did not match (concurrent save)', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.updateColumnsWithVersion('project-1', [{ statusIds: ['s1'], position: 0 }], 1);

      expect(result).toBeNull();
    });

    it('returns null when no board exists', async () => {
      collection.findOneAndUpdate.mockResolvedValue(null);

      const result = await repo.updateColumnsWithVersion('missing', [{ statusIds: ['s1'], position: 0 }], 1);

      expect(result).toBeNull();
    });
  });

  describe('replaceStatusInColumns', () => {
    it('calls updateMany with arrayFilters', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

      await repo.replaceStatusInColumns('project-1', 'old-status', 'new-status');

      expect(collection.updateMany).toHaveBeenCalledWith(
        { projectId: 'project-1', 'columns.statusIds': 'old-status' },
        {
          $set: {
            'columns.$[col].statusIds.$[sid]': 'new-status',
            updatedAt: expect.any(Date),
          },
        },
        { arrayFilters: [{ 'col.statusIds': 'old-status' }, { sid: 'old-status' }] },
      );
    });
  });

  describe('deleteByProject', () => {
    it('deletes all boards of the project (cascade)', async () => {
      collection.deleteMany.mockResolvedValue({ deletedCount: 1 } as never);

      await repo.deleteByProject('project-1');

      expect(collection.deleteMany).toHaveBeenCalledWith({ projectId: 'project-1' });
    });
  });
});
