import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { TaskRelationship, TaskRelationshipType } from '@task-board/shared';
import { MAX_RELATIONSHIPS_PER_TASK } from '../db/read-bounds.js';

export interface TaskRelationshipDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: string;
  createdById: string;
  createdAt: Date;
}

function toDomain(doc: TaskRelationshipDocument): TaskRelationship {
  return {
    id: doc.id,
    projectId: doc.projectId,
    sourceTaskId: doc.sourceTaskId,
    targetTaskId: doc.targetTaskId,
    type: doc.type as TaskRelationshipType,
    createdById: doc.createdById,
    createdAt: doc.createdAt.toISOString(),
  };
}

export class TaskRelationshipRepository extends BaseRepository<TaskRelationshipDocument, TaskRelationship> {
  protected toDomain(doc: TaskRelationshipDocument): TaskRelationship {
    return toDomain(doc);
  }

  /**
   * Relationships touching one task, in either direction.
   *
   * Capped at {@link MAX_RELATIONSHIPS_PER_TASK}: edges are authored by hand, so
   * the list is small by construction, and the cap keeps a mis-built graph from
   * turning one task's detail response into an unbounded body.
   */
  async findByTask(taskId: string): Promise<TaskRelationship[]> {
    const docs = await this.collection
      .find({ $or: [{ sourceTaskId: taskId }, { targetTaskId: taskId }] })
      .limit(MAX_RELATIONSHIPS_PER_TASK)
      .toArray();

    return docs.map(toDomain);
  }

  // `findBySourceAndTarget(source, target)` was removed as dead code.
  // `create()` no longer runs a check-then-act pre-check — F11 replaced it with the
  // unique `{projectId, sourceTaskId, targetTaskId}` index plus
  // `withConflictOnDuplicate`, so the pre-check had no callers left (and a pre-check
  // without the index would have been a duplicate-insert race anyway).

  async create(input: {
    projectId: string;
    sourceTaskId: string;
    targetTaskId: string;
    type: string;
    createdById: string;
  }): Promise<TaskRelationship> {
    const doc: TaskRelationshipDocument = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.collection.deleteMany({ $or: [{ sourceTaskId: taskId }, { targetTaskId: taskId }] });
  }

  /**
   * Delete all entities belonging to a project. Used for cascade delete.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
