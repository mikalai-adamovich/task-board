import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection } from 'mongodb';
import type { ProjectMember } from '@task-board/shared';
import { MAX_PROJECT_MEMBERS } from '../db/read-bounds.js';

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

  /**
   * Capped at {@link MAX_PROJECT_MEMBERS}: membership is granted by an admin, so
   * the list grows with the team, and 1 000 is already a large-company-sized
   * project.
   */
  async findByProject(projectId: string): Promise<ProjectMember[]> {
    const docs = await this.collection.find({ projectId }).limit(MAX_PROJECT_MEMBERS).toArray();

    return docs.map(toDomain);
  }

  /**
   * Find all members of a project with user display names resolved via $lookup.
   * Joins with the `users` collection on `userId` → `id`.
   *
   * Bounded by the same {@link MAX_PROJECT_MEMBERS} as {@link findByProject} —
   * the bound goes LAST in the pipeline so the `$lookup` still runs over the
   * whole membership set and no member is joined against a user row that was
   * never fetched.
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
        { $limit: MAX_PROJECT_MEMBERS },
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

  /**
   * Resolve one user's IDENTITY through their membership of `projectId`.
   *
   * The membership row is the gate, not a convenience: a user who is not a
   * member of this project has no row here, so `null` is returned and the
   * caller learns nothing about whether that id exists elsewhere. That makes
   * this the seam a write path must use before it denormalizes someone's
   * display name onto a document — resolving the name from the global users
   * collection first would disclose it for an id the caller had no right to
   * name. A membership hangs off a project, and the caller has already
   * tenant-asserted that project, so membership here implies the same tenant.
   */
  async findUserIdentityByProject(
    userId: string,
    projectId: string,
  ): Promise<{ userId: string; displayName: string } | null> {
    const [doc] = await this.collection
      .aggregate<ProjectMemberWithUserDoc>([
        { $match: { userId, projectId } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: 'id',
            as: 'user',
          },
        },
        // One membership row per (user, project) — the compound unique index
        // makes that a fact, and the `$limit` states it in the query instead of
        // leaving it to be re-derived from an index comment.
        { $limit: 1 },
      ])
      .toArray();

    if (!doc) {
      return null;
    }

    // A member whose user row is missing still has an id to show; the name is
    // a display convenience, never a reason to fail an otherwise valid write.
    return { userId: doc.userId, displayName: doc.user[0]?.displayName ?? doc.userId };
  }

  /**
   * A user's project memberships across every project.
   *
   * Capped at {@link MAX_PROJECT_MEMBERS} for the same reason as the per-project
   * list: this read runs on the hot authorization path, so it is the last place
   * that should materialize an unbounded number of rows.
   */
  async findByUser(userId: string): Promise<ProjectMember[]> {
    const docs = await this.collection.find({ userId }).limit(MAX_PROJECT_MEMBERS).toArray();

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
