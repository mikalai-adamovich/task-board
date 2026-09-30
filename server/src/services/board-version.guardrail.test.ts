/**
 * Optimistic concurrency for the board, guardrail.
 *
 * Two admins editing the workflow at the same time: the board write replaces the
 * WHOLE `columns` array, keyed only on the project, so the second save silently
 * discarded the first — a 200, and an audit event indistinguishable from an
 * ordinary save. The task side of the product already gets this right
 * (`TaskRepository.updateWithVersion` + `UpdateTaskSchema.version`), and this
 * suite exists so the board cannot quietly stop getting it too.
 *
 * The properties that must hold, and where each is proven:
 *   1. the DOCUMENT carries a version, and a pre-version document (no field) reads
 *      as 1 with no migration  → `board.repository.test.ts`
 *   2. the WRITE filters on that version and increments it atomically → here
 *   3. the REQUEST carries a version, and it is REQUIRED → here
 *   4. a STALE write is refused with 409, and it is refused BEFORE any write
 *      happens → here
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UpdateBoardColumnsSchema } from '../schemas/board.js';
import { BoardRepository, LEGACY_BOARD_VERSION } from '../repositories/board.repository.js';
import { BoardService } from './board.service.js';
import type { BoardConfig } from '@task-board/shared';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` clash.
const SRC_DIR = dirname(import.meta.filename);

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    projectId: 'project-1',
    columns: [{ id: 'col-1', statusIds: ['status-1'], position: 0 }],
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the board request contract carries a version (N-2)', () => {
  it('UpdateBoardColumnsSchema REQUIRES a positive integer version', () => {
    const columns = [{ statusIds: ['550e8400-e29b-41d4-a716-446655440001'], position: 0 }];

    expect(UpdateBoardColumnsSchema.safeParse({ columns, version: 1 }).success).toBe(true);
    // No version at all is a 400 — that is the whole enforcement: a client that
    // cannot state which version it is editing cannot be allowed to overwrite
    // the whole columns array.
    expect(UpdateBoardColumnsSchema.safeParse({ columns }).success).toBe(false);
    expect(UpdateBoardColumnsSchema.safeParse({ columns, version: 0 }).success).toBe(false);
    expect(UpdateBoardColumnsSchema.safeParse({ columns, version: 1.5 }).success).toBe(false);
    expect(UpdateBoardColumnsSchema.safeParse({ columns, version: '1' }).success).toBe(false);
  });
});

describe('a stale board write is refused (N-2)', () => {
  let boardRepo: {
    findByProject: ReturnType<typeof vi.fn>;
    updateColumnsWithVersion: ReturnType<typeof vi.fn>;
  };
  let service: BoardService;
  const ctx = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'OWNER' };

  beforeEach(() => {
    boardRepo = {
      findByProject: vi.fn().mockResolvedValue(makeBoard({ version: 7 })),
      updateColumnsWithVersion: vi.fn().mockResolvedValue(makeBoard({ version: 8 })),
    };
    service = new BoardService(
      boardRepo as never,
      { findByIds: vi.fn().mockResolvedValue([]) } as never,
      { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) } as never,
      undefined,
      { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) },
    );
  });

  it('refuses a save whose version is behind the stored one, and writes nothing', async () => {
    await expect(service.updateColumns('project-1', { columns: [], version: 3 }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });

    // The refusal happens BEFORE the write: nothing was replaced, and no audit
    // event was written, so a rejected save leaves no trace in the log that
    // could be mistaken for a successful one.
    expect(boardRepo.updateColumnsWithVersion).not.toHaveBeenCalled();
  });

  it('names both versions in the refusal', async () => {
    await expect(service.updateColumns('project-1', { columns: [], version: 3 }, ctx)).rejects.toThrow(
      /Current version: 7, provided version: 3/,
    );
  });

  it('accepts a save whose version matches, and forwards it to the atomic write', async () => {
    await service.updateColumns('project-1', { columns: [], version: 7 }, ctx);

    expect(boardRepo.updateColumnsWithVersion).toHaveBeenCalledWith('project-1', [], 7);
  });

  it('reports a lost race (the write returned null) as a conflict, not a 404', async () => {
    // Between the read above and the atomic write, another save won. The
    // repository returns null for "no longer this version"; the task service
    // reports the same case as TASK_VERSION_CONFLICT, and so does this one.
    boardRepo.updateColumnsWithVersion = vi.fn().mockResolvedValue(null);

    await expect(service.updateColumns('project-1', { columns: [], version: 7 }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });
});

describe('the board write is version-checked AT THE DATABASE (N-2)', () => {
  it('the repository has no way to replace the columns without naming a version', () => {
    // A behavioural assertion cannot see this: the service could simply stop
    // passing the version and the service-level tests would still pass. So the
    // repository's own source is read, and the guard is that the ONLY column
    // write filters on the version it was given.
    const raw = readFileSync(join(SRC_DIR, '..', 'repositories', 'board.repository.ts'), 'utf8');
    // Formatting-independent: the guard is about WHICH identifiers appear in
    // the write, not about how Prettier chose to wrap them. Collapsing runs of
    // whitespace keeps the assertions from breaking on a reformat.
    const source = raw.replace(/\s+/g, ' ');
    const writeCalls = [...raw.matchAll(/async (updateColumns\w*)\(/g)].map((match) => match[1]);

    expect(writeCalls).toEqual(['updateColumnsWithVersion']);
    expect(source).toMatch(/async updateColumnsWithVersion\([\s\S]*?currentVersion: number/);
    // The version must be part of the FILTER (the concurrency check) and the
    // update must bump it — a filter without the version would be last-write-wins.
    expect(source).toMatch(/\$or: \[ \{ version: currentVersion \}/);
    expect(source).toMatch(/\$inc: \{ version: 1 \}/);
    // And the version-less escape hatch must remain bound to the legacy version
    // only: a client on any other version must not be able to claim a document
    // that has no version field.
    // The escape hatch must stay bound to the LEGACY version alone: a client on
    // any other version must not be able to claim a document with no version.
    expect(source).toMatch(/currentVersion === LEGACY_BOARD_VERSION \?/);
    expect(source).toMatch(/\{ version: \{ \$exists: false \} \}/);
  });

  it('LEGACY_BOARD_VERSION is 1, so a pre-N-2 document and a new one present the same version', () => {
    // If this were 0 the request schema (positive integers only) could not carry
    // it, and every existing board would 400 on its first save after deploy.
    expect(LEGACY_BOARD_VERSION).toBe(1);
  });

  it('BoardRepository still creates boards AT version 1', async () => {
    const collection = {
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as unknown as ConstructorParameters<typeof BoardRepository>[0];
    const repo = new BoardRepository(collection);
    const created = await repo.create('project-1', [{ statusIds: ['s1'], position: 0 }]);

    expect(created.version).toBe(1);
  });
});
