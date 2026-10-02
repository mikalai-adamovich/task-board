import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { TaskType } from '@task-board/shared';
import { MAX_PROJECT_TASK_TYPES } from '../db/read-bounds.js';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { projectId: 1, key: 1 } (unique)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface TaskTypeDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  key: string;
  name: string;
  icon: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: TaskTypeDocument): TaskType {
  return {
    id: doc.id,
    projectId: doc.projectId,
    key: doc.key,
    name: doc.name,
    icon: doc.icon,
    position: doc.position,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── TaskType Repository ─────────────────────────────────────────────────────

export class TaskTypeRepository extends BaseRepository<TaskTypeDocument, TaskType> {
  protected toDomain(doc: TaskTypeDocument): TaskType {
    return toDomain(doc);
  }

  /**
   * The project's task types, in display order.
   *
   * Capped at {@link MAX_PROJECT_TASK_TYPES}: a hand-maintained vocabulary, so
   * the bound only fires on data that is not a type list.
   */
  async findByProject(projectId: string): Promise<TaskType[]> {
    const docs = await this.collection
      .find({ projectId })
      .sort({ position: 1 })
      .limit(MAX_PROJECT_TASK_TYPES)
      .toArray();

    return docs.map(toDomain);
  }

  async findByProjectAndKey(projectId: string, key: string): Promise<TaskType | null> {
    const doc = await this.collection.findOne({ projectId, key });

    return doc ? toDomain(doc) : null;
  }

  async create(
    projectId: string,
    // `| undefined` — mirrors the shared `CreateTaskType` (`icon` is a
    // validated-but-absent optional); normalised with `?? null` below.
    input: { key: string; name: string; icon?: string | null | undefined; position: number },
  ): Promise<TaskType> {
    const now = new Date();
    const doc: TaskTypeDocument = {
      id: randomUUID(),
      projectId,
      key: input.key,
      name: input.name,
      icon: input.icon ?? null,
      position: input.position,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async createMany(
    projectId: string,
    // `| undefined` because this mirrors the shared `CreateTaskType`, whose
    // `icon` is a validated-but-absent optional (`z.string().optional()`), and
    // the body normalises it with `?? null` immediately below.
    items: { key: string; name: string; icon?: string | null | undefined; position: number }[],
  ): Promise<TaskType[]> {
    const now = new Date();
    const docs: TaskTypeDocument[] = items.map((item) => ({
      id: randomUUID(),
      projectId,
      key: item.key,
      name: item.name,
      icon: item.icon ?? null,
      position: item.position,
      createdAt: now,
      updatedAt: now,
    }));

    if (docs.length > 0) {
      await this.collection.insertMany(docs);
    }

    return docs.map(toDomain);
  }

  async update(
    id: string,
    input: Partial<Pick<TaskTypeDocument, 'name' | 'icon' | 'position'>>,
  ): Promise<TaskType | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  /** Bulk-update positions in one pass (used by the reorder endpoint). */
  async reorderPositions(items: { id: string; position: number }[]): Promise<void> {
    if (items.length === 0) return;

    const now = new Date();
    const operations = items.map((item) => ({
      updateOne: {
        filter: { id: item.id },
        update: { $set: { position: item.position, updatedAt: now } },
      },
    }));

    await this.collection.bulkWrite(operations);
  }

  /**
   * Delete all entities belonging to a project. Used for cascade delete.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
