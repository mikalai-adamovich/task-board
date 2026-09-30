import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit.service.js';
import { AuditEnrichmentService, UNKNOWN_LABEL } from './audit-enrichment.service.js';
import type { AuditServiceUserRepo } from './audit.service.js';
import type { AuditEventRepository } from '../repositories/audit-event.repository.js';
import type { AuditEvent } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockAuditRepo() {
  return {
    create: vi.fn().mockImplementation((input) =>
      Promise.resolve({
        id: 'event-1',
        ...input,
        createdAt: new Date().toISOString(),
      }),
    ),
    createMany: vi.fn().mockResolvedValue(undefined),
    findByProject: vi.fn(),
    findByTenant: vi.fn(),
  } as unknown as AuditEventRepository & { createMany: ReturnType<typeof vi.fn> };
}

function createMockUserRepo(): AuditServiceUserRepo {
  return {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Alice', email: 'alice@example.com' }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AuditService (DEC-028 actor snapshot at write time)', () => {
  it('resolves the actor displayName once and persists the snapshot on every event', async () => {
    const auditRepo = createMockAuditRepo();
    const userRepo = createMockUserRepo();
    const service = new AuditService(auditRepo, userRepo);

    await service.log({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entityType: 'TASK',
      entityId: 'task-1',
      action: 'CREATED',
      actorId: 'user-1',
    });

    expect(userRepo.findById).toHaveBeenCalledWith('user-1');
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: 'user-1', displayName: 'Alice' },
      }),
    );
  });

  it('TOP-3 №2: logMany resolves the actor ONCE and persists all events in ONE createMany', async () => {
    const auditRepo = createMockAuditRepo();
    const userRepo = createMockUserRepo();
    const service = new AuditService(auditRepo, userRepo);

    await service.logMany('user-1', [
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        entityType: 'TASK',
        entityId: 'task-1',
        action: 'UPDATED',
        changes: [{ field: 'statusId', oldValue: 's1', newValue: 's2' }],
      },
      { tenantId: 'tenant-1', projectId: 'project-1', entityType: 'TASK', entityId: 'task-2', action: 'UPDATED' },
    ]);

    expect(userRepo.findById).toHaveBeenCalledTimes(1);
    expect(userRepo.findById).toHaveBeenCalledWith('user-1');
    expect(auditRepo.createMany).toHaveBeenCalledTimes(1);

    const events = auditRepo.createMany.mock.calls.at(0)?.[0] ?? [];

    expect(events).toHaveLength(2);
    // actor snapshot identical across the batch
    expect(
      events.every((e: { actor: { userId: string; displayName: string } }) => e.actor.displayName === 'Alice'),
    ).toBe(true);
    // per-event changes preserved
    expect(events[0].changes).toEqual([{ field: 'statusId', oldValue: 's1', newValue: 's2' }]);
    expect(events[1].changes).toEqual([]);
    // per-event identity preserved (UUIDs are minted by the repository)
    expect(events[0].entityId).toBe('task-1');
    expect(events[1].entityId).toBe('task-2');
  });

  it('D-11: a batch never shares one createdAt — two events must not tie on the list sort key', async () => {
    // The property: the timestamps `logMany` hands the repository are DISTINCT
    // and increasing in batch order. The old code stamped the whole batch with
    // one `new Date()`, so a 500-task bulk update wrote 500 events whose
    // relative order in the audit list was whatever the database felt like.
    // Asserted as a property (no duplicates, strictly increasing), so a fix that
    // stamps them differently still passes.
    const auditRepo = createMockAuditRepo();
    const service = new AuditService(auditRepo, createMockUserRepo());

    await service.logMany(
      'user-1',
      Array.from({ length: 25 }, (_unused, i) => ({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        entityType: 'TASK' as const,
        entityId: `task-${i}`,
        action: 'UPDATED' as const,
      })),
    );

    const stamps = (auditRepo.createMany.mock.calls.at(0)?.[0] ?? []).map((e: { createdAt: Date }) =>
      e.createdAt.getTime(),
    );

    expect(stamps).toHaveLength(25);
    expect(new Set(stamps).size, 'two events in the batch share a createdAt').toBe(25);
    expect(
      [...stamps].sort((a, b) => a - b),
      'stamps must increase in batch order',
    ).toEqual(stamps);
  });

  it('D-11: the batch cannot run the audit clock far into the future', async () => {
    // Distinct stamps are not enough: a fix that "fixed" the tie by adding a
    // second or a minute per event would make every timestamp a lie. The bound
    // is the batch length — the stamps must stay within one millisecond per
    // event of each other, which any per-event clock read also satisfies.
    const auditRepo = createMockAuditRepo();
    const service = new AuditService(auditRepo, createMockUserRepo());
    const before = Date.now();

    await service.logMany(
      'user-1',
      Array.from({ length: 10 }, (_unused, i) => ({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        entityType: 'TASK' as const,
        entityId: `task-${i}`,
        action: 'UPDATED' as const,
      })),
    );

    const stamps = (auditRepo.createMany.mock.calls.at(0)?.[0] ?? []).map((e: { createdAt: Date }) =>
      e.createdAt.getTime(),
    );
    const first = stamps[0] ?? before;
    const last = stamps[stamps.length - 1] ?? first;

    expect(first).toBeGreaterThanOrEqual(before);
    expect(last - first).toBeLessThanOrEqual(stamps.length - 1);
    expect(last - before).toBeLessThanOrEqual(stamps.length);
  });

  it('TOP-3 №2: logMany is a no-op for an empty batch — no DB operations', async () => {
    const auditRepo = createMockAuditRepo();
    const userRepo = createMockUserRepo();
    const service = new AuditService(auditRepo, userRepo);

    await service.logMany('user-1', []);

    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(auditRepo.createMany).not.toHaveBeenCalled();
  });

  it('falls back to "Unknown User" when the actor cannot be resolved', async () => {
    const auditRepo = createMockAuditRepo();
    const userRepo: AuditServiceUserRepo = { findById: vi.fn().mockResolvedValue(null) };
    const service = new AuditService(auditRepo, userRepo);

    await service.log({
      tenantId: 'tenant-1',
      projectId: null,
      entityType: 'PROJECT',
      entityId: 'project-1',
      action: 'DELETED',
      actorId: 'deleted-user',
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: 'deleted-user', displayName: 'Unknown User' },
      }),
    );
  });

  it('persists changes alongside the actor snapshot', async () => {
    const auditRepo = createMockAuditRepo();
    const userRepo = createMockUserRepo();
    const service = new AuditService(auditRepo, userRepo);

    await service.log({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entityType: 'SPRINT',
      entityId: 'sprint-1',
      action: 'UPDATED',
      actorId: 'user-1',
      changes: [{ field: 'status', oldValue: 'FUTURE', newValue: 'ACTIVE' }],
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: 'user-1', displayName: 'Alice' },
        changes: [{ field: 'status', oldValue: 'FUTURE', newValue: 'ACTIVE' }],
      }),
    );
  });
});

