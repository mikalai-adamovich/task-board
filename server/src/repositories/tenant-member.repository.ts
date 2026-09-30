import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { InvitationStatus, TenantRole } from '@task-board/shared';
import type { TenantMember, Invitation } from '@task-board/shared';
import { toDomain as tenantToDomain } from './tenant.repository.js';

// guardrail:no-base-repository 2026-09-29 — two reasons. (1) Its `findById`
// deliberately returns the raw DOCUMENT (the tenant-context middleware reuses it
// to avoid a second query) where the base maps to the domain. (2) Its `delete` is
// composite-keyed (`delete(tenantId, userId)`), an incompatible signature.
// Overriding both would keep the class honest about nothing. See
// `rules/guardrails.guardrail.test.ts` (P-03).

// Required MongoDB indexes:
// - { tenantId: 1, userId: 1 } (unique)
// - { id: 1 } (unique)
// - { tenantId: 1 }

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface InvitationDocument {
  status: string;
  tokenHash: string;
  invitedBy: string;
  invitedOn: Date;
  /** Email the invitation was sent to (lookup key for findPendingByEmail / findByInvitedEmail) */
  invitedEmail?: string | null;
}

export interface TenantMemberDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  tenantId: string;
  userId: string;
  role: string;
  status: string;
  /** Membership expiration (null/undefined = never expires) */
  expiresAt?: Date | null;
  invitation: InvitationDocument | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

