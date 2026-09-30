import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { BaseRepository } from './base.repository.js';
import { ProjectStatus } from '@task-board/shared';
import type { Project, CreateProject } from '@task-board/shared';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { tenantId: 1, key: 1 } (unique)
// - { status: 1, deletionScheduledAt: 1 }   (the scheduled purge's `findDue`)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface ProjectDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  defaultStatusId: string;
  archiveReason: string | null;
  deletionScheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: ProjectDocument): Project {
  return {
    id: doc.id,
    tenantId: doc.tenantId,
    key: doc.key,
    name: doc.name,
    description: doc.description,
    status: doc.status as Project['status'],
    defaultStatusId: doc.defaultStatusId,
    archiveReason: doc.archiveReason as Project['archiveReason'],
    deletionScheduledAt: doc.deletionScheduledAt ? doc.deletionScheduledAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Project Repository ──────────────────────────────────────────────────────

export class ProjectRepository extends BaseRepository<ProjectDocument, Project> {
  protected toDomain(doc: ProjectDocument): Project {
    return toDomain(doc);
  }

  // The single-key `findByKey` lookup was removed as dead code. It resolved a
  // project by `key` ALONE — no `tenantId` — so it was tenant-unsafe by
  // construction, and nothing called it: every lookup goes through
  // `findByTenantAndKey` (tenant-scoped, served by the unique
  // `{tenantId, key}` index) or `BaseRepository.findById` (served by `{id: 1}`).
  // Its F11 non-unique single-key index went with it — the index-coverage
  // guardrail in `db/migrations.test.ts` enforces exactly that pairing.

  async findByTenant(tenantId: string): Promise<Project[]> {
    const docs = await this.collection.find({ tenantId }).toArray();

    return docs.map(toDomain);
  }

  async findByTenantAndKey(tenantId: string, key: string): Promise<Project | null> {
    const doc = await this.collection.findOne({ tenantId, key });

    return doc ? toDomain(doc) : null;
  }

  /**
   * The projects whose grace deadline has passed.
   *
   * **Ids only, and that is deliberate.** The reaper re-reads each entity before
   * acting (`PurgeService.purgeOneProject`), so this query's job is selection, not
   * data: a projection of `id` keeps a workspace with many projects from
   * materialising every project document into the Worker's heap once a day.
   *
   * Served by `{ status: 1, deletionScheduledAt: 1 }` (see the index list above):
   * `status` is an equality and `deletionScheduledAt` the range, which is the shape
   * that index exists for.
   *
   * `maxTimeMS` is set, unlike most reads here: a purge that hangs holds a Worker
   * slot and, because the trigger is a timer, silently skips the whole run. A 503
   * from the driver surfaces as a failure the next run retries.
   */
  async findDue(now: Date): Promise<{ id: string }[]> {
    return this.collection
      .find(
        { status: ProjectStatus.DELETION_PENDING, deletionScheduledAt: { $ne: null, $lte: now } },
        { projection: { id: 1 } },
      )
      .toArray();
  }

  async create(
    tenantId: string,
    // The shared `CreateProject` interface replaced a hand-copied inline
    // shape, so route → service → repository has ONE definition of the create
    // body instead of three that can drift.
    input: CreateProject,
    options?: { session?: ClientSession },
  ): Promise<Project> {
    const now = new Date();
    const doc: ProjectDocument = {
      id: randomUUID(),
      tenantId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      status: ProjectStatus.ACTIVE,
      defaultStatusId: '',
      archiveReason: null,
      deletionScheduledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc, options);
    return toDomain(doc);
  }

  async update(
    id: string,
    /**
     * A PATCH payload, not a partial replacement.
     *
     * Every key is optional, but under `exactOptionalPropertyTypes` an optional
     * key may NOT be present with the value `undefined`. That is precisely the
     * contract this method needs: `$set` only ever receives keys the caller
     * actually decided to change. Passing `{ description: undefined }` used to
     * type-check and reached BSON, where `undefined` serialises as `null` — a
     * PATCH that omitted a field could therefore NULL it out. Callers now build
     * the patch from defined keys only.
     */
    input: Partial<
      Pick<
        ProjectDocument,
        'name' | 'description' | 'status' | 'defaultStatusId' | 'archiveReason' | 'deletionScheduledAt'
      >
    >,
    options?: { session?: ClientSession },
  ): Promise<Project | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after', ...options },
    );

    return result ? toDomain(result) : null;
  }
}