// ─── Human-readable label enrichment ─────────────────────────────────────────

function createMockEnrichmentRepos() {
  return {
    tasks: { findByIds: vi.fn().mockResolvedValue([{ id: 'task-1', number: 123, projectId: 'proj-1' }]) },
    sprints: { findByIds: vi.fn().mockResolvedValue([{ id: 'sprint-1', name: 'Sprint 1' }]) },
    statuses: {
      findByIds: vi.fn().mockResolvedValue([
        { id: 'status-todo', name: 'To Do' },
        { id: 'status-inprog', name: 'In Progress' },
      ]),
    },
    labels: { findByIds: vi.fn().mockResolvedValue([{ id: 'label-1', name: 'bug' }]) },
    taskTypes: { findByIds: vi.fn().mockResolvedValue([]) },
    boards: { findByIds: vi.fn().mockResolvedValue([]) },
    projects: { findByIds: vi.fn().mockResolvedValue([{ id: 'proj-1', key: 'PROJ', name: 'Project' }]) },
    users: { findByIds: vi.fn().mockResolvedValue([{ id: 'user-9', displayName: 'Carol', email: 'c@x.io' }]) },
    comments: { findByIds: vi.fn().mockResolvedValue([{ id: 'comment-1', taskId: 'task-1' }]) },
    tenants: { findByIds: vi.fn().mockResolvedValue([]) },
    tenantMembers: { findByIds: vi.fn().mockResolvedValue([]) },
  };
}

const NOW = '2025-01-01T00:00:00Z';

function makeEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'ae-1',
    tenantId: 't1',
    projectId: 'p1',
    entityType: 'TASK',
    entityId: 'task-1',
    action: 'UPDATED',
    actor: { userId: 'u1', displayName: 'Alice' },
    changes: [],
    createdAt: NOW,
    ...overrides,
  };
}

