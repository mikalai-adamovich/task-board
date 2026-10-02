import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { Status } from '@task-board/shared';
import { MAX_PROJECT_STATUSES } from '../db/read-bounds.js';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { projectId: 1, normalizedName: 1 } (unique)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface StatusDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: StatusDocument): Status {
  return {
    id: doc.id,
    projectId: doc.projectId,
    name: doc.name,
    normalizedName: doc.normalizedName,
    position: doc.position,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Status Repository ───────────────────────────────────────────────────────

export class StatusRepository extends BaseRepository<StatusDocument, Status> {
  protected toDomain(doc: StatusDocument): Status {
    return toDomain(doc);
  }

  /**
   * The project's statuses (its board columns), in display order.
   *
   * Capped at {@link MAX_PROJECT_STATUSES}: a workflow's columns are chosen by a
   * team, so the list is small by construction and the cap only fires on data
   * that is not a status list.
   */
  async findByProject(projectId: string): Promise<Status[]> {
    const docs = await this.collection.find({ projectId }).sort({ position: 1 }).limit(MAX_PROJECT_STATUSES).toArray();

    return docs.map(toDomain);
  }

  async findByProjectAndNormalizedName(projectId: string, normalizedName: string): Promise<Status | null> {
    const doc = await this.collection.findOne({ projectId, normalizedName });

    return doc ? toDomain(doc) : null;
  }

  async create(projectId: string, input: { name: string; position: number }): Promise<Status> {
    const now = new Date();
    const doc: StatusDocument = {
      id: randomUUID(),
      projectId,
      name: input.name,
      normalizedName: input.name.toLowerCase().trim(),
      position: input.position,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async createMany(projectId: string, items: { name: string; position: number }[]): Promise<Status[]> {
    const now = new Date();
    const docs: StatusDocument[] = items.map((item) => ({
      id: randomUUID(),
      projectId,
      name: item.name,
      normalizedName: item.name.toLowerCase().trim(),
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
    input: Partial<Pick<StatusDocument, 'name' | 'normalizedName' | 'position'>>,
  ): Promise<Status | null> {
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };

    if (input.name !== undefined) updateFields.name = input.name;
    if (input.normalizedName !== undefined) updateFields.normalizedName = input.normalizedName;
    if (input.position !== undefined) updateFields.position = input.position;

    const result = await this.collection.findOneAndUpdate({ id }, { $set: updateFields }, { returnDocument: 'after' });

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
