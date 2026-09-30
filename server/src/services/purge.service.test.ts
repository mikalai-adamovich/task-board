/**
 * The scheduled purge.
 *
 * This is the highest-risk change in the remediation programme: it is the first
 * code in the repository that DELETES data on a timer. The three properties below
 * are asserted separately because each fails in a different direction, and the
 * third is the one the brief calls out.
 *
 *   1. **It purges what is due, and only what is due.** A purge that runs early
 *      destroys data inside its own grace period; a purge that never runs is the
 *      defect being fixed.
 *   2. **It is IDEMPOTENT.** It is driven by a timer, so a retry, an overlapping
 *      tick and a manual re-run are ordinary events rather than incidents. The
 *      property is not "running twice does not throw" — it is "running twice does
 *      not destroy anything twice and does not report a failure for work already
 *      done".
 *   3. **A partial failure cannot orphan data silently.** Every cascade deletes
 *      children first and the ROOT DOCUMENT last, so a failure anywhere leaves the
 *      root in place — still `DELETION_PENDING`, still selected on the next run.
 *      The failure is also REPORTED rather than swallowed, because a purge that
 *      fails quietly is indistinguishable from a purge with nothing to do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PurgeService, type PurgeProjectRepo, type PurgeTenantRepo } from './purge.service.js';

const NOW = new Date('2025-06-01T12:00:00.000Z');
const PAST = '2025-05-01T00:00:00.000Z'; // deadline passed
const FUTURE = '2025-07-01T00:00:00.000Z'; // deadline not reached

interface Stored {
  id: string;
  status: string;
  deletionScheduledAt: string | null;
}

/**
 * A repository fake that behaves like the real one for the two things the purge
 * depends on: it only reports ids that are actually due, and it stops reporting
 * an id once the entity has been deleted. Modelling the SECOND half is what makes
 * the idempotence assertions mean anything — a fake that always returned the same
 * id would pass a "running twice is safe" test while proving nothing.
 */
function createEntityRepo(seed: Stored[]) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));

  return {
    rows,
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    findDue: vi.fn(async (now: Date) =>
      [...rows.values()]
        .filter((row) => row.status === 'DELETION_PENDING' && row.deletionScheduledAt !== null)
        .filter((row) => new Date(row.deletionScheduledAt as string).getTime() <= now.getTime())
        .map((row) => ({ id: row.id })),
    ),
  };
}

