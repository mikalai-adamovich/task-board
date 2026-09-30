import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection } from 'mongodb';
import type { ProjectMember } from '@task-board/shared';

// guardrail:no-base-repository 2026-09-29 — the delete is composite-keyed
// (`delete(projectId, userId)`, a different signature from the base's
// `delete(id)`), so extending would either shadow it with an incompatible
// signature or rename a public method every caller depends on. That is a
// behaviour change, not a conversion. See `rules/guardrails.guardrail.test.ts`
// (P-03).

// Required MongoDB indexes:
// - { projectId: 1, userId: 1 } (unique)
// - { id: 1 } (unique)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface ProjectMemberDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: ProjectMemberDocument): ProjectMember {
  return {
    id: doc.id,
    projectId: doc.projectId,
    userId: doc.userId,
    role: doc.role as ProjectMember['role'],
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Extended document shape returned by the aggregation lookup */
interface ProjectMemberWithUserDoc extends ProjectMemberDocument {
  user: { displayName: string; email: string; avatarUrl: string | null }[];
}

// ─── Project Member Repository ───────────────────────────────────────────────

export class ProjectMemberRepository {
  constructor(private readonly collection: Collection<ProjectMemberDocument>) {}

  async findByUserAndProject(userId: string, projectId: string): Promise<ProjectMember | null> {
    const doc = await this.collection.findOne({ userId, projectId });

    return doc ? toDomain(doc) : null;
  }

  async findByProject(projectId: string): Promise<ProjectMember[]> {
    const docs = await this.collection.find({ projectId }).toArray();

    return docs.map(toDomain);
  }

  /**
   * Find all members of a project with user display names resolved via $lookup.
   * Joins with the `users` collection on `userId` → `id`.
   */
  async findByProjectWithUsers(projectId: string): Promise<ProjectMember[]> {
    const docs = await this.collection
      .aggregate<ProjectMemberWithUserDoc>([
        { $match: { projectId } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: 'id',
            as: 'user',
          },
        },
      ])
      .toArray();

    return docs.map((doc) => ({
      id: doc.id,
      projectId: doc.projectId,
      userId: doc.userId,
      role: doc.role as ProjectMember['role'],
      displayName: doc.user[0]?.displayName ?? doc.userId,
      email: doc.user[0]?.email ?? undefined,
      avatarUrl: doc.user[0]?.avatarUrl ?? null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    }));
  }

  async findByUser(userId: string): Promise<ProjectMember[]> {
    const docs = await this.collection.find({ userId }).toArray();

    return docs.map(toDomain);
  }

  async create(
    input: { userId: string; projectId: string; role: string },
    options?: { session?: ClientSession },
  ): Promise<ProjectMember> {
    const now = new Date();
    const doc: ProjectMemberDocument = {
      id: randomUUID(),
      userId: input.userId,
      projectId: input.projectId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc, options);
    return toDomain(doc);
  }

  async updateRole(projectId: string, userId: string, role: string): Promise<ProjectMember | null> {
    const result = await this.collection.findOneAndUpdate(
      { userId, projectId },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ userId, projectId });

    return result.deletedCount > 0;
  }

  /** Delete all project memberships for a user (used on user deletion) */
  async deleteByUserId(userId: string): Promise<void> {
    await this.collection.deleteMany({ userId });
  }
}
