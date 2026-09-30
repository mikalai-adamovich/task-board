/**
 * The purge cascade's GUARDRAIL.
 *
 * `purge.service.test.ts` proves the ACTOR behaves. This proves the CASCADE, and
 * it does so at two levels on purpose:
 *
 *   - **Behavioural**, against the real `ProjectService` and `TenantService` with
 *     fake repositories. This is what fails if the ordering changes.
 *   - **Source-level**, for the properties no behavioural test can observe: that
 *     the purge does not delete audit rows ANYWHERE, and that the mechanism the
 *     purge is triggered by is actually declared.
 *
 * Why the ordering is the whole point: a cascade that deletes the ROOT document
 * before its children destroys the only pointer to work that has not been done
 * yet. The failure is then permanent and invisible — the data is still in the
 * database, owned by nothing, with no scheduled deletion left to find it. So the
 * root is deleted last, and the tests below assert the ORDER, not merely that
 * every repository was called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProjectService } from './project.service.js';
import { TenantService } from './tenant.service.js';
import { SYSTEM_ACTOR } from './audit.service.js';

const SRC = join(dirname(import.meta.filename), '..');
/** Strip comments, so documenting a removed call cannot satisfy a contract row. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function cascadeRepos() {
  return {
    taskRepo: { findIdsByProject: vi.fn().mockResolvedValue(['task-1', 'task-2']), deleteByProject: vi.fn() },
    commentRepo: { deleteByTaskIds: vi.fn() },
    relationshipRepo: { deleteByProject: vi.fn() },
    sprintRepo: { deleteByProject: vi.fn() },
    boardRepo: { deleteByProject: vi.fn() },
    labelRepo: { deleteByProject: vi.fn() },
    statusRepo: { deleteByProject: vi.fn() },
    taskTypeRepo: { deleteByProject: vi.fn() },
    filterRepo: { deleteByProject: vi.fn() },
    auditRepo: { deleteByProject: vi.fn() },
    counterRepo: { deleteByProject: vi.fn() },
  };
}

const PENDING_PROJECT = {
  id: 'proj-1',
  tenantId: 'tenant-1',
  key: 'TEST',
  name: 'Test Project',
  description: null,
  status: 'DELETION_PENDING',
  defaultStatusId: 'status-todo',
  archiveReason: null,
  deletionScheduledAt: '2025-01-01T00:00:00.000Z',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

describe('C-2 — the project cascade deletes children before the root', () => {
  let repos: ReturnType<typeof cascadeRepos>;
  let projectRepo: { findById: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let memberRepo: { findByProject: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let auditService: { logSystem: ReturnType<typeof vi.fn> };
  let service: ProjectService;

  beforeEach(() => {
    repos = cascadeRepos();
    projectRepo = { findById: vi.fn().mockResolvedValue(PENDING_PROJECT), delete: vi.fn() };
    memberRepo = { findByProject: vi.fn().mockResolvedValue([{ userId: 'user-1' }]), delete: vi.fn() };
    auditService = { logSystem: vi.fn().mockResolvedValue(undefined) };
    service = new ProjectService(
      projectRepo as never,
      memberRepo as never,
      { taskTypes: {}, statuses: {}, boards: {} } as never,
      repos,
      auditService as never,
      { findByUserAndTenant: vi.fn() } as never,
    );
  });

  it('deletes the project document LAST, after every child collection', async () => {
    await service.purgeProjectData('proj-1');

    const rootOrder = projectRepo.delete.mock.invocationCallOrder[0] ?? 0;
    const childCalls = [
      repos.commentRepo.deleteByTaskIds,
      repos.relationshipRepo.deleteByProject,
      repos.taskRepo.deleteByProject,
      repos.sprintRepo.deleteByProject,
      repos.boardRepo.deleteByProject,
      repos.labelRepo.deleteByProject,
      repos.statusRepo.deleteByProject,
      repos.taskTypeRepo.deleteByProject,
      repos.filterRepo.deleteByProject,
      repos.counterRepo.deleteByProject,
    ];

    for (const call of childCalls) {
      expect(call.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(rootOrder);
    }
  });

  it('deletes comments BEFORE the tasks they hang off', async () => {
    // Comments are keyed by `taskId` and carry no `projectId`, so they are
    // collected by task id first. Deleting the tasks first would orphan every
    // comment in the project, permanently.
    await service.purgeProjectData('proj-1');

    const commentOrder = repos.commentRepo.deleteByTaskIds.mock.invocationCallOrder[0] ?? 0;
    const taskOrder = repos.taskRepo.deleteByProject.mock.invocationCallOrder[0] ?? 0;

    expect(commentOrder).toBeLessThan(taskOrder);
  });

  it('deletes project memberships before the project document', async () => {
    await service.purgeProjectData('proj-1');

    const memberOrder = memberRepo.delete.mock.invocationCallOrder[0] ?? 0;
    const rootOrder = projectRepo.delete.mock.invocationCallOrder[0] ?? 0;

    expect(memberOrder).toBeLessThan(rootOrder);
    expect(memberRepo.delete).toHaveBeenCalledWith('proj-1', 'user-1');
  });

  it('records the purge, with a SYSTEM actor, BEFORE the root document goes', async () => {
    await service.purgeProjectData('proj-1');

    const auditOrder = auditService.logSystem.mock.invocationCallOrder[0] ?? 0;
    const rootOrder = projectRepo.delete.mock.invocationCallOrder[0] ?? 0;

    // Written before, so a failure after this point leaves the entity scheduled
    // and the retry re-records rather than losing the record entirely.
    expect(auditOrder).toBeLessThan(rootOrder);
    expect(auditService.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        entityType: 'PROJECT',
        entityId: 'proj-1',
        action: 'DELETED',
      }),
    );
  });

  it('a failure part-way leaves the root document in place', async () => {
    // The property the ordering buys, asserted directly: this is what makes a
    // partial cascade recoverable rather than an orphan generator.
    repos.statusRepo.deleteByProject.mockRejectedValue(new Error('replica set stepped down'));

    await expect(service.purgeProjectData('proj-1')).rejects.toThrow('replica set stepped down');

    // Everything BEFORE the failure ran; everything after it, including the root,
    // did not — which is the safe direction. The steps after `statuses` are the
    // task types, the filters and the counters, plus memberships and the root.
    expect(repos.taskRepo.deleteByProject).toHaveBeenCalled();
    expect(repos.labelRepo.deleteByProject).toHaveBeenCalled();
    expect(repos.statusRepo.deleteByProject).toHaveBeenCalled();
    expect(repos.taskTypeRepo.deleteByProject).not.toHaveBeenCalled();
    expect(repos.filterRepo.deleteByProject).not.toHaveBeenCalled();
    expect(repos.counterRepo.deleteByProject).not.toHaveBeenCalled();
    expect(memberRepo.delete).not.toHaveBeenCalled();
    expect(auditService.logSystem).not.toHaveBeenCalled();
    expect(projectRepo.delete).not.toHaveBeenCalled();
  });

  it('does not require DELETION_PENDING — a workspace purge destroys ACTIVE projects', async () => {
    // The workspace cascade calls this for projects that are still in use. A
    // status precondition here would make a workspace purge silently skip exactly
    // the projects that hold its data.
    projectRepo.findById.mockResolvedValue({ ...PENDING_PROJECT, status: 'ACTIVE' });

    await expect(service.purgeProjectData('proj-1')).resolves.toBeUndefined();

    expect(projectRepo.delete).toHaveBeenCalledWith('proj-1');
  });

  it('the checked entry point still refuses a project that is not scheduled', async () => {
    projectRepo.findById.mockResolvedValue({ ...PENDING_PROJECT, status: 'ACTIVE' });

    await expect(service.permanentDelete('proj-1')).rejects.toThrow('DELETION_PENDING');
    expect(projectRepo.delete).not.toHaveBeenCalled();
  });
});

describe('C-2 — the workspace cascade reaches everything the workspace owns', () => {
  let projectPurge: { purgeProjectData: ReturnType<typeof vi.fn> };
  let tenantRepo: { findById: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let memberRepo: { findByTenant: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let projectRepo: { findByTenant: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let auditService: { logSystem: ReturnType<typeof vi.fn> };
  let service: TenantService;
  const TENANT = {
    id: 'tenant-1',
    name: 'Acme',
    slug: 'acme',
    description: null,
    status: 'DELETION_PENDING',
    deletionScheduledAt: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    projectPurge = { purgeProjectData: vi.fn().mockResolvedValue(undefined) };
    tenantRepo = { findById: vi.fn().mockResolvedValue(TENANT), delete: vi.fn() };
    memberRepo = { findByTenant: vi.fn().mockResolvedValue([{ userId: 'user-1' }]), delete: vi.fn() };
    projectRepo = { findByTenant: vi.fn().mockResolvedValue([]), update: vi.fn() };
    auditService = { logSystem: vi.fn().mockResolvedValue(undefined) };
    service = new TenantService(
      tenantRepo as never,
      memberRepo as never,
      { findById: vi.fn() } as never,
      projectRepo,
      auditService as never,
      { deleteByUserId: vi.fn() } as never,
      projectPurge,
    );
  });

  it('purges EVERY project the workspace owns, not just the workspace document', async () => {
    // The defect: the old purge removed memberships and the workspace document
    // and left every project, task and comment of every project resident.
    projectRepo.findByTenant.mockResolvedValue([
      { id: 'proj-1', status: 'ACTIVE', archiveReason: null },
      { id: 'proj-2', status: 'ARCHIVED', archiveReason: 'TENANT_ARCHIVE' },
      { id: 'proj-3', status: 'ACTIVE', archiveReason: null },
    ]);

    await service.purgeTenantData('tenant-1');

    expect(projectPurge.purgeProjectData).toHaveBeenCalledTimes(3);
    expect(projectPurge.purgeProjectData).toHaveBeenCalledWith('proj-1');
    expect(projectPurge.purgeProjectData).toHaveBeenCalledWith('proj-2');
    expect(projectPurge.purgeProjectData).toHaveBeenCalledWith('proj-3');
  });

  it('removes the workspace memberships', async () => {
    await service.purgeTenantData('tenant-1');

    expect(memberRepo.delete).toHaveBeenCalledWith('tenant-1', 'user-1');
  });

  it('deletes the workspace document LAST, after projects, memberships and the record', async () => {
    projectRepo.findByTenant.mockResolvedValue([{ id: 'proj-1', status: 'ACTIVE', archiveReason: null }]);

    await service.purgeTenantData('tenant-1');

    const rootOrder = tenantRepo.delete.mock.invocationCallOrder[0] ?? 0;

    expect(projectPurge.purgeProjectData.mock.invocationCallOrder[0] ?? 0).toBeLessThan(rootOrder);
    expect(memberRepo.delete.mock.invocationCallOrder[0] ?? 0).toBeLessThan(rootOrder);
    expect(auditService.logSystem.mock.invocationCallOrder[0] ?? 0).toBeLessThan(rootOrder);
  });

  it('a failure on one project leaves the workspace document in place', async () => {
    projectRepo.findByTenant.mockResolvedValue([
      { id: 'proj-1', status: 'ACTIVE', archiveReason: null },
      { id: 'proj-2', status: 'ACTIVE', archiveReason: null },
    ]);
    projectPurge.purgeProjectData.mockImplementation(async (id: string) => {
      if (id === 'proj-1') throw new Error('write concern timeout');
    });

    await expect(service.purgeTenantData('tenant-1')).rejects.toThrow('write concern timeout');

    // proj-1 failed, so proj-2 was never attempted and the workspace document is
    // untouched. Nothing is orphaned, because the workspace document is still
    // there to be re-selected and the whole cascade re-run.
    expect(projectPurge.purgeProjectData).toHaveBeenCalledTimes(1);
    expect(memberRepo.delete).not.toHaveBeenCalled();
    expect(tenantRepo.delete).not.toHaveBeenCalled();
  });

  it('records the purge with a SYSTEM actor, naming how many projects went with it', async () => {
    projectRepo.findByTenant.mockResolvedValue([
      { id: 'proj-1', status: 'ACTIVE', archiveReason: null },
      { id: 'proj-2', status: 'ACTIVE', archiveReason: null },
    ]);

    await service.purgeTenantData('tenant-1');

    expect(auditService.logSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: null,
        entityType: 'TENANT',
        entityId: 'tenant-1',
        action: 'DELETED',
        changes: [expect.objectContaining({ field: 'purged' })],
      }),
    );

    // A workspace-level event (`projectId: null`) is the right shape here: the
    // project rows it would otherwise reference are themselves being deleted.
    const recorded = auditService.logSystem.mock.calls[0]?.[0] as { changes: { newValue: string }[] };

    expect(recorded.changes[0]?.newValue).toContain('2 project(s)');
  });

  it('the checked entry point still refuses a workspace that is not scheduled', async () => {
    tenantRepo.findById.mockResolvedValue({ ...TENANT, status: 'ACTIVE' });

    await expect(service.permanentDelete('tenant-1')).rejects.toThrow('DELETION_PENDING');
    expect(tenantRepo.delete).not.toHaveBeenCalled();
  });
});

describe('C-8 — the audit log is never deleted by a purge', () => {
  /**
   * The scan that matters: `deleteByProject` on the audit repository is the
   * method that used to be the last step of the project cascade, removing the
   * whole project's history INCLUDING the event recording who purged it. A
   * behavioural test of the cascade already covers the call site; this covers
   * every OTHER place it could be wired up, which is the half no behavioural
   * test can reach.
   */
  it('no service, route or repository calls the audit repository delete', () => {
    const offenders: string[] = [];

    for (const dir of ['services', 'routes', 'repositories', 'middleware']) {
      for (const file of readdirSync(join(SRC, dir)).filter((name) => name.endsWith('.ts'))) {
        const source = readFileSync(join(SRC, dir, file), 'utf8');

        if (!source.includes('auditRepo') && !source.includes('auditEventRepo')) continue;

        // Comments are stripped first, so the note that documents the removed
        // call cannot satisfy — let alone trip — this row.
        const stripped = code(source);

        for (const match of stripped.matchAll(/(?:auditRepo|auditEventRepo)\s*\.\s*(\w+)\s*\(/g)) {
          if (match[1] === 'deleteByProject' && file !== 'audit-event.repository.ts') {
            offenders.push(`${dir}/${file}: ${match[0]}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the retention window is a declared TTL index, not an application delete', () => {
    // The mechanism, asserted rather than described: a time-to-live index on
    // `createdAt`, which is what makes the window real. A reader who trusts the
    // comments but not the behaviour needs this row.
    const migrations = readFileSync(join(SRC, 'db', 'migrations.ts'), 'utf8');

    expect(migrations).toMatch(
      /collection:\s*'audit_events',\s*spec:\s*\{\s*createdAt:\s*1\s*\},\s*options:\s*\{\s*expireAfterSeconds:\s*AUDIT_RETENTION_SECONDS\s*\}/,
    );
    expect(migrations).toMatch(/export const AUDIT_RETENTION_DAYS = \d+;/);
  });

  it('the system actor is not a fabricated user id', async () => {
    // A sentinel user id would be resolvable by the enrichment service and would
    // eventually collide with, or be mistaken for, a real account.
    expect(SYSTEM_ACTOR.userId).toBeNull();
    expect(SYSTEM_ACTOR.displayName).toBeTruthy();
  });
});

describe('C-2 — the purge is actually triggered', () => {
  it('the worker exports a scheduled handler', () => {
    // The defect in its original form was that nothing called the purge. A
    // `PurgeService` with a correct cascade and no trigger is the same defect
    // with more code attached, so the trigger's existence is asserted here.
    const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');

    expect(entry).toMatch(/async scheduled\(/);
    expect(entry).toContain('buildPurgeService().runDue()');
  });

  it('a cron trigger is declared, so the platform has something to call', () => {
    // The handler is inert without this. Read from the deploy config rather than
    // assumed: a handler with no trigger is the half-finished design this package
    // exists to complete.
    const wrangler = readFileSync(join(SRC, '..', 'wrangler.toml'), 'utf8');

    expect(wrangler).toMatch(/\[triggers\]/);
    expect(wrangler).toMatch(/crons\s*=\s*\["[^"]+"]/);
  });

  it('the purge graph is built by the composition root, not at module level', () => {
    // P-02, restated for the new graph: a purge whose repositories were built at
    // module scope would hold a connection from a previous request.
    const container = readFileSync(join(SRC, 'container.ts'), 'utf8');

    expect(container).toMatch(/export function buildPurgeService\(\)/);
    // The build happens INSIDE the function, not in a module-level constant.
    expect(container).not.toMatch(/^const \w*purge\w* = new PurgeService/m);
  });
});