describe('PurgeService', () => {
  let projectRepo: ReturnType<typeof createEntityRepo>;
  let tenantRepo: ReturnType<typeof createEntityRepo>;
  let purgeProjectData: ReturnType<typeof vi.fn>;
  let purgeTenantData: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    projectRepo = createEntityRepo([]);
    tenantRepo = createEntityRepo([]);
    purgeProjectData = vi.fn().mockResolvedValue(undefined);
    purgeTenantData = vi.fn().mockResolvedValue(undefined);
  });

  function buildService() {
    return new PurgeService(
      projectRepo as unknown as PurgeProjectRepo,
      tenantRepo as unknown as PurgeTenantRepo,
      { purgeProjectData },
      { purgeTenantData },
    );
  }

  /** A successful purge removes the row, which is what makes the re-run a no-op. */
  function deleteOnPurge(repo: ReturnType<typeof createEntityRepo>, purge: ReturnType<typeof vi.fn>) {
    purge.mockImplementation(async (id: string) => {
      repo.rows.delete(id);
    });
  }

  describe('1 — what is due, and only what is due', () => {
    it('purges a project whose deadline has passed', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      deleteOnPurge(projectRepo, purgeProjectData);

      const report = await buildService().runDue(NOW);

      expect(purgeProjectData).toHaveBeenCalledWith('p1');
      expect(report.projects).toEqual([{ kind: 'project', id: 'p1', outcome: 'purged' }]);
      expect(report.failed).toEqual([]);
    });

    it('leaves a project whose grace period has not elapsed alone', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: FUTURE }]);

      const report = await buildService().runDue(NOW);

      // The whole point of the grace period: a project scheduled for deletion is
      // still recoverable, and a purge that ran early would make that a lie.
      expect(purgeProjectData).not.toHaveBeenCalled();
      expect(report.projects).toEqual([]);
    });

    it('leaves an ACTIVE project alone even if it carries a past deadline', async () => {
      // A restored or re-activated project is not scheduled for deletion whatever
      // its deadline field says. Trusting the date alone would delete live data.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'ACTIVE', deletionScheduledAt: PAST }]);

      await buildService().runDue(NOW);

      expect(purgeProjectData).not.toHaveBeenCalled();
    });

    it('treats a missing deadline as NOT due rather than immediately due', async () => {
      // Same reasoning as the unparseable case: the selection query excludes it,
      // and the re-read guard is the second line of defence.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      projectRepo.findDue = vi.fn().mockResolvedValue([{ id: 'p1' }]);
      projectRepo.findById.mockResolvedValueOnce({
        id: 'p1',
        status: 'DELETION_PENDING',
        deletionScheduledAt: null,
      });

      const report = await buildService().runDue(NOW);

      expect(purgeProjectData).not.toHaveBeenCalled();
      expect(report.projects).toEqual([{ kind: 'project', id: 'p1', outcome: 'not-due' }]);
    });

    it('treats an unparseable deadline as NOT due', async () => {
      // Driven through the RE-READ, which is the path that can actually see such
      // a value: a legacy or hand-written row whose deadline is not an ISO date.
      // The selection query would not match it, and the guard before the purge is
      // the second line of defence that makes the query's strictness sufficient.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      projectRepo.findDue = vi.fn().mockResolvedValue([{ id: 'p1' }]);
      projectRepo.findById.mockResolvedValueOnce({
        id: 'p1',
        status: 'DELETION_PENDING',
        deletionScheduledAt: 'not-a-date',
      });

      const report = await buildService().runDue(NOW);

      // Destroying data on the strength of a value this code cannot read is not a
      // decision it may take.
      expect(purgeProjectData).not.toHaveBeenCalled();
      expect(report.projects[0]?.outcome).toBe('not-due');
    });

    it('purges workspaces on the same rule', async () => {
      tenantRepo = createEntityRepo([
        { id: 't-due', status: 'DELETION_PENDING', deletionScheduledAt: PAST },
        { id: 't-waiting', status: 'DELETION_PENDING', deletionScheduledAt: FUTURE },
      ]);
      deleteOnPurge(tenantRepo, purgeTenantData);

      const report = await buildService().runDue(NOW);

      expect(purgeTenantData).toHaveBeenCalledTimes(1);
      expect(purgeTenantData).toHaveBeenCalledWith('t-due');
      expect(report.tenants).toEqual([{ kind: 'tenant', id: 't-due', outcome: 'purged' }]);
    });

    it('purges workspaces BEFORE standalone projects', async () => {
      // A project belonging to a workspace being destroyed goes with it. Purging
      // projects first would select work that is about to be removed by its
      // parent — harmless today, wasteful, and a source of confusing audit records
      // the moment the two orders disagree about which parent owns what.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      tenantRepo = createEntityRepo([{ id: 't1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      deleteOnPurge(tenantRepo, purgeTenantData);
      deleteOnPurge(projectRepo, purgeProjectData);

      await buildService().runDue(NOW);

      const tenantOrder = purgeTenantData.mock.invocationCallOrder[0] ?? 0;
      const projectOrder = purgeProjectData.mock.invocationCallOrder[0] ?? 0;

      expect(tenantOrder).toBeLessThan(projectOrder);
    });
  });

  describe('2 — idempotence', () => {
    it('running twice purges once and does no work the second time', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      deleteOnPurge(projectRepo, purgeProjectData);

      const service = buildService();
      const first = await service.runDue(NOW);
      const second = await service.runDue(NOW);

      expect(first.projects).toEqual([{ kind: 'project', id: 'p1', outcome: 'purged' }]);
      expect(purgeProjectData).toHaveBeenCalledTimes(1);
      // The second run finds nothing: the entity is gone, so there is no second
      // attempt, no error, and no "already deleted" special case to get wrong.
      expect(second.projects).toEqual([]);
      expect(second.failed).toEqual([]);
    });

    it('an entity deleted by an overlapping tick is reported already-gone, not failed', async () => {
      // The re-read before acting is what makes this safe: the row was selected
      // while it existed and is gone by the time the purge looks.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      projectRepo.findById.mockResolvedValueOnce(null);

      const report = await buildService().runDue(NOW);

      expect(purgeProjectData).not.toHaveBeenCalled();
      expect(report.projects).toEqual([{ kind: 'project', id: 'p1', outcome: 'already-gone' }]);
      expect(report.failed).toEqual([]);
    });

    it('an entity whose deletion was cancelled between selection and action is skipped', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      // Someone restored it in the gap.
      projectRepo.findById.mockResolvedValueOnce({
        id: 'p1',
        status: 'ACTIVE',
        deletionScheduledAt: null,
      });

      const report = await buildService().runDue(NOW);

      expect(purgeProjectData).not.toHaveBeenCalled();
      expect(report.projects[0]?.outcome).toBe('not-due');
    });

    it('re-running after a failure retries the entity and succeeds', async () => {
      // The retry property the root-last ordering exists to provide.
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      purgeProjectData.mockRejectedValueOnce(new Error('replica set stepped down'));
      deleteOnPurge(projectRepo, purgeProjectData);

      const service = buildService();
      const first = await service.runDue(NOW);
      const second = await service.runDue(NOW);

      expect(first.failed).toEqual([{ kind: 'project', id: 'p1', error: 'replica set stepped down' }]);
      // The entity was never removed from the collection, so the second run
      // selected it again — which is exactly what a partial cascade needs.
      expect(second.projects).toEqual([{ kind: 'project', id: 'p1', outcome: 'purged' }]);
      expect(purgeProjectData).toHaveBeenCalledTimes(2);
    });
  });

  describe('3 — a partial failure is reported and never silently orphaned', () => {
    it('one failing entity does not stop the others', async () => {
      // A purge that aborts on the first failure would let a single un-deletable
      // row block every deletion behind it, for as long as it stays un-deletable.
      projectRepo = createEntityRepo([
        { id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST },
        { id: 'p2', status: 'DELETION_PENDING', deletionScheduledAt: PAST },
        { id: 'p3', status: 'DELETION_PENDING', deletionScheduledAt: PAST },
      ]);
      purgeProjectData.mockImplementation(async (id: string) => {
        if (id === 'p2') throw new Error('write concern timeout');

        projectRepo.rows.delete(id);
      });

      const report = await buildService().runDue(NOW);

      expect(purgeProjectData).toHaveBeenCalledWith('p1');
      expect(purgeProjectData).toHaveBeenCalledWith('p3');
      expect(report.projects.filter((entry) => entry.outcome === 'purged').map((entry) => entry.id)).toEqual([
        'p1',
        'p3',
      ]);
      expect(report.failed).toEqual([{ kind: 'project', id: 'p2', error: 'write concern timeout' }]);
    });

    it('the failure is logged, not only returned', async () => {
      // A failure that exists only in a return value nobody inspects is silent in
      // production, where the only observer is the log.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      purgeProjectData.mockRejectedValue(new Error('boom'));

      await buildService().runDue(NOW);

      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

      expect(logged).toContain('p1');
      expect(logged).toContain('boom');
      errorSpy.mockRestore();
    });

    it('a non-Error throw is still reported with a usable message', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      purgeProjectData.mockRejectedValue('a bare string');

      const report = await buildService().runDue(NOW);

      expect(report.failed).toEqual([{ kind: 'project', id: 'p1', error: 'a bare string' }]);
    });

    it('a failing workspace does not stop the project pass', async () => {
      projectRepo = createEntityRepo([{ id: 'p1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      tenantRepo = createEntityRepo([{ id: 't1', status: 'DELETION_PENDING', deletionScheduledAt: PAST }]);
      purgeTenantData.mockRejectedValue(new Error('tenant delete failed'));
      deleteOnPurge(projectRepo, purgeProjectData);

      const report = await buildService().runDue(NOW);

      expect(report.failed).toEqual([{ kind: 'tenant', id: 't1', error: 'tenant delete failed' }]);
      expect(purgeProjectData).toHaveBeenCalledWith('p1');
    });
  });

  describe('the run itself', () => {
    it('reports the instant it ran, so a report can be correlated with a log line', async () => {
      const report = await buildService().runDue(NOW);

      expect(report.startedAt).toBe(NOW);
    });

    it('an empty run is a success, not a failure', async () => {
      const report = await buildService().runDue(NOW);

      expect(report).toEqual({ startedAt: NOW, projects: [], tenants: [], failed: [] });
    });
  });
});
