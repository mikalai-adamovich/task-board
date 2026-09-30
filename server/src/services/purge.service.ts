/**
 * The purge actor.
 *
 * **What this is.** The two-phase delete was half-built: a project and a
 * workspace move to `DELETION_PENDING` with a 30-day grace deadline, and a
 * method exists to purge them — but nothing ever CALLED it. No scheduled handler,
 * no trigger, no reaper. "Delete" meant "write a status and hope".
 *
 * This service is the actor. It is driven by the platform's scheduled mechanism
 * (the Worker's `scheduled` entrypoint — see `server/src/index.ts`), never by a
 * request: a purge that a user can trigger is a purge with no grace period, which
 * is the one thing the two-phase design exists to provide.
 *
 * ── Why a scheduled handler and not a time-to-live index ──────────────────────
 * Both mechanisms are available on this platform and the decision was to build
 * ONE. A TTL index cannot do this job:
 *
 *   - TTL deletes a document when a DATE on THAT document passes. The purge must
 *     delete documents in nine OTHER collections in a defined order, and TTL has
 *     no notion of "children before parent".
 *   - TTL cannot decide whether a child was already removed, cannot report what
 *     it deleted, and leaves no record — which is the specific defect this
 *     package exists to fix: the old cascade destroyed the audit row naming
 *     the actor of the deletion).
 *   - A TTL index on `deletionScheduledAt` would also delete the row that says a
 *     purge FAILED, turning a recoverable, retryable state into a silent one.
 *
 * The TTL index IS built in this package, but for the one thing it is actually
 * good at: the audit RETENTION window (item 12, `db/migrations.ts`). Two
 * mechanisms, two unrelated jobs, no overlap.
 *
 * ── Ordering: why a partial failure cannot orphan data ────────────────────────
 * Every purge deletes CHILDREN FIRST and the ROOT DOCUMENT LAST. The root
 * document is the reaper's only index into the work: `findDue` selects entities
 * that are still in `DELETION_PENDING`, so if the root survives, the next run
 * finds the entity again and repeats the whole cascade. The cascade's own steps
 * are `deleteMany({ projectId })`-shaped, so re-running one is a no-op on
 * whatever it already removed.
 *
 * The guarantee this buys, stated precisely:
 *
 *   GUARANTEED — a failure at any step leaves the root document present, so the
 *   entity is re-selected on the next run and the cascade is retried in full. No
 *   data is orphaned by a failure, because the only thing that can point at
 *   orphaned data is the document the cascade has not deleted yet.
 *
 *   NOT GUARANTEED — atomicity across collections. There is no transaction here
 *   (a cross-collection transaction on a Worker with a five-connection pool is
 *   not a trade this code should make for a once-a-day batch), so between two
 *   steps of a cascade a reader can observe a partially purged entity. That
 *   window is bounded by the cascade's own duration and the entity is
 *   unreachable through the API in practice (the root is `DELETION_PENDING`,
 *   which every project-scoped write already refuses — see item 1).
 *
 *   NOT GUARANTEED — the audit record is written AT LEAST ONCE, not exactly
 *   once. It is written after the children and before the root, so a failure
 *   between those two steps means the next run writes a second record of a purge
 *   that did eventually complete. A duplicate is the safe direction; a MISSING
 *   record is the defect, and this ordering makes that impossible.
 */
import { ProjectStatus, TenantStatus } from '@task-board/shared';
import { createLogger } from '../utils/logger.js';

const log = createLogger({ scope: 'purge' });

/** What happened to one entity in one run. */
export type PurgeOutcome = 'purged' | 'already-gone' | 'not-due';

export interface PurgeEntityResult {
  kind: 'project' | 'tenant';
  id: string;
  outcome: PurgeOutcome;
}

export interface PurgeRunReport {
  /** Wall-clock the run started, for the log line. */
  startedAt: Date;
  projects: PurgeEntityResult[];
  tenants: PurgeEntityResult[];
  /** Entities whose cascade threw. The run continues; these are re-tried next time. */
  failed: { kind: 'project' | 'tenant'; id: string; error: string }[];
}

/** Narrow views of the two purges — the real implementations are the services. */
export interface PurgeProjectRepo {
  findById(id: string): Promise<{ id: string; status: string; deletionScheduledAt: string | null } | null>;
  findDue(now: Date): Promise<{ id: string }[]>;
}

export interface PurgeTenantRepo {
  findById(id: string): Promise<{ id: string; status: string; deletionScheduledAt: string | null } | null>;
  findDue(now: Date): Promise<{ id: string }[]>;
}

export interface PurgeProjectService {
  /**
   * Unconditional purge of one project's data and document. NO status check and
   * no caller context: the workspace purge calls this for projects that are
   * still `ACTIVE`, because the workspace they belong to is being destroyed.
   */
  purgeProjectData(projectId: string): Promise<void>;
}

export interface PurgeTenantService {
  /**
   * Unconditional purge of one workspace: its projects (each fully purged), its
   * memberships, its audit record, and last its own document. NO status check.
   */
  purgeTenantData(tenantId: string): Promise<void>;
}

