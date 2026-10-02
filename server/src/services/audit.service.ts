import type { AuditEvent, AuditActor, AuditChange, AuditEntityType, AuditAction } from '@task-board/shared';
import {
  AuditEventRepository,
  type AuditCorrelation,
  type AuditQueryOptions,
  type PaginatedResult,
} from '../repositories/audit-event.repository.js';
import { getRequestCorrelation } from '../middleware/request-id.js';

export interface AuditServiceUserRepo {
  findById(id: string): Promise<{ id: string; displayName?: string; name?: string; email: string } | null>;
}

/**
 * The actor recorded for an event NO human performed — the scheduled purge (
 * item 9) writing the record of what it destroyed.
 *
 * `userId` is `null`, which is the value the audit document type already defines
 * for "this actor is not a user id" (it was introduced for deleted users). It is
 * deliberately NOT a sentinel user id: a fabricated `userId` would be resolvable
 * by the enrichment service and would eventually collide with, or be confused
 * for, a real account.
 */
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  displayName: 'System (scheduled purge)',
};

export class AuditService {
  constructor(
    private readonly auditRepo: AuditEventRepository,
    private readonly userRepo: AuditServiceUserRepo,
    private readonly enrichment?: { enrichEvents(events: AuditEvent[]): Promise<AuditEvent[]> },
  ) {}

  /**
   * Log an audit event. Actor displayName is captured at write time.
   *
   * THE WRITE IS A POST-COMMIT SIDE EFFECT, NOT PART OF THE ENTITY WRITE, and
   * that is a deliberate shape rather than an oversight. The service is called
   * AFTER the entity write has already committed, on a connection with no
   * transaction open: the audit row and the mutation it records are two separate
   * writes, so a failure between them leaves an event missing while the entity
   * change stands. The alternative — folding the audit insert into the entity's
   * transaction — would make a lost audit row impossible, and it costs
   * something this design deliberately does not pay: every audited write would
   * hold a transaction (and its session, and its retry semantics) across the
   * business logic, and the current MongoDB topology gives no cross-collection
   * transaction guarantee to lean on. Choosing between "an audit row can be
   * lost" and "every audited write becomes a transaction" is an owner decision,
   * so the gap is documented here rather than silently closed in either
   * direction. What IS guaranteed is that when the row IS written it names the
   * request that caused it, so a gap is visible instead of unattributable.
   */
  async log(input: {
    tenantId: string;
    projectId: string | null;
    entityType: AuditEntityType;
    entityId: string;
    action: AuditAction;
    actorId: string;
    changes?: AuditChange[];
  }): Promise<AuditEvent> {
    const actor = await this.captureActor(input.actorId);

    return this.auditRepo.create({
      tenantId: input.tenantId,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actor,
      changes: input.changes ?? [],
      ...this.currentCorrelation(),
    });
  }

  /**
   * Record an event performed by the SYSTEM rather than by a user.
   *
   * Used by the scheduled purge, which must leave behind the record of what it
   * deleted (the old cascade deleted the very rows that named the actor of
   * the deletion, so a permanent delete destroyed its own audit trail). It writes
   * the SAME document shape as {@link log} — there is no second event format —
   * it only skips the user lookup, because there is no user to look up.
   */
  async logSystem(input: {
    tenantId: string;
    projectId: string | null;
    entityType: AuditEntityType;
    entityId: string;
    action: AuditAction;
    changes?: AuditChange[];
  }): Promise<AuditEvent> {
    return this.auditRepo.create({
      tenantId: input.tenantId,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actor: SYSTEM_ACTOR,
      changes: input.changes ?? [],
      ...this.currentCorrelation(),
    });
  }

  /**
   * TOP-3 №2: log a batch of events with ONE actor lookup and ONE insert.
   * The actor is identical across the batch (e.g. every task of a single
   * bulk update). Each event keeps its own `changes` and `createdAt`.
   * No-op for an empty batch — no DB operations.
   *
   * `createdAt` is a WALL-CLOCK MILLISECOND, so a whole batch stamped
   * with one `new Date()` (the previous behaviour) made every event in a bulk
   * update share a sort key — and the audit list is read back in `createdAt`
   * order with skip/limit paging, so a 500-task bulk update produced 500 events
   * whose relative order was undefined. Each event now gets its own stamp,
   * strictly increasing in batch order, so the list has one deterministic
   * order even before the repository's `_id` tiebreaker is considered.
   */
  async logMany(
    actorId: string,
    events: {
      tenantId: string;
      projectId: string | null;
      entityType: AuditEntityType;
      entityId: string;
      action: AuditAction;
      changes?: AuditChange[];
    }[],
  ): Promise<void> {
    if (events.length === 0) return;

    const actor = await this.captureActor(actorId);
    // One clock read for the batch, then +1 ms per event: a bulk update of N
    // tasks stamps N DISTINCT, increasing timestamps without N wall-clock reads
    // (and without a stamp that runs ahead of real time by more than N ms).
    const base = Date.now();
    const correlation = this.currentCorrelation();

    await this.auditRepo.createMany(
      events.map((event, index) => ({
        tenantId: event.tenantId,
        projectId: event.projectId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        actor,
        changes: event.changes ?? [],
        createdAt: new Date(base + index),
        ...correlation,
      })),
    );
  }

  /**
   * Read path. Authorization is enforced by the ROUTE (`routes/audit.ts`):
   * `requirePermission('view_audit_events', …)` plus a tenant assertion of the
   * addressed project. This service is deliberately kept free of the tenant
   * lookup so the write path (used by every other service) stays cheap; callers
   * MUST NOT expose it without those two checks.
   */
  async queryByProject(projectId: string, options: AuditQueryOptions = {}): Promise<PaginatedResult<AuditEvent>> {
    const result = await this.auditRepo.findByProject(projectId, options);

    return this.enrich(result);
  }

  /**
   * `tenantId` MUST be the caller's tenant from the request context —
   * never a path/body value. `routes/audit.ts` rejects a `:tenantId` that does
   * not match the context with 404 before reaching this method.
   */
  async queryByTenant(tenantId: string, options: AuditQueryOptions = {}): Promise<PaginatedResult<AuditEvent>> {
    const result = await this.auditRepo.findByTenant(tenantId, options);

    return this.enrich(result);
  }

  /** Resolve human-readable labels for one page — batched, never per-event. */
  private async enrich(result: PaginatedResult<AuditEvent>): Promise<PaginatedResult<AuditEvent>> {
    if (!this.enrichment) return result;

    return { ...result, data: await this.enrichment.enrichEvents(result.data) };
  }

  /**
   * The correlation of the request currently being served, or empty when there
   * is none (the scheduled purge, a script, a unit test).
   *
   * Read from the request-scoped store rather than from a parameter: threading a
   * correlation id through every audited call site would change every service
   * signature to carry an observability field, and the store already exists for
   * exactly this purpose (see `middleware/request-id.ts`). Outside a request the
   * fields are omitted entirely, so an audit row reads honestly as "no request
   * caused this" rather than carrying a fabricated id.
   */
  private currentCorrelation(): AuditCorrelation {
    const correlation = getRequestCorrelation();

    return correlation ? { requestId: correlation.requestId, upstreamRequestId: correlation.upstreamRequestId } : {};
  }

  private async captureActor(userId: string): Promise<AuditActor> {
    // Re-reads the user at write time so the recorded display name is the one
    // the action had, not the one a caller happened to hold.
    const user = await this.userRepo.findById(userId);

    return {
      userId,
      displayName: user?.displayName ?? user?.name ?? user?.email ?? 'Unknown User',
    };
  }
}
