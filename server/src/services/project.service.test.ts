import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectService } from './project.service.js';
import type { ProjectServiceTenantMemberRepo } from './project.service.js';
import { withTransaction, TransactionsUnsupportedError } from '../db/mongo.js';

// ─── Transaction API Mock ────────────────────────────────────────────────────

/**
 * Session token handed to the callback — asserted on repository/collection
 * calls to prove every seed write is bound to the transaction's session.
 */
const txSession = { id: 'mock-session' };

vi.mock('../db/mongo.js', () => {
  class TransactionsUnsupportedError extends Error {
    constructor(message = 'This MongoDB deployment does not support transactions') {
      super(message);
      this.name = 'TransactionsUnsupportedError';
    }
  }

  return {
    TransactionsUnsupportedError,
    // Default: execute the callback against the mock session (commit semantics)
    withTransaction: vi.fn(async (fn: (session: unknown) => Promise<unknown>) => fn(txSession)),
  };
});

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockProjectRepo() {
  return {
    findById: vi.fn(),
    findByTenant: vi.fn(),
    findByTenantAndKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockProjectMemberRepo() {
  return {
    findByUserAndProject: vi.fn(),
    findByProject: vi.fn(),
    findByProjectWithUsers: vi.fn(),
    findByUser: vi.fn(),
    create: vi.fn(),
    updateRole: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockCollections() {
  return {
    taskTypes: { insertOne: vi.fn() },
    statuses: { insertOne: vi.fn() },
    boards: { insertOne: vi.fn() },
  };
}

/**
 * The 11 cascade repos are REQUIRED deps of ProjectService. Every spec
 * passes a full fake so no code path can be silently skipped any more.
 */
function createMockCascadeRepos() {
  return {
    taskRepo: { findIdsByProject: vi.fn().mockResolvedValue([]), deleteByProject: vi.fn() },
    sprintRepo: { deleteByProject: vi.fn() },
    boardRepo: { deleteByProject: vi.fn() },
    labelRepo: { deleteByProject: vi.fn() },
    statusRepo: { deleteByProject: vi.fn() },
    taskTypeRepo: { deleteByProject: vi.fn() },
    relationshipRepo: { deleteByProject: vi.fn() },
    commentRepo: { deleteByTaskIds: vi.fn() },
    filterRepo: { deleteByProject: vi.fn() },
    auditRepo: { deleteByProject: vi.fn() },
    counterRepo: { deleteByProject: vi.fn() },
  };
}

function createMockAuditService() {
  // `logSystem` is the purge's record of what it destroyed. The default fake
  // RESOLVES a value — `project.service.ts` AWAITS it, and a fake returning
  // `undefined` is awaited to `undefined` without error, so the shape only
  // matters where an assertion reads it.
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logMany: vi.fn(),
    logSystem: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The ACTIVE-tenant-membership guard of `addMember` lives in the
 * SERVICE, so the service itself needs a tenant-member repository. The default
 * fake answers "the target is an ACTIVE member of the asked tenant", which is
 * what every pre-existing (non-membership) spec assumes.
 */
function createMockTenantMemberRepo(active: (userId: string, tenantId: string) => boolean = () => true) {
  return {
    findByUserAndTenant: vi.fn<ProjectServiceTenantMemberRepo['findByUserAndTenant']>(async (userId, tenantId) =>
      active(userId, tenantId) ? { status: 'ACTIVE', expiresAt: null } : { status: 'ACCESS_REVOKED', expiresAt: null },
    ),
  };
}

const NOW = '2025-01-01T00:00:00.000Z';
/**
 * Every project-scoped method now takes the REQUIRED caller
 * context. `ADMIN` in `tenant-1` is the canonical same-tenant caller;
 * `FOREIGN_CTX` is an OWNER of another tenant — the production attacker.
 */
const CTX = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'ADMIN' };
const FOREIGN_CTX = { tenantId: 'tenant-OTHER', userId: 'user-9', userRole: 'OWNER' };

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    tenantId: 'tenant-1',
    key: 'TEST',
    name: 'Test Project',
    description: null,
    status: 'ACTIVE',
    defaultStatusId: 'status-todo',
    archiveReason: null,
    deletionScheduledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeProjectMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pmember-1',
    userId: 'user-1',
    projectId: 'proj-1',
    role: 'PROJECT_ADMIN',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProjectService', () => {
  let projectRepo: ReturnType<typeof createMockProjectRepo>;
  let memberRepo: ReturnType<typeof createMockProjectMemberRepo>;
  let collections: ReturnType<typeof createMockCollections>;
  let cascadeRepos: ReturnType<typeof createMockCascadeRepos>;
  let auditService: ReturnType<typeof createMockAuditService>;
  let tenantMemberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let service: ProjectService;

  /**
   * Rebuild the service under test (used by the specs that swap the
   * tenant-membership answer without disturbing the shared `beforeEach` state).
   */
  function buildService(activeMembership: (userId: string, tenantId: string) => boolean = () => true): ProjectService {
    tenantMemberRepo = createMockTenantMemberRepo(activeMembership);

    return new ProjectService(
      projectRepo as never,
      memberRepo as never,
      collections as never,
      cascadeRepos,
      auditService as never,
      tenantMemberRepo,
    );
  }

  beforeEach(() => {
    vi.mocked(withTransaction).mockClear();
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(txSession as never));
    projectRepo = createMockProjectRepo();
    memberRepo = createMockProjectMemberRepo();
    collections = createMockCollections();
    cascadeRepos = createMockCascadeRepos();
    auditService = createMockAuditService();
    service = buildService();
  });

  // ── listProjects ──────────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('returns all projects in a tenant', async () => {
      projectRepo.findByTenant.mockResolvedValue([makeProject(), makeProject({ id: 'proj-2', key: 'PROJ2' })]);

      const result = await service.listProjects('tenant-1');

      expect(result).toHaveLength(2);
      expect(projectRepo.findByTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  // ── createProject ─────────────────────────────────────────────────────────

  describe('createProject', () => {
    it('creates a project with seed data and adds the creator as PROJECT_ADMIN', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue(makeProject({ defaultStatusId: '' }));
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.create.mockResolvedValue(makeProjectMember());

      const result = await service.createProject('tenant-1', 'user-1', 'ADMIN', {
        key: 'TEST',
        name: 'Test Project',
      });

      expect(projectRepo.create).toHaveBeenCalledWith(
        'tenant-1',
        { key: 'TEST', name: 'Test Project' },
        { session: txSession },
      );
      expect(collections.statuses.insertOne).toHaveBeenCalledTimes(5); // 5 seed statuses
      expect(collections.taskTypes.insertOne).toHaveBeenCalledTimes(3); // 3 seed task types

      // Seed statuses carry human-readable display names, not raw keys
      const seededNames = collections.statuses.insertOne.mock.calls.map(
        (call: unknown[]) => (call[0] as { name: string }).name,
      );

      expect(seededNames).toEqual(['To Do', 'In Progress', 'In Review', 'Reopened', 'Done']);
      expect(collections.boards.insertOne).toHaveBeenCalledTimes(1); // 1 default board
      expect(memberRepo.create).toHaveBeenCalledWith(
        { userId: 'user-1', projectId: 'proj-1', role: 'PROJECT_ADMIN' },
        { session: txSession },
      );
      expect(result.key).toBe('TEST');
    });

    it('runs the whole seed inside one transaction bound to its session', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue(makeProject({ defaultStatusId: '' }));
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.create.mockResolvedValue(makeProjectMember());

      await service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'Test Project' });

      expect(withTransaction).toHaveBeenCalledTimes(1);

      // Every write (statuses, task types, board, defaults update, membership)
      // carries the transaction session
      for (const call of collections.statuses.insertOne.mock.calls) {
        expect(call[1]).toEqual({ session: txSession });
      }
      for (const call of collections.taskTypes.insertOne.mock.calls) {
        expect(call[1]).toEqual({ session: txSession });
      }
      expect(collections.boards.insertOne.mock.calls[0]?.[1]).toEqual({ session: txSession });
      expect(projectRepo.update).toHaveBeenCalledWith(
        'proj-1',
        { defaultStatusId: expect.any(String) },
        { session: txSession },
      );
    });

    it('aborted transaction leaves nothing visible and skips compensating delete', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      vi.mocked(withTransaction).mockImplementation(async () => {
        throw new Error('AbortTransaction'); // driver aborts ⇒ nothing committed
      });

      await expect(service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'X' })).rejects.toThrow(
        'AbortTransaction',
      );

      // Transaction rollback replaces app-level cleanup — no compensating delete
      expect(projectRepo.delete).not.toHaveBeenCalled();
      expect(projectRepo.findById).not.toHaveBeenCalled(); // no post-commit read either
    });

    it('F15: a lost {tenantId,key} race is a 409, not a 500 from the driver', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error collection: projects index: tenantId_1_key_1'), {
          code: 11000,
          codeName: 'DuplicateKey',
        }),
      );

      const err = await service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'X' }).then(
        () => null,
        (e: unknown) => e as { statusCode: number; code: string; message: string },
      );

      expect(err?.statusCode).toBe(409);
      expect(err?.code).toBe('DUPLICATE_PROJECT_KEY');
      expect(err?.message).not.toContain('E11000');
    });

    it('falls back to compensating-cleanup seed when transactions are unsupported', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue(makeProject({ defaultStatusId: '' }));
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.create.mockResolvedValue(makeProjectMember());
      vi.mocked(withTransaction).mockRejectedValue(new TransactionsUnsupportedError());

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      try {
        const result = await service.createProject('tenant-1', 'user-1', 'ADMIN', {
          key: 'TEST',
          name: 'Test Project',
        });

        // All docs written through the legacy path (no session binding)
        expect(collections.statuses.insertOne).toHaveBeenCalledTimes(5);
        expect(collections.taskTypes.insertOne).toHaveBeenCalledTimes(3);
        expect(collections.boards.insertOne).toHaveBeenCalledTimes(1);
        expect(memberRepo.create).toHaveBeenCalled();
        expect(projectRepo.delete).not.toHaveBeenCalled(); // success ⇒ no cleanup
        expect(result.key).toBe('TEST');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not support transactions'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('fallback path deletes the project when seeding fails midway', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue(makeProject({ defaultStatusId: '' }));
      collections.statuses.insertOne.mockRejectedValue(new Error('write failed'));
      vi.mocked(withTransaction).mockRejectedValue(new TransactionsUnsupportedError());

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      try {
        await expect(service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'X' })).rejects.toThrow(
          'write failed',
        );

        expect(projectRepo.delete).toHaveBeenCalledWith('proj-1');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('throws ConflictError for duplicate key', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(makeProject());

      await expect(service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'Dup' })).rejects.toThrow(
        'already exists',
      );
    });

    it('throws ForbiddenError when user is not admin or owner', async () => {
      await expect(service.createProject('tenant-1', 'user-1', 'MEMBER', { key: 'TEST', name: 'X' })).rejects.toThrow(
        'Only owner or admin',
      );
    });

    it('throws for invalid key format', async () => {
      await expect(service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'ab', name: 'X' })).rejects.toThrow(
        'Key must start with a letter',
      );
    });
  });

  // ── getProject ────────────────────────────────────────────────────────────

  describe('getProject', () => {
    it('returns the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      const result = await service.getProject('proj-1', CTX);

      expect(result.id).toBe('proj-1');
    });

    it('throws NotFoundError when project does not exist', async () => {
      projectRepo.findById.mockResolvedValue(null);

      await expect(service.getProject('missing', CTX)).rejects.toThrow('not found');
    });

    it('M-002: throws 404 (not 403) for a project of ANOTHER tenant', async () => {
      // The project belongs to tenant-1; the caller is an OWNER of tenant-OTHER.
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.getProject('proj-1', FOREIGN_CTX)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('M-002: throws 401 when the caller context is missing (fail closed)', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.getProject('proj-1', { tenantId: '', userId: '', userRole: '' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  // ── updateProject ─────────────────────────────────────────────────────────

  describe('updateProject', () => {
    it('updates the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      projectRepo.update.mockResolvedValue(makeProject({ name: 'Updated' }));

      const result = await service.updateProject('proj-1', { name: 'Updated' }, CTX);

      expect(result.name).toBe('Updated');
    });

    it('throws ForbiddenError when user is not admin', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.updateProject('proj-1', { name: 'X' }, { ...CTX, userRole: 'MEMBER' })).rejects.toThrow(
        'Only owner or admin',
      );
      expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it('M-002: a foreign-tenant OWNER gets 404 and cannot patch the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.updateProject('proj-1', { name: 'PWNED BY ATTACKER' }, FOREIGN_CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it('throws for archived project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject({ status: 'ARCHIVED' }));

      await expect(service.updateProject('proj-1', { name: 'X' }, CTX)).rejects.toThrow('archived');
    });
  });

  // ── deleteProject ─────────────────────────────────────────────────────────

  describe('deleteProject', () => {
    it('sets status to DELETION_PENDING', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      projectRepo.update.mockResolvedValue(makeProject({ status: 'DELETION_PENDING' }));

      await service.deleteProject('proj-1', CTX);

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', {
        status: 'DELETION_PENDING',
        deletionScheduledAt: expect.any(Date),
      });
    });

    it('M-002: a foreign-tenant OWNER gets 404 and cannot delete the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.deleteProject('proj-1', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError for a tenant MEMBER', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.deleteProject('proj-1', { ...CTX, userRole: 'MEMBER' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── archiveProject ────────────────────────────────────────────────────────

  describe('archiveProject', () => {
    it('sets status to ARCHIVED with archiveReason', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await service.archiveProject('proj-1', CTX);

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', {
        status: 'ARCHIVED',
        archiveReason: 'PROJECT_ARCHIVE',
      });
    });

    it('M-002: a foreign-tenant OWNER gets 404 and cannot archive the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.archiveProject('proj-1', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── restoreProject ────────────────────────────────────────────────────────

  describe('restoreProject', () => {
    it('sets status to ACTIVE and clears archive fields', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await service.restoreProject('proj-1', CTX);

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', {
        status: 'ACTIVE',
        archiveReason: null,
        deletionScheduledAt: null,
      });
    });

    it('M-002: restore resolves the project first — a foreign project is 404', async () => {
      projectRepo.findById.mockResolvedValue(makeProject({ tenantId: 'tenant-OTHER' }));

      await expect(service.restoreProject('proj-1', CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── cancelDeletion ────────────────────────────────────────────────────────

  describe('cancelDeletion', () => {
    it('sets status to ACTIVE and clears the deletion schedule', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await service.cancelDeletion('proj-1', CTX);

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: 'ACTIVE', deletionScheduledAt: null });
    });

    it('M-002: a foreign-tenant OWNER gets 404', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.cancelDeletion('proj-1', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── addMember ─────────────────────────────────────────────────────────────

  describe('addMember', () => {
    it('adds a member to the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(null);
      memberRepo.create.mockResolvedValue(makeProjectMember({ userId: 'user-2', role: 'EDITOR' }));

      const result = await service.addMember('proj-1', { userId: 'user-2', role: 'EDITOR' }, CTX);

      expect(memberRepo.create).toHaveBeenCalledWith({
        userId: 'user-2',
        projectId: 'proj-1',
        role: 'EDITOR',
      });
      expect(result.role).toBe('EDITOR');
    });

    it('throws ConflictError when user is already a member', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember());

      await expect(service.addMember('proj-1', { userId: 'user-1', role: 'EDITOR' }, CTX)).rejects.toThrow(
        'already a member',
      );
    });

    it('M-002/M-003: a foreign-tenant OWNER cannot add a PROJECT_ADMIN to this project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(
        service.addMember('proj-1', { userId: 'attacker', role: 'PROJECT_ADMIN' }, FOREIGN_CTX),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('M-003: a tenant MEMBER cannot add members (role gate is independent of ownership)', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(
        service.addMember('proj-1', { userId: 'user-2', role: 'EDITOR' }, { ...CTX, userRole: 'MEMBER' }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    // ── The membership guard moved from the ROUTE into the SERVICE ──────────
    //
    // Residual risk (g): while the check lived in `routes/projects.ts` a
    // direct call to `addMember` skipped it. These specs therefore call the
    // service DIRECTLY — no route, no middleware — which is exactly the call path
    // the route-level check could not protect.

    it('G-02: rejects a userId with NO tenant membership (404) and creates nothing', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      const svc = buildService(() => false);

      await expect(svc.addMember('proj-1', { userId: 'attacker', role: 'PROJECT_ADMIN' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: rejects a userId whose membership exists but is not ACTIVE (404) and creates nothing', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      const svc = buildService(() => false);

      // The default fake answers ACCESS_REVOKED for a rejected user.
      await expect(svc.addMember('proj-1', { userId: 'revoked', role: 'PROJECT_ADMIN' }, CTX)).rejects.toThrow(
        'User is not a member of this tenant',
      );
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: DEC-055 — a lapsed (ACTIVE but expired) membership is not ACTIVE', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      tenantMemberRepo = createMockTenantMemberRepo();
      tenantMemberRepo.findByUserAndTenant.mockResolvedValue({
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const svc = new ProjectService(
        projectRepo as never,
        memberRepo as never,
        collections as never,
        cascadeRepos,
        auditService as never,
        tenantMemberRepo,
      );

      await expect(svc.addMember('proj-1', { userId: 'lapsed', role: 'PROJECT_ADMIN' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: the membership is looked up in the CALLER tenant, never in an arbitrary one', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      const svc = buildService((userId, tenantId) => userId === 'user-2' && tenantId === 'tenant-1');

      memberRepo.findByUserAndProject.mockResolvedValue(null);
      memberRepo.create.mockResolvedValue(makeProjectMember({ userId: 'user-2', role: 'PROJECT_ADMIN' }));

      await svc.addMember('proj-1', { userId: 'user-2', role: 'PROJECT_ADMIN' }, CTX);

      expect(tenantMemberRepo.findByUserAndTenant).toHaveBeenCalledWith('user-2', 'tenant-1');
    });

    it('G-02: a member of ANOTHER tenant cannot be granted a seat — 404, no row', async () => {
      // `user-b` is an ACTIVE member of `tenant-OTHER` only.
      projectRepo.findById.mockResolvedValue(makeProject());

      const svc = buildService((userId, tenantId) => userId === 'user-b' && tenantId === 'tenant-OTHER');

      await expect(svc.addMember('proj-1', { userId: 'user-b', role: 'PROJECT_ADMIN' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: a foreign project is 404 even when the target IS an ACTIVE member of the caller tenant', async () => {
      // The project belongs to `tenant-OTHER`. Both attacker flavours are covered:
      // a tenant-1 ADMIN (CTX) and a tenant-THIRD OWNER (a third workspace entirely,
      // i.e. an OWNER who owns nothing of `tenant-OTHER`).
      projectRepo.findById.mockResolvedValue(makeProject({ tenantId: 'tenant-OTHER' }));

      const svc = buildService(() => true);

      await expect(svc.addMember('proj-1', { userId: 'user-2', role: 'PROJECT_ADMIN' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        svc.addMember(
          'proj-1',
          { userId: 'user-2', role: 'PROJECT_ADMIN' },
          { ...FOREIGN_CTX, tenantId: 'tenant-THIRD' },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(tenantMemberRepo.findByUserAndTenant).not.toHaveBeenCalled();
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: the project tenant-assert still runs before the membership lookup', async () => {
      // Ordering matters: a caller must not be able to probe "does user X belong to
      // my tenant?" through a project they cannot see. Both answer 404, but the
      // membership collection must not be touched at all.
      projectRepo.findById.mockResolvedValue(null);

      const svc = buildService(() => false);

      await expect(svc.addMember('ghost-project', { userId: 'user-2', role: 'EDITOR' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(tenantMemberRepo.findByUserAndTenant).not.toHaveBeenCalled();
    });

    it('G-02: a duplicate membership is still 409 after the membership guard passes', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember());

      const svc = buildService(() => true);

      await expect(svc.addMember('proj-1', { userId: 'user-2', role: 'EDITOR' }, CTX)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('G-02: an empty caller context is 401 before any lookup', async () => {
      const svc = buildService(() => true);

      await expect(
        svc.addMember(
          'proj-1',
          { userId: 'user-2', role: 'EDITOR' },
          {
            tenantId: '',
            userId: '',
            userRole: '',
          },
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(tenantMemberRepo.findByUserAndTenant).not.toHaveBeenCalled();
    });
  });

  // ── updateMemberRole ──────────────────────────────────────────────────────

  describe('updateMemberRole', () => {
    it('updates the role of an existing project member', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.updateRole.mockResolvedValue(makeProjectMember({ role: 'VIEWER' }));

      const result = await service.updateMemberRole('proj-1', 'user-1', 'VIEWER', CTX);

      expect(memberRepo.updateRole).toHaveBeenCalledWith('proj-1', 'user-1', 'VIEWER');
      expect(result.role).toBe('VIEWER');
    });

    it('M-002: a foreign-tenant OWNER cannot change roles in a foreign project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.updateMemberRole('proj-1', 'user-1', 'PROJECT_ADMIN', FOREIGN_CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(memberRepo.updateRole).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the target is not a project member', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.updateRole.mockResolvedValue(null);

      await expect(service.updateMemberRole('proj-1', 'stranger', 'VIEWER', CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    /**
     * F24, TASK 3b — the escalation argument, pinned.
     *
     * F4 left "changing your own project role is not blocked" open on the
     * reasoning that the caller is already a tenant OWNER/ADMIN. That reasoning
     * still holds after F20–F23, and this is the spec that makes it hold: the
     * gate is evaluated with NO project role, so a project `PROJECT_ADMIN` who is
     * only a tenant MEMBER is refused with 403 BEFORE the write. If someone later
     * "fixes" the guard by passing the caller's real project role (the widening
     * the matrix would otherwise permit), this test fails.
     */
    it('TASK 3b: a project PROJECT_ADMIN who is only a tenant MEMBER cannot change any role, including their own', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));

      await expect(
        service.updateMemberRole('proj-1', 'user-1', 'PROJECT_ADMIN', { ...CTX, userRole: 'MEMBER' }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

      // And the other direction — demoting oneself to a lesser role — is equally
      // refused, so the endpoint is not a self-escalation in either direction.
      await expect(
        service.updateMemberRole('proj-1', 'user-1', 'VIEWER', { ...CTX, userRole: 'MEMBER' }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(memberRepo.updateRole).not.toHaveBeenCalled();
    });

    it('TASK 3b: changing your own role IS allowed for a tenant ADMIN — no escalation, the 403 is for tenant non-admins', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'VIEWER' }));
      memberRepo.updateRole.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));

      const result = await service.updateMemberRole('proj-1', 'user-1', 'PROJECT_ADMIN', CTX);

      expect(result.role).toBe('PROJECT_ADMIN');
    });

    it('F24: refuses to demote the LAST active PROJECT_ADMIN (409)', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));
      memberRepo.findByProject.mockResolvedValue([makeProjectMember({ role: 'PROJECT_ADMIN' })]);

      await expect(service.updateMemberRole('proj-1', 'user-1', 'VIEWER', CTX)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(memberRepo.updateRole).not.toHaveBeenCalled();
    });

    it('F24: demoting one of SEVERAL PROJECT_ADMINs is allowed', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));
      memberRepo.findByProject.mockResolvedValue([
        makeProjectMember({ role: 'PROJECT_ADMIN' }),
        makeProjectMember({ id: 'pmember-2', userId: 'user-2', role: 'PROJECT_ADMIN' }),
      ]);
      memberRepo.updateRole.mockResolvedValue(makeProjectMember({ role: 'VIEWER' }));

      const result = await service.updateMemberRole('proj-1', 'user-1', 'VIEWER', CTX);

      expect(result.role).toBe('VIEWER');
      expect(memberRepo.updateRole).toHaveBeenCalledWith('proj-1', 'user-1', 'VIEWER');
    });

    it('F24: promoting to PROJECT_ADMIN never trips the invariant (the seat count only grows)', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'VIEWER' }));
      memberRepo.findByProject.mockResolvedValue([makeProjectMember({ role: 'PROJECT_ADMIN' })]);
      memberRepo.updateRole.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));

      await expect(service.updateMemberRole('proj-1', 'user-1', 'PROJECT_ADMIN', CTX)).resolves.toMatchObject({
        role: 'PROJECT_ADMIN',
      });
    });

    it('F24: an unresolvable current seat is left to updateRole, which still answers 404', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(null);
      memberRepo.updateRole.mockResolvedValue(null);

      await expect(service.updateMemberRole('proj-1', 'ghost', 'VIEWER', CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  // ── removeMember ──────────────────────────────────────────────────────────

  describe('removeMember', () => {
    it('removes a member from the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.delete.mockResolvedValue(true);

      await service.removeMember('proj-1', 'user-2', CTX);

      expect(memberRepo.delete).toHaveBeenCalledWith('proj-1', 'user-2');
    });

    it('throws NotFoundError when member not found', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.delete.mockResolvedValue(false);

      await expect(service.removeMember('proj-1', 'missing', CTX)).rejects.toThrow('not found');
    });

    it('M-002: a foreign-tenant OWNER cannot remove members of a foreign project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.removeMember('proj-1', 'user-2', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('F24: refuses to remove the LAST active PROJECT_ADMIN (409) and deletes nobody', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));
      memberRepo.findByProject.mockResolvedValue([makeProjectMember({ role: 'PROJECT_ADMIN' })]);

      await expect(service.removeMember('proj-1', 'user-1', CTX)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('F24: removing one of SEVERAL PROJECT_ADMINs is allowed', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));
      memberRepo.findByProject.mockResolvedValue([
        makeProjectMember({ role: 'PROJECT_ADMIN' }),
        makeProjectMember({ id: 'pmember-2', userId: 'user-2', role: 'PROJECT_ADMIN' }),
      ]);
      memberRepo.delete.mockResolvedValue(true);

      await service.removeMember('proj-1', 'user-1', CTX);

      expect(memberRepo.delete).toHaveBeenCalledWith('proj-1', 'user-1');
    });

    it('F24: removing a non-admin VIEWER never trips the invariant', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ userId: 'user-2', role: 'VIEWER' }));
      memberRepo.findByProject.mockResolvedValue([makeProjectMember({ role: 'PROJECT_ADMIN' })]);
      memberRepo.delete.mockResolvedValue(true);

      await service.removeMember('proj-1', 'user-2', CTX);

      expect(memberRepo.delete).toHaveBeenCalledWith('proj-1', 'user-2');
    });

    it('F24: the invariant is checked AFTER the tenant gate, so a tenant MEMBER still gets 403 (not 409)', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByUserAndProject.mockResolvedValue(makeProjectMember({ role: 'PROJECT_ADMIN' }));

      await expect(service.removeMember('proj-1', 'user-1', { ...CTX, userRole: 'MEMBER' })).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(memberRepo.findByProject).not.toHaveBeenCalled();
    });
  });

  // ── getProjectMembers ─────────────────────────────────────────────────────

  // ── permanentDelete / purgeProjectData (cascade; purge) ───────────────────

  describe('permanentDelete', () => {
    it('cascades through every repo and removes memberships and the project', async () => {
      projectRepo.findById.mockResolvedValue(makeProject({ status: 'DELETION_PENDING' }));
      memberRepo.findByProject.mockResolvedValue([makeProjectMember(), makeProjectMember({ userId: 'user-2' })]);
      cascadeRepos.taskRepo.findIdsByProject.mockResolvedValue(['task-1', 'task-2']);

      await service.permanentDelete('proj-1');

      // Every one of the cascade repos must be exercised — this whole block
      // was dead while the cascade deps were `undefined`.
      expect(cascadeRepos.taskRepo.findIdsByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.commentRepo.deleteByTaskIds).toHaveBeenCalledWith(['task-1', 'task-2']);
      expect(cascadeRepos.relationshipRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.taskRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.sprintRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.boardRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.labelRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.statusRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.taskTypeRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.filterRepo.deleteByProject).toHaveBeenCalledWith('proj-1');
      expect(cascadeRepos.counterRepo.deleteByProject).toHaveBeenCalledWith('proj-1');

      // The audit rows are NOT deleted. The retention window is a TTL index,
      // and a purge that removed the log would destroy the record of itself — the
      // exact defect this assertion now pins. The record is APPENDED instead
      // (asserted in `purge-cascade.guardrail.test.ts`).
      expect(cascadeRepos.auditRepo.deleteByProject).not.toHaveBeenCalled();

      // Comments are removed BEFORE the tasks they hang off
      const commentOrder = cascadeRepos.commentRepo.deleteByTaskIds.mock.invocationCallOrder[0] ?? 0;
      const taskOrder = cascadeRepos.taskRepo.deleteByProject.mock.invocationCallOrder[0] ?? 0;

      expect(commentOrder).toBeLessThan(taskOrder);

      expect(memberRepo.delete).toHaveBeenCalledTimes(2);
      expect(projectRepo.delete).toHaveBeenCalledWith('proj-1');
    });

    it('refuses to run unless the project is in DELETION_PENDING', async () => {
      projectRepo.findById.mockResolvedValue(makeProject({ status: 'ACTIVE' }));

      await expect(service.permanentDelete('proj-1')).rejects.toThrow('DELETION_PENDING');
      expect(cascadeRepos.taskRepo.deleteByProject).not.toHaveBeenCalled();
      expect(projectRepo.delete).not.toHaveBeenCalled();
    });
  });

  // ── Project audit events (the restored audit service) ─────────────────────

  describe('audit side effects', () => {
    it('writes a PROJECT CREATED event', async () => {
      projectRepo.findByTenantAndKey.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue(makeProject({ defaultStatusId: '' }));
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.create.mockResolvedValue(makeProjectMember());

      await service.createProject('tenant-1', 'user-1', 'ADMIN', { key: 'TEST', name: 'Test Project' });

      expect(auditService.log).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        entityType: 'PROJECT',
        entityId: 'proj-1',
        action: 'CREATED',
        actorId: 'user-1',
      });
    });

    it('writes a PROJECT UPDATED event with the field diff', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      projectRepo.update.mockResolvedValue(makeProject({ name: 'Updated' }));

      await service.updateProject('proj-1', { name: 'Updated' }, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          entityType: 'PROJECT',
          action: 'UPDATED',
          actorId: 'user-1',
          changes: [{ field: 'name', oldValue: 'Test Project', newValue: 'Updated' }],
        }),
      );
    });

    it('writes a PROJECT DELETED event on deleteProject', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await service.deleteProject('proj-1', CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'PROJECT', action: 'DELETED', actorId: 'user-1' }),
      );
    });

    it('M-006: the actor is no longer optional — a context without a userId is 401 and writes no event', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      projectRepo.update.mockResolvedValue(makeProject({ name: 'Updated' }));

      await expect(
        service.updateProject('proj-1', { name: 'Updated' }, { tenantId: 'tenant-1', userId: '', userRole: 'ADMIN' }),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(auditService.log).not.toHaveBeenCalled();
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── getProjectMembers ─────────────────────────────────────────────────────

  describe('getProjectMembers', () => {
    it('returns all project members', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());
      memberRepo.findByProjectWithUsers.mockResolvedValue([
        makeProjectMember(),
        makeProjectMember({ id: 'pm-2', userId: 'user-2', role: 'EDITOR' }),
      ]);

      const result = await service.getProjectMembers('proj-1', CTX);

      expect(result).toHaveLength(2);
    });

    it('M-002: a foreign tenant cannot list the members of a project it does not own', async () => {
      projectRepo.findById.mockResolvedValue(makeProject());

      await expect(service.getProjectMembers('proj-1', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(memberRepo.findByProjectWithUsers).not.toHaveBeenCalled();
    });
  });
});