export class PurgeService {
  /**
   * Every dependency is REQUIRED. A purge that silently skips a step
   * because a collaborator was `undefined` is the exact failure mode this
   * codebase already paid for once: `ProjectService`'s cascade repositories were
   * optional, so `permanentDelete` deleted the project document and nothing else,
   * with no error anywhere.
   */
  constructor(
    private readonly projectRepo: PurgeProjectRepo,
    private readonly tenantRepo: PurgeTenantRepo,
    private readonly projectService: PurgeProjectService,
    private readonly tenantService: PurgeTenantService,
  ) {}

  /**
   * Purge everything whose grace deadline has passed.
   *
   * Safe to run more than once — that is the point: it is driven by a timer, so
   * a retry, an overlapping tick, or a manual re-run are all ordinary events. It
   * is also safe to run on a database where a previous run half-completed: the
   * root document survived, so the entity is selected again and the cascade
   * repeats over whatever is left.
   *
   * One entity's failure never aborts the run. The failure is recorded in the
   * report AND logged at error level, and the entity stays in `DELETION_PENDING`
   * so it is re-selected next time — a purge that stops at the first bad entity
   * would let a single un-deletable row block every deletion behind it.
   */
  async runDue(now: Date = new Date()): Promise<PurgeRunReport> {
    const report: PurgeRunReport = { startedAt: now, projects: [], tenants: [], failed: [] };

    await this.purgeTenants(now, report);
    // Projects SECOND: a project belonging to a workspace purged above is already
    // gone, so this pass only sees genuinely standalone projects. The reverse
    // order would select projects that are about to be removed with their parent.
    await this.purgeProjects(now, report);

    log.info('Purge run complete', {
      projects: report.projects.length,
      tenants: report.tenants.length,
      purged: [...report.projects, ...report.tenants].filter((r) => r.outcome === 'purged').length,
      failed: report.failed.length,
    });

    return report;
  }

  private async purgeProjects(now: Date, report: PurgeRunReport): Promise<void> {
    const due = await this.projectRepo.findDue(now);

    for (const { id } of due) {
      try {
        const outcome = await this.purgeOneProject(id, now);

        report.projects.push({ kind: 'project', id, outcome });
      } catch (err) {
        this.recordFailure(report, 'project', id, err);
      }
    }
  }

  private async purgeTenants(now: Date, report: PurgeRunReport): Promise<void> {
    const due = await this.tenantRepo.findDue(now);

    for (const { id } of due) {
      try {
        const outcome = await this.purgeOneTenant(id, now);

        report.tenants.push({ kind: 'tenant', id, outcome });
      } catch (err) {
        this.recordFailure(report, 'tenant', id, err);
      }
    }
  }

  /**
   * Idempotence lives here, and it is a RE-READ rather than a try/catch: the
   * entity is fetched again inside the purge, so a project deleted by a previous
   * run (or by an overlapping tick) resolves to `already-gone` instead of
   * throwing a 404 the run would have to interpret.
   *
   * The status re-check is the second half: an entity whose deletion was
   * CANCELLED between selection and execution is `not-due`, and is left alone.
   */
  private async purgeOneProject(id: string, now: Date): Promise<PurgeOutcome> {
    const project = await this.projectRepo.findById(id);

    if (!project) {
      return 'already-gone';
    }

    if (!this.isDue(project.status, project.deletionScheduledAt, now)) {
      return 'not-due';
    }

    await this.projectService.purgeProjectData(id);

    return 'purged';
  }

  private async purgeOneTenant(id: string, now: Date): Promise<PurgeOutcome> {
    const tenant = await this.tenantRepo.findById(id);

    if (!tenant) {
      return 'already-gone';
    }

    if (!this.isDue(tenant.status, tenant.deletionScheduledAt, now)) {
      return 'not-due';
    }

    await this.tenantService.purgeTenantData(id);

    return 'purged';
  }

  /**
   * The ONE definition of "due", shared by both entity kinds.
   *
   * `deletionScheduledAt` is stored as a `Date` in MongoDB and mapped to an ISO
   * string by the repository; a legacy or hand-written row can carry a null, and
   * a null deadline is treated as NOT due rather than as immediately due — an
   * entity with no deadline is an entity nobody scheduled, and destroying it on a
   * guess is not a decision this code may take.
   */
  private isDue(status: string, deletionScheduledAt: string | null, now: Date): boolean {
    // A project and a workspace are both scheduled the same way, so both
    // constants are accepted; they are separate unions in the shared package and
    // naming both is what keeps this from reading as a copy-paste of one.
    if (status !== ProjectStatus.DELETION_PENDING && status !== TenantStatus.DELETION_PENDING) {
      return false;
    }

    if (!deletionScheduledAt) {
      return false;
    }

    const deadline = new Date(deletionScheduledAt);

    if (Number.isNaN(deadline.getTime())) {
      return false;
    }

    return deadline.getTime() <= now.getTime();
  }

  /**
   * A failure is never swallowed: it is logged with the entity id AND returned in
   * the report, so the caller (and the run's log line) can see it. The entity
   * stays in `DELETION_PENDING` and is re-selected on the next run.
   */
  private recordFailure(report: PurgeRunReport, kind: 'project' | 'tenant', id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    log.error('Purge failed — the entity stays scheduled and is retried on the next run', { kind, id, err: message });
    report.failed.push({ kind, id, error: message });
  }
}
