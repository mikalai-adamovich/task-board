import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { BoardConfig } from '@task-board/shared';

// guardrail:no-base-repository 2026-09-29 — a board document has no `id`: it is
// keyed by its owning `projectId` (unique), which is the only key any read or
// write uses. The base class is `id`-keyed, so extending it would add a
// `findById`/`delete` pair addressing a field no document sets. See
// `rules/guardrails.guardrail.test.ts` (P-03).

// Required MongoDB indexes:
// - { projectId: 1 } (unique) — the board's natural identifier (single-board model)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface BoardColumnDocument {
  id: string;
  statusIds: string[];
  position: number;
}

export interface BoardDocument {
  _id?: import('mongodb').ObjectId;
  /** Owning project ID — unique; there is no separate board id */
  projectId: string;
  columns: BoardColumnDocument[];
  /**
   * Optimistic-concurrency version, mirroring `TaskDocument.version`.
   *
   * OPTIONAL in the TYPE on purpose. Every board is created by
   * `create()` (which sets 1) and every write goes through
   * {@link BoardRepository.updateColumnsWithVersion}, so a missing field can
   * only be a document written before this change. Treating it as
   * {@link LEGACY_BOARD_VERSION} (1) means those documents keep working with NO
   * migration and NO backfill: the first save matches version 1 and the write
   * materialises the field, after which the check is exact.
   */
  version?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The version a board document is treated as having when the field is absent —
 * a document written before the version field existed. 1, not 0, because `create()` starts at
 * 1 and because the request schema requires a POSITIVE integer: a legacy
 * document and a freshly seeded one must present the same version to a client,
 * or the first save after the deploy would be refused as stale for no reason.
 */
export const LEGACY_BOARD_VERSION = 1;

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: BoardDocument): BoardConfig {
  return {
    projectId: doc.projectId,
    columns: doc.columns.map((col) => ({
      id: col.id,
      statusIds: col.statusIds,
      position: col.position,
    })),
    // A pre-version document reads as LEGACY_BOARD_VERSION, so a client that has
    // just loaded it sends a version the write path will accept.
    version: doc.version ?? LEGACY_BOARD_VERSION,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Board Repository ────────────────────────────────────────────────────────

export class BoardRepository {
  constructor(private readonly collection: Collection<BoardDocument>) {}

  /** The project's single board (null when missing — should never happen post-seed). */
  async findByProject(projectId: string): Promise<BoardConfig | null> {
    const doc = await this.collection.findOne({ projectId });

    return doc ? toDomain(doc) : null;
  }

  /** Create the project's board (called once from the project seed). */
  async create(projectId: string, columns: { statusIds: string[]; position: number }[]): Promise<BoardConfig> {
    const now = new Date();
    const doc: BoardDocument = {
      projectId,
      columns: columns.map((col) => ({
        id: randomUUID(),
        statusIds: col.statusIds,
        position: col.position,
      })),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  /**
   * Replace the columns ATOMICALLY against the version the client
   * read — the same `findOneAndUpdate({id, version}, {$inc: {version: 1}})`
   * shape `TaskRepository.updateWithVersion` already uses, keyed on `projectId`
   * because that is the board's identifier.
   *
   * `null` means "the version did not match" (somebody else saved first) and the
   * service turns that into a 409. The caller CANNOT distinguish that from a
   * missing board at this level, so it is the service that owns the mapping.
   *
   * The `$or` on the filter is what makes the change migration-free: a document
   * with no `version` field is a pre-version document, which {@link toDomain} reports
   * as {@link LEGACY_BOARD_VERSION}, so a client that just read it sends 1 — and
   * the second branch matches. After that write the field exists and the check
   * is exact. A client sending any OTHER version still cannot match a legacy
   * document, which is the point: the escape hatch is for version 1 only.
   */
  async updateColumnsWithVersion(
    projectId: string,
    // `id` comes straight from a Zod object, so the key may be present
    // with value `undefined` (a newly added column) — hence the explicit
    // `| undefined` rather than `UpdateBoardColumns` inference at the call site.
    columns: { id?: string | undefined; statusIds: string[]; position: number }[],
    currentVersion: number,
  ): Promise<BoardConfig | null> {
    const result = await this.collection.findOneAndUpdate(
      {
        projectId,
        $or: [
          { version: currentVersion },
          ...(currentVersion === LEGACY_BOARD_VERSION ? [{ version: { $exists: false } }] : []),
        ],
      },
      {
        $set: {
          columns: columns.map((col) => ({
            id: col.id ?? randomUUID(),
            statusIds: col.statusIds,
            position: col.position,
          })),
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  /**
   * Replace a status ID in the board's columns.
   * Used when deleting a status with a replacement.
   */
  async replaceStatusInColumns(projectId: string, oldStatusId: string, newStatusId: string): Promise<void> {
    await this.collection.updateMany(
      { projectId, 'columns.statusIds': oldStatusId },
      { $set: { 'columns.$[col].statusIds.$[sid]': newStatusId, updatedAt: new Date() } },
      { arrayFilters: [{ 'col.statusIds': oldStatusId }, { sid: oldStatusId }] },
    );
  }

  /**
   * Delete the board(s) belonging to a project. Used for cascade delete —
   * the board dies with its project, never independently.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
