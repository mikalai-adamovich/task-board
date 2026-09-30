/**
 * The `E11000` → 409 mapping, per service.
 *
 * F11's unique indexes turned a check-then-insert race from "two documents
 * nobody notices" into a hard failure, and the failure reached the client as a
 * 500 `INTERNAL_ERROR`. This file pins the fixed behaviour for every affected
 * service: a lost uniqueness race produces the SAME 409 the pre-check produces,
 * with a message that names no index, no collection and no driver code.
 *
 * The per-service happy paths and the pre-check 409s already have their own
 * coverage in each `<service>.test.ts`; what is new here is exclusively the
 * race branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterService } from './filter.service.js';
import { TaskRelationshipService } from './task-relationship.service.js';
import { StatusService } from './status.service.js';
import { TaskTypeService } from './task-type.service.js';
import { TenantMemberService } from './tenant-member.service.js';
import { AuthService } from './auth.service.js';
import { DUPLICATE_KEY_CODE } from '../db/duplicate-key.js';
import type { CallerContext } from './tenant-assert.js';

/** The error the driver raises when a unique index rejects an insert. */
function e11000(indexName: string): Error {
  return Object.assign(
    new Error(`E11000 duplicate key error collection: task_relationships index: ${indexName} dup key: { x: 1 }`),
    { code: DUPLICATE_KEY_CODE, codeName: 'DuplicateKey' },
  );
}

/** Assert a rejected call produced a clean 409 that leaks no driver detail. */
async function expectConflict(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(Error);

  const appError = err as { statusCode?: number; code?: string; message?: string };

  expect(appError.statusCode).toBe(409);
  expect(appError.code).toBe(code);
  // No driver detail may reach the client.
  expect(appError.message).not.toContain('E11000');
  expect(appError.message).not.toContain('index');
  expect(appError.message).not.toContain('collection');
  expect(appError.message).not.toContain('dup key');
}

const CTX: CallerContext = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

describe('E11000 → 409 — FilterService (filters {userId,projectId,name}, F11)', () => {
  it('reports a lost save-filter race as the same conflict as the pre-check', async () => {
    const filterRepo = {
      findByUserProjectAndName: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(e11000('userId_1_projectId_1_name_1')),
    };
    const projectRepo = { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) };
    const service = new FilterService(filterRepo as never, projectRepo as never);

    await expectConflict(
      service.createFilter(
        'project-1',
        { name: 'My Open Tasks', filters: {}, sort: { field: 'createdAt', direction: 'desc' } } as never,
        CTX,
      ),
      'CONFLICT',
    );
  });
});

describe('E11000 → 409 — TaskRelationshipService (task_relationships, F11)', () => {
  let relationshipRepo: { create: ReturnType<typeof vi.fn> };
  let service: TaskRelationshipService;

  beforeEach(() => {
    relationshipRepo = { create: vi.fn().mockRejectedValue(e11000('projectId_1_sourceTaskId_1_targetTaskId_1')) };
    service = new TaskRelationshipService(
      relationshipRepo as never,
      { findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' }) } as never,
      { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) } as never,
      undefined,
      { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) } as never,
    );
  });

  it('reports the same relationship created twice as a conflict', async () => {
    await expectConflict(
      service.createRelationship('task-1', { targetTaskId: 'task-2', type: 'BLOCKS' } as never, CTX),
      'CONFLICT',
    );
  });

  it('reports a collided relationship id as a conflict, never a 500', async () => {
    relationshipRepo.create.mockRejectedValue(e11000('id_1'));

    await expectConflict(
      service.createRelationship('task-1', { targetTaskId: 'task-2', type: 'BLOCKS' } as never, CTX),
      'CONFLICT',
    );
  });
});

