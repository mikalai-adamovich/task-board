import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { Label } from '@task-board/shared';
import { MAX_PROJECT_LABELS } from '../db/read-bounds.js';

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface LabelDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: LabelDocument): Label {
  return {
    id: doc.id,
    projectId: doc.projectId,
    name: doc.name,
    normalizedName: doc.normalizedName,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Label Repository ────────────────────────────────────────────────────────

export class LabelRepository extends BaseRepository<LabelDocument, Label> {
  protected toDomain(doc: LabelDocument): Label {
    return toDomain(doc);
  }

  /**
   * The project's labels, alphabetically.
   *
   * Capped at {@link MAX_PROJECT_LABELS}: labels are the one reference list that
   * genuinely accumulates with usage (conventions like `area/frontend` pile up
   * over years), and the bound keeps a long-lived project from answering with an
   * arbitrarily large vocabulary.
   */
  async findByProject(projectId: string): Promise<Label[]> {
    const docs = await this.collection.find({ projectId }).sort({ name: 1 }).limit(MAX_PROJECT_LABELS).toArray();

    return docs.map(toDomain);
  }

  async findByProjectAndNormalizedName(projectId: string, normalizedName: string): Promise<Label | null> {
    const doc = await this.collection.findOne({ projectId, normalizedName });

    return doc ? toDomain(doc) : null;
  }

  async create(projectId: string, input: { name: string }): Promise<Label> {
    const now = new Date();
    const doc: LabelDocument = {
      id: randomUUID(),
      projectId,
      name: input.name,
      normalizedName: input.name.toLowerCase().trim(),
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async update(id: string, input: { name: string; normalizedName: string }): Promise<Label | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  /**
   * Delete all entities belonging to a project. Used for cascade delete.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