/** Exported for the tenant-context middleware (pre-resolved membership reuse). */
export function toDomain(doc: TenantMemberDocument): TenantMember {
  return {
    id: doc.id,
    tenantId: doc.tenantId,
    userId: doc.userId,
    role: doc.role as TenantMember['role'],
    status: doc.status as TenantMember['status'],
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    invitation: doc.invitation
      ? {
          status: doc.invitation.status as Invitation['status'],
          tokenHash: doc.invitation.tokenHash,
          invitedBy: doc.invitation.invitedBy,
          invitedOn: doc.invitation.invitedOn.toISOString(),
        }
      : null,
    displayName: null,
    email: null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Tenant Member Repository ────────────────────────────────────────────────

export class TenantMemberRepository {
  constructor(private readonly collection: Collection<TenantMemberDocument>) {}

  async findByUserAndTenant(userId: string, tenantId: string): Promise<TenantMember | null> {
    const doc = await this.collection.findOne({ userId, tenantId });

    return doc ? toDomain(doc) : null;
  }

  /**
   * Members of a tenant, ordered by `userId` ascending.
   *
   * The order is now a promise rather than an accident of insertion.
   * Natural collection order was documented as "same as before" and two
   * clients could legitimately disagree about what row three is the moment
   * this list is paginated. `userId` is unique per tenant (the compound
   * unique index), so the order is total and needs no tie-breaker.
   */
  async findByTenant(tenantId: string): Promise<TenantMember[]> {
    const docs = await this.collection.find({ tenantId }).sort({ userId: 1 }).toArray();

    return docs.map(toDomain);
  }

  async findByUser(userId: string): Promise<TenantMember[]> {
    const docs = await this.collection.find({ userId }).toArray();

    return docs.map(toDomain);
  }

  /**
   * Members of a tenant with their user profiles joined server-side in ONE
   * round-trip (`$lookup` + `$unwind`, soft-deleted users excluded). Replaces
   * the previous `findByTenant` → `users.$in` two-step enrichment.
   *
   * The order is deterministic and owned HERE, not by the reader's
   * browser. Display name first (lower-cased, so `ada` and `Ada` do not split
   * by insertion), then e-mail, then `userId` as the final tie-breaker —
   * without it, two members with no profile would have no defined order. A
   * soft-deleted user joins nothing, so `$$REMOVE` leaves its sort key absent
   * and Mongo places a missing field last. The client used to re-sort this
   * same list with `localeCompare`, so the order depended on each reader's
   * own locale data; that second ordering is gone.
   */
  async findByTenantWithUsers(
    tenantId: string,
  ): Promise<(TenantMember & { userEmail: string | null; userDisplayName: string | null })[]> {
    const docs = await this.collection
      .aggregate([
        { $match: { tenantId } },
        {
          $lookup: {
            from: 'users',
            let: { uid: '$userId' },
            pipeline: [{ $match: { $expr: { $eq: ['$id', '$$uid'] }, deletedAt: null } }],
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            _sortName: { $toLower: { $ifNull: ['$user.displayName', '$$REMOVE'] } },
            _sortEmail: { $toLower: { $ifNull: ['$user.email', '$$REMOVE'] } },
          },
        },
        { $sort: { _sortName: 1, _sortEmail: 1, userId: 1 } },
        { $project: { _sortName: 0, _sortEmail: 0 } },
      ])
      .toArray();

    return docs.map((doc) => {
      const member = toDomain(doc as TenantMemberDocument);
      const user = (doc as { user?: { email?: string; displayName?: string } | null }).user;

      return {
        ...member,
        userEmail: user?.email ?? null,
        userDisplayName: user?.displayName ?? null,
      };
    });
  }

  /**
   * Memberships of a user with the tenant documents joined server-side in ONE
   * round-trip. Replaces the previous `findByUser` → `tenants.$in` two-step
   * lookup in `listTenantsWithRole`. Order: natural collection order (same as
   * `findByUser` had). Tenants are returned unfiltered (status checks stay in
   * the service), `tenant` is null when the tenant document is missing.
   */
  async findByUserWithTenants(
    userId: string,
  ): Promise<{ membership: TenantMember; tenant: import('@task-board/shared').Tenant | null }[]> {
    const docs = await this.collection
      .aggregate([
        { $match: { userId } },
        {
          $lookup: {
            from: 'tenants',
            localField: 'tenantId',
            foreignField: 'id',
            as: 'tenant',
          },
        },
        { $unwind: { path: '$tenant', preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    return docs.map((doc) => {
      const member = toDomain(doc as TenantMemberDocument);
      const tenantDoc = (doc as { tenant?: Record<string, unknown> | null }).tenant;

      return {
        membership: member,
        tenant: tenantDoc ? tenantToDomain(tenantDoc as never) : null,
      };
    });
  }

  async findById(id: string): Promise<TenantMemberDocument | null> {
    return this.collection.findOne({ id });
  }

  /**
   * Bulk lookup by ids — single `$in` query. Used by batch enrichment paths
   * (e.g. audit-log label resolution) to avoid N+1 per-event lookups.
   */
  async findByIds(ids: string[]): Promise<TenantMember[]> {
    if (ids.length === 0) return [];

    const docs = await this.collection.find({ id: { $in: ids } }).toArray();

    return docs.map(toDomain);
  }

  // `countActiveByTenant(tenantId)` was removed as dead code — no route, no
  // service and no quota check reads it. Its F11 compound index
  // (tenantId+status) went with it: the index-coverage guardrail in
  // `db/migrations.test.ts` enforces exactly that pairing, and the plain
  // `{tenantId: 1}` that `findByTenant` uses is untouched. `countOwnedTenants`,
  // which drives the plan-limit guard, is a different query and is kept.

  async countOwnedTenants(userId: string): Promise<number> {
    return this.collection.countDocuments({ userId, role: TenantRole.OWNER });
  }

  async findByInvitedEmail(email: string): Promise<TenantMemberDocument[]> {
    return this.collection.find({ 'invitation.invitedEmail': email }).toArray();
  }

  async findPendingByEmail(email: string): Promise<TenantMemberDocument[]> {
    return this.collection
      .find({
        'invitation.invitedEmail': email,
        'invitation.status': InvitationStatus.PENDING,
      })
      .toArray();
  }

  async findByInvitationToken(tokenHash: string): Promise<TenantMemberDocument | null> {
    return this.collection.findOne({
      'invitation.tokenHash': tokenHash,
      'invitation.status': InvitationStatus.PENDING,
    });
  }

  async create(input: {
    tenantId: string;
    userId: string;
    role: string;
    status: string;
    expiresAt?: Date | null;
    invitation?: InvitationDocument | null;
  }): Promise<TenantMember> {
    const now = new Date();
    const doc: TenantMemberDocument = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      status: input.status,
      expiresAt: input.expiresAt ?? null,
      invitation: input.invitation ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  async update(
    id: string,
    input: Partial<Pick<TenantMemberDocument, 'role' | 'status' | 'expiresAt' | 'invitation'>>,
  ): Promise<TenantMember | null> {
    const result = await this.collection.findOneAndUpdate(
      { id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  async updateRole(tenantId: string, userId: string, role: string): Promise<TenantMember | null> {
    const result = await this.collection.findOneAndUpdate(
      { userId, tenantId },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ userId, tenantId });

    return result.deletedCount > 0;
  }

  /** Delete all tenant memberships for a user (used on user deletion) */
  async deleteByUserId(userId: string): Promise<void> {
    await this.collection.deleteMany({ userId });
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ id });

    return result.deletedCount > 0;
  }
}
