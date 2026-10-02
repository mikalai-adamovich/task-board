import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { Sprint, SprintStatus, CreateSprint } from '@task-board/shared';
import { MAX_PROJECT_SPRINTS } from '../db/read-bounds.js';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { projectId: 1, status: 1 }
// - { projectId: 1, startDate: 1 }

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface SprintDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  name: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: SprintDocument): Sprint {
  return {
    id: doc.id,
    projectId: doc.projectId,
    name: doc.name,
    status: doc.status as SprintStatus,
    startDate: doc.startDate ? doc.startDate.toISOString() : null,
    endDate: doc.endDate ? doc.endDate.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Sprint Repository ───────────────────────────────────────────────────────

export class SprintRepository extends BaseRepository<SprintDocument, Sprint> {
  protected toDomain(doc: SprintDocument): Sprint {
    return toDomain(doc);
  }

  /**
   * The project's sprints, newest first.
   *
   * Capped at {@link MAX_PROJECT_SPRINTS}: a project that has run sprints
   * continuously for a decade holds a few hundred, and the newest-first sort
   * means the bound keeps the sprints a team is currently working in.
   */
  async findByProject(projectId: string): Promise<Sprint[]> {
    const docs = await this.collection.find({ projectId }).sort({ createdAt: -1 }).limit(MAX_PROJECT_SPRINTS).toArray();

    return docs.map(toDomain);
  }

  // The shared `CreateSprint` interface replaced a hand-copied inline shape
  // (its optional dates are validated-but-absent, i.e. explicit `undefined`).
  async create(projectId: string, input: CreateSprint): Promise<Sprint> {
    const now = new Date();
    const doc: SprintDocument = {
      id: randomUUID(),
      projectId,
      name: input.name,
      status: 'FUTURE',
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async update(
    id: string,
    input: {
      name?: string;
      status?: string;
      startDate?: string | Date | null;
      endDate?: string | Date | null;
    },
  ): Promise<Sprint | null> {
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };

    if (input.name !== undefined) updateFields.name = input.name;
    if (input.status !== undefined) updateFields.status = input.status;
    if (input.startDate !== undefined) updateFields.startDate = input.startDate ? new Date(input.startDate) : null;
    if (input.endDate !== undefined) updateFields.endDate = input.endDate ? new Date(input.endDate) : null;

    const result = await this.collection.findOneAndUpdate({ id }, { $set: updateFields }, { returnDocument: 'after' });

    return result ? toDomain(result) : null;
  }

  /**
   * Delete all entities belonging to a project. Used for cascade delete.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
