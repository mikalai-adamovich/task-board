import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
// guardrail:no-base-repository 2026-09-29 — every read and write is keyed by the
// `(userId, projectId)` pair; the `id` field exists only because the upsert's
// `$setOnInsert` writes one. The base's `findById`/`delete` would address an
// identity no query in this repository ever uses, inventing a second way to
// reach a preference row. See `rules/guardrails.guardrail.test.ts` (P-03).
import type {
  TaskTableColumnKey,
  UpdateUserProjectBoardPreference,
  UserProjectBoardPreference,
} from '@task-board/shared';

// Required MongoDB indexes:
// - { userId: 1, projectId: 1 } (unique)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface UserPreferencesDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  userId: string;
  projectId: string;
  /** Visible task-table columns; null/absent = default set. */
  taskTableColumns?: TaskTableColumnKey[] | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: UserPreferencesDocument): UserProjectBoardPreference {
  return {
    id: doc.id,
    userId: doc.userId,
    projectId: doc.projectId,
    taskTableColumns: doc.taskTableColumns ?? null,
    // Tolerate legacy docs persisted before createdAt/updatedAt were set on insert (V7-3).
    createdAt: (doc.createdAt ?? new Date(0)).toISOString(),
    updatedAt: (doc.updatedAt ?? new Date(0)).toISOString(),
  };
}

// ─── User Preferences Repository ─────────────────────────────────────────────

export class UserPreferencesRepository {
  constructor(private readonly collection: Collection<UserPreferencesDocument>) {}

  async findByUserAndProject(userId: string, projectId: string): Promise<UserProjectBoardPreference | null> {
    const doc = await this.collection.findOne({ userId, projectId });

    return doc ? toDomain(doc) : null;
  }

  async upsert(
    userId: string,
    projectId: string,
    data: UpdateUserProjectBoardPreference,
  ): Promise<UserProjectBoardPreference> {
    const now = new Date();
    // Partial update: only $set the fields the request actually carried.
    const $set: Record<string, unknown> = { updatedAt: now };

    if (data.taskTableColumns !== undefined) {
      $set['taskTableColumns'] = data.taskTableColumns;
    }

    const $setOnInsert: Record<string, unknown> = { id: randomUUID(), userId, projectId, createdAt: now };
    const result = await this.collection.findOneAndUpdate(
      { userId, projectId },
      { $set, $setOnInsert },
      { upsert: true, returnDocument: 'after' },
    );

    if (!result) {
      throw new Error('Upsert returned null');
    }

    return toDomain(result);
  }
}