describe('AuditEnrichmentService (R3-P7)', () => {
  it('resolves entityLabel per entity type (TASK → KEY-number, SPRINT → name)', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);
    const events = await service.enrichEvents([
      makeEvent({ entityType: 'TASK', entityId: 'task-1' }),
      makeEvent({ entityType: 'SPRINT', entityId: 'sprint-1' }),
    ]);

    expect(events[0]?.entityLabel).toBe('PROJ-123');
    expect(events[1]?.entityLabel).toBe('Sprint 1');
  });

  it('resolves TASK keys via the task row projectId even without a PROJECT event (V7-4)', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);
    // Page contains ONLY a TASK event — no PROJECT-entity event carries the
    // project id, so the key must be resolved through the fetched task row.
    const events = await service.enrichEvents([makeEvent({ entityType: 'TASK', entityId: 'task-1' })]);

    expect(events[0]?.entityLabel).toBe('PROJ-123');
    // the project lookup must have been fed the task row's projectId
    expect(repos.projects.findByIds).toHaveBeenCalledWith(['proj-1']);
  });

  it('resolves COMMENT labels via the parent task key', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);
    const events = await service.enrichEvents([makeEvent({ entityType: 'COMMENT', entityId: 'comment-1' })]);

    expect(events[0]?.entityLabel).toBe('comment on PROJ-123');
  });

  it('enriches change values with oldLabel/newLabel while preserving raw values', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);
    const events = await service.enrichEvents([
      makeEvent({
        entityType: 'TASK',
        changes: [
          { field: 'statusId', oldValue: 'status-todo', newValue: 'status-inprog' },
          { field: 'assigneeId', oldValue: null, newValue: 'user-9' },
          { field: 'labelIds', oldValue: [], newValue: ['label-1'] },
        ],
      }),
    ]);
    const [statusChange, assigneeChange, labelsChange] = events[0]?.changes ?? [];

    expect(statusChange?.oldLabel).toBe('To Do');
    expect(statusChange?.newLabel).toBe('In Progress');
    expect(statusChange?.rawOldValue).toBe('status-todo');
    expect(assigneeChange?.newLabel).toBe('Carol');
    expect(labelsChange?.newLabel).toBe('bug');
  });

  it('batch-resolves per page — one $in query per collection regardless of event count', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);

    await service.enrichEvents([
      makeEvent({ entityType: 'TASK', entityId: 'task-1' }),
      makeEvent({ entityType: 'TASK', entityId: 'task-1' }),
      makeEvent({
        entityType: 'TASK',
        entityId: 'task-1',
        changes: [{ field: 'statusId', oldValue: 'status-todo', newValue: 'status-inprog' }],
      }),
    ]);

    expect(repos.tasks.findByIds).toHaveBeenCalledTimes(1);
    expect(repos.statuses.findByIds).toHaveBeenCalledTimes(1);
    expect(repos.projects.findByIds).toHaveBeenCalledTimes(1);
  });

  it('falls back to "Unknown" when an id cannot be resolved', async () => {
    const repos = createMockEnrichmentRepos();

    repos.tasks.findByIds = vi.fn().mockResolvedValue([]);

    const service = new AuditEnrichmentService(repos);
    const events = await service.enrichEvents([
      makeEvent({ entityType: 'TASK', entityId: 'deleted-task' }),
      makeEvent({
        entityType: 'TASK',
        entityId: 'task-1',
        changes: [{ field: 'sprintId', oldValue: 'gone-sprint', newValue: null }],
      }),
    ]);

    expect(events[0]?.entityLabel).toBe(UNKNOWN_LABEL);
    // Unresolvable refs produce no labels — raw values stay untouched.
    expect(events[1]?.changes[0]?.oldLabel).toBeUndefined();
    expect(events[1]?.changes[0]?.rawOldValue).toBeUndefined();
  });

  it('leaves non-reference changes untouched', async () => {
    const repos = createMockEnrichmentRepos();
    const service = new AuditEnrichmentService(repos);
    const events = await service.enrichEvents([
      makeEvent({ changes: [{ field: 'title', oldValue: 'a', newValue: 'b' }] }),
    ]);

    expect(events[0]?.changes[0]).toEqual({ field: 'title', oldValue: 'a', newValue: 'b' });
  });
});

describe('AuditService queries enrich pages (R3-P7)', () => {
  it('passes page data through the enrichment service', async () => {
    const auditRepo = createMockAuditRepo();
    const page: PaginatedShape = {
      data: [makeEvent({ entityType: 'SPRINT', entityId: 'sprint-1' })],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };

    auditRepo.findByProject = vi.fn().mockResolvedValue(page);

    const repos = createMockEnrichmentRepos();
    const service = new AuditService(auditRepo, createMockUserRepo(), new AuditEnrichmentService(repos));
    const result = await service.queryByProject('p1');

    expect(result.data[0]?.entityLabel).toBe('Sprint 1');
  });
});

type PaginatedShape = Awaited<ReturnType<AuditEventRepository['findByProject']>>;
