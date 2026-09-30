import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.repository.js';
import { TenantStatus } from '@task-board/shared';
import type { Tenant, CreateTenant } from '@task-board/shared';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { slug: 1 } (unique) — DEC-032 tenant slug lookup + global uniqueness
// - { status: 1, deletionScheduledAt: 1 }   (the scheduled purge's `findDue`)

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface TenantDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  deletionScheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

/** Exported for cross-repository aggregates (e.g. tenant-member $lookup joins). */
export function toDomain(doc: TenantDocument): Tenant {
  return {
    id: doc.id,
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    status: doc.status as Tenant['status'],
    deletionScheduledAt: doc.deletionScheduledAt ? doc.deletionScheduledAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Tenant Repository ───────────────────────────────────────────────────────

export class TenantRepository extends BaseRepository<TenantDocument, Tenant> {
  protected toDomain(doc: TenantDocument): Tenant {
    return toDomain(doc);
  }

  // `findAll()` and `findBySlug(slug)` were removed as dead code.
  //
  // - `findAll()` is an unscoped `find()` over the whole `tenants` collection.
  //   In a multi-tenant product it is a cross-tenant read waiting for a caller,
  //   and no caller exists: tenant access always goes through a membership.
  // - `findBySlug(slug)` is a global lookup by a value that is only unique by
  //   convention. The slug-collision path the product actually needs is
  //   `slugExists(slug)`, which is a projection-only existence probe and is kept.

  /** Check whether a slug is already claimed by any tenant. */
  async slugExists(slug: string): Promise<boolean> {
    const doc = await this.collection.findOne({ slug }, { projection: { _id: 1 } });

    return doc !== null;
  }

  /**
   * The workspaces whose grace deadline has passed.
   *
   * Ids only, for the same reason as `ProjectRepository.findDue`: the reaper
   * re-reads each entity before acting, so this query selects rather than loads.
   * Served by `{ status: 1, deletionScheduledAt: 1 }`.
   *
   * `$ne: null` is explicit rather than implied: a workspace whose deadline is
   * unset is a workspace nobody scheduled, and `null <= now` is not a comparison
   * this query should be relying on to exclude it.
   */
  async findDue(now: Date): Promise<{ id: string }[]> {
    return this.collection
      .find(
        { status: TenantStatus.DELETION_PENDING, deletionScheduledAt: { $ne: null, $lte: now } },
        { projection: { id: 1 } },
      )
      .toArray();
  }

  /**
   * The shared `CreateTenant` interface replaced a hand-copied inline
   * shape. `slug` is intersected back as REQUIRED because the service resolves
   * it (`resolveSlugForCreate`) before calling — the API-level optionality is
   * a client concern, not a repository one.
   */
  async create(input: CreateTenant & { slug: string }): Promise<Tenant> {
    const now = new Date();
    const doc: TenantDocument = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      status: TenantStatus.ACTIVE,
      deletionScheduledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async update(
    id: string,
    /**
     * A PATCH payload. Optional keys may not be present with the value
     * `undefined` (`exactOptionalPropertyTypes`), so `$set` only ever receives
     * fields the caller actually changed; `undefined` would otherwise be
     * serialised to BSON `null` and silently clear a field.
     */
    input: Partial<Pick<TenantDocument, 'name' | 'description' | 'status' | 'deletionScheduledAt'>>,
  ): Promise<Tenant | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }
}
