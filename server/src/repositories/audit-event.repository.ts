import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type {
  AuditEvent,
  AuditActor,
  AuditChange,
  AuditEntityType,
  AuditAction,
  SortDirection,
} from '@task-board/shared';
import { QUERY_MAX_TIME_MS_LIST } from '../db/query-timeout.js';

// guardrail:no-base-repository 2026-09-29 — the base class would hand this
// repository a `delete(id)`, and the retention question is now DECIDED in
// the direction that makes that method wrong: audit rows are retired by a
// time-to-live index on `createdAt` (see `db/migrations.ts`), never by an
// application delete. Inheriting a single-row delete would hand the codebase a
// per-event erase that no policy sanctions. Its reads are keyset list queries,
// not id lookups. See `rules/guardrails.guardrail.test.ts` (P-03).

// Required MongoDB indexes (see db/migrations.ts) — each one ends in
// `createdAt` + `_id` because that is the SORT this repository issues (audit
// `createdAt` is a wall-clock millisecond, so it is not unique on its
// own, and a sort over a non-unique key is not a total order — with
// `.skip()/.limit()` the server may order a tied group differently on two
// consecutive pages and the same event appears twice, or not at all.
// - { projectId: 1, createdAt: -1, _id: -1 }
// - { projectId: 1, entityType: 1, createdAt: -1, _id: -1 }
// - { projectId: 1, action: 1, createdAt: -1, _id: -1 }
// - { projectId: 1, 'actor.userId': 1, createdAt: -1, _id: -1 }
// - { projectId: 1, entityId: 1, createdAt: -1, _id: -1 }
// - { tenantId: 1, projectId: 1, createdAt: -1, _id: -1 }         (F11 — tenant-wide view)
// - { tenantId: 1, createdAt: -1, _id: -1 }

export interface AuditEventDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  tenantId: string;
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  actor: AuditActor;
  changes: AuditChange[];
  createdAt: Date;
}