describe('E11000 → 409 — StatusService (statuses {projectId,normalizedName})', () => {
  it('reports a lost create race as DUPLICATE_STATUS', async () => {
    const service = new StatusService(
      {
        findByProjectAndNormalizedName: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(e11000('projectId_1_normalizedName_1')),
      } as never,
      { countByStatus: vi.fn(), updateManyByStatus: vi.fn(), setStatusNameForTasks: vi.fn() } as never,
      { replaceStatusInColumns: vi.fn() } as never,
      { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) } as never,
      undefined,
      { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) } as never,
    );

    await expectConflict(service.createStatus('project-1', { name: 'In Review' } as never, CTX), 'DUPLICATE_STATUS');
  });

  it('reports a lost rename race as DUPLICATE_STATUS', async () => {
    const service = new StatusService(
      {
        findById: vi.fn().mockResolvedValue({ id: 'status-1', projectId: 'project-1', name: 'TODO', position: 0 }),
        findByProjectAndNormalizedName: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(e11000('projectId_1_normalizedName_1')),
      } as never,
      { countByStatus: vi.fn(), updateManyByStatus: vi.fn(), setStatusNameForTasks: vi.fn() } as never,
      { replaceStatusInColumns: vi.fn() } as never,
      { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) } as never,
      undefined,
      { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) } as never,
    );

    await expectConflict(service.updateStatus('status-1', { name: 'Done' } as never, CTX), 'DUPLICATE_STATUS');
  });
});

describe('E11000 → 409 — TaskTypeService (task_types {projectId,key})', () => {
  it('reports a lost create race as a conflict', async () => {
    const service = new TaskTypeService(
      {
        findByProjectAndKey: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(e11000('projectId_1_key_1')),
      } as never,
      { countByType: vi.fn(), updateManyByType: vi.fn() } as never,
      { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: 'ACTIVE' }) } as never,
      undefined,
      { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) } as never,
    );

    await expectConflict(service.createTaskType('project-1', { key: 'BUG', name: 'Bug' } as never, CTX), 'CONFLICT');
  });
});

describe('E11000 → 409 — TenantMemberService (tenant_members {tenantId,userId})', () => {
  it('reports a lost invitation race as "already a member"', async () => {
    // The requester is an OWNER (so authorization passes); the invitee has no
    // membership yet — the unique `{tenantId,userId}` index is what rejects the
    // concurrent winner's insert.
    const tenantMemberRepo = {
      findByUserAndTenant: vi.fn((userId: string) =>
        Promise.resolve(
          userId === 'requester-1'
            ? { id: 'm-1', userId, tenantId: 'tenant-1', role: 'OWNER', status: 'ACTIVE', invitation: null }
            : null,
        ),
      ),
      create: vi.fn().mockRejectedValue(e11000('tenantId_1_userId_1')),
    };
    const service = new TenantMemberService(
      { findById: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Acme', status: 'ACTIVE' }) } as never,
      tenantMemberRepo as never,
      { findByEmail: vi.fn().mockResolvedValue({ id: 'user-2' }) } as never,
      { sendInvitationEmail: vi.fn().mockResolvedValue(undefined) } as never,
      // The fifth dependency is the audit service (a required constructor
      // parameter, like every other audited service). The insert below is
      // REJECTED, so this case never reaches an audit write.
      { log: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expectConflict(service.inviteUser('requester-1', 'tenant-1', 'user-2@example.com', 'MEMBER'), 'CONFLICT');
    expect(tenantMemberRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe('E11000 → 409 — AuthService (users {email})', () => {
  it('reports a lost registration race as the same "email taken" conflict', async () => {
    const userRepo = {
      findByEmail: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(e11000('email_1')),
    };
    const service = new AuthService(
      userRepo as never,
      {} as never,
      { findPendingByEmail: vi.fn().mockResolvedValue([]) } as never,
      'test-secret',
      null,
    );

    // The message must not confirm whether the account exists beyond what the
    // pre-check already said — the driver's `dup key: { email: … }` would.
    await expectConflict(
      service.register({ email: 'user@example.com', password: 'Password123!', displayName: 'User' }),
      'CONFLICT',
    );
  });
});