function toDomain(doc: AuditEventDocument): AuditEvent {
  return {
    id: doc.id,
    tenantId: doc.tenantId,
    projectId: doc.projectId,
    entityType: doc.entityType as AuditEntityType,
    entityId: doc.entityId,
    action: doc.action as AuditAction,
    actor: doc.actor,
    changes: doc.changes,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Filter options for the audit list — mirrors the (Zod-validated) output of
 * `AuditQuerySchema`.
 *
 * `entityType`/`action` were widened to `string` and the direction was a
 * hand-copied `'asc' | 'desc'`. Both are now the shared unions, so a value the
 * schema cannot produce cannot be typed here either, and the `| undefined` on
 * every optional field is what `exactOptionalPropertyTypes` requires when the
 * route forwards a parsed query object verbatim.
 */
export interface AuditQueryOptions {
  page?: number | undefined;
  limit?: number | undefined;
  entityType?: AuditEntityType | undefined;
  entityId?: string | undefined;
  /** Filter by action (CREATED | UPDATED | DELETED) */
  action?: AuditAction | undefined;
  /** Filter by actor user id */
  actorId?: string | undefined;
  /** Sort by createdAt — defaults to 'desc' */
  sort?: SortDirection | undefined;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class AuditEventRepository {
  constructor(private readonly collection: Collection<AuditEventDocument>) {}

  async create(input: {
    tenantId: string;
    projectId: string | null;
    entityType: string;
    entityId: string;
    action: string;
    actor: AuditActor;
    changes: AuditChange[];
  }): Promise<AuditEvent> {
    const doc: AuditEventDocument = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  /**
   * TOP-3 №2: persist a batch of audit events in ONE `insertMany`.
   *
   * Same document shape as {@link create}; every event keeps its own UUID.
   * `ordered: false` keeps per-event independence without introducing an
   * ordering mechanism.
   *
   * The tie-breaker that makes the list's sort a total order is `_id`, and
   * it is generated here, in input order, so `(createdAt, _id)` is unique even
   * when a whole batch shares one millisecond. A caller that pins `createdAt`
   * ({@link AuditService.logMany} hands each event its own, strictly increasing
   * value) therefore cannot make two events collide on the sort key.
   */
  async createMany(
    inputs: {
      tenantId: string;
      projectId: string | null;
      entityType: string;
      entityId: string;
      action: string;
      actor: AuditActor;
      changes: AuditChange[];
      createdAt?: Date;
    }[],
  ): Promise<void> {
    if (inputs.length === 0) return;

    const docs: AuditEventDocument[] = inputs.map((input) => ({
      id: randomUUID(),
      ...input,
      createdAt: input.createdAt ?? new Date(),
    }));

    await this.collection.insertMany(docs, { ordered: false });
  }

  async findByProject(projectId: string, options: AuditQueryOptions = {}): Promise<PaginatedResult<AuditEvent>> {
    const { page = 1, limit = 20 } = options;
    const query: Record<string, unknown> = { projectId };

    this.applyFilters(query, options);

    return this.runQuery(query, options, page, limit);
  }

  async findByTenant(tenantId: string, options: AuditQueryOptions = {}): Promise<PaginatedResult<AuditEvent>> {
    const { page = 1, limit = 20 } = options;
    const query: Record<string, unknown> = { tenantId };

    this.applyFilters(query, options);

    return this.runQuery(query, options, page, limit);
  }

  private applyFilters(query: Record<string, unknown>, options: AuditQueryOptions): void {
    if (options.entityType) query.entityType = options.entityType;
    if (options.entityId) query.entityId = options.entityId;
    if (options.action) query.action = options.action;
    if (options.actorId) query['actor.userId'] = options.actorId;
  }

  private async runQuery(
    query: Record<string, unknown>,
    options: AuditQueryOptions,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<AuditEvent>> {
    const direction = options.sort === 'asc' ? 1 : -1;
    const skip = (page - 1) * limit;
    // `maxTimeMS` on both halves. `audit_events` is append-only IN NORMAL
    // OPERATION and is BOUNDED BY A RETENTION WINDOW: a
    // time-to-live index on `createdAt` removes each event
    // `AUDIT_RETENTION_DAYS` after it was written, so the collection no longer
    // grows without bound — but the window is ~400 days, which is still far more
    // than a skip/limit page wants to walk. The budget turns an over-long scan
    // into a 503 instead of a Worker that never gets its CPU back.
    //
    // "Append-only" is a description of the WRITE PATH, and it is now the whole
    // truth about writes: no service, route or purge updates or deletes an audit
    // row. The project purge used to call `deleteByProject` below and remove every
    // event for a purged project — including the event recording who purged it.
    // That delete is gone: the purge APPENDS its own record instead, and the
    // log's contents change only on the TTL clock.
    //
    // What a reader of this log should NOT infer: that a row is permanent. Once
    // `AUDIT_RETENTION_DAYS` have passed, MongoDB's TTL monitor removes it —
    // asynchronously, within roughly a minute, not at the instant the window
    // closes. "The retention window has passed" and "the row is gone" are
    // different statements.
    //
    // `_id` is the TIE-BREAKER that makes the sort a total order.
    // The direction is the same as `createdAt`'s on both fields: the leading
    // fields are pinned by equality, so one index serves both directions by
    // reverse traversal and the sort never becomes a blocking SORT.
    const [docs, total] = await Promise.all([
      this.collection
        .find(query, { maxTimeMS: QUERY_MAX_TIME_MS_LIST })
        .sort({ createdAt: direction, _id: direction })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.collection.countDocuments(query, { maxTimeMS: QUERY_MAX_TIME_MS_LIST }),
    ]);

    return {
      data: docs.map(toDomain),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Delete every audit event belonging to a project.
   *
   * **NOT CALLED BY ANYTHING, AND THAT IS THE POINT.** This method used to
   * be the last step of the project purge, where it removed the whole project's
   * history — including the `PROJECT/DELETED` event naming whoever purged it, so
   * a permanent delete destroyed the record of the deletion. The retention
   * question has been decided (a time-to-live index on `createdAt`, see
   * `db/migrations.ts`), so the purge appends its record instead of erasing the
   * log, and nothing calls this any more.
   *
   * It is kept, unused, for one reason: deleting the method would also delete the
   * capability, and a capability that has to be re-added deliberately is a
   * capability nobody adds deliberately. `purge-guardrail.test.ts` asserts that no
   * service, route or repository calls it — that assertion is what makes keeping
   * it safe, and it is the artefact that fails if someone wires it back up.
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
