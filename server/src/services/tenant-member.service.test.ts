/**
 * Tests for TenantMemberService — DEC-018 membership semantics:
 * invited memberships persist as ACCESS_REVOKED + invitation PENDING;
 * only explicit acceptance flips them to ACTIVE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantMember } from '@task-board/shared';
import { MemberStatus, InvitationStatus } from '@task-board/shared';
import { TenantMemberService } from './tenant-member.service.js';
import { AppError, ConflictError } from '../errors/app-error.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockTenantRepo() {
  return {
    findById: vi.fn(),
    findByIds: vi.fn().mockResolvedValue([]),
  };
}

function createMockTenantMemberRepo() {
  return {
    findByUserAndTenant: vi.fn(),
    findByTenant: vi.fn().mockResolvedValue([]),
    findByTenantWithUsers: vi.fn().mockResolvedValue([]),
    findPendingByEmail: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateRole: vi.fn(),
    delete: vi.fn(),
    deleteById: vi.fn(),
  };
}

function createMockUserRepo() {
  return {
    findById: vi.fn(),
    findByIds: vi.fn().mockResolvedValue([]),
    findByEmail: vi.fn(),
    create: vi.fn(),
    updateProfile: vi.fn(),
  };
}

function createMockEmailService() {
  return {
    sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
  };
}

/** Every membership transition writes exactly one audit event. */
function createMockAuditService() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logMany: vi.fn().mockResolvedValue(undefined),
  };
}

const NOW = '2025-01-01T00:00:00.000Z';

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'OWNER',
    status: 'ACTIVE',
    expiresAt: null,
    invitation: null,
    displayName: null,
    email: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePendingInvitation(overrides: Record<string, unknown> = {}) {
  return {
    status: InvitationStatus.PENDING,
    tokenHash: 'hash',
    invitedBy: 'owner-1',
    invitedOn: NOW,
    invitedEmail: 'invitee@example.com',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TenantMemberService (DEC-018 semantics)', () => {
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let emailService: ReturnType<typeof createMockEmailService>;
  let service: TenantMemberService;

  beforeEach(() => {
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    userRepo = createMockUserRepo();
    emailService = createMockEmailService();
    service = new TenantMemberService(
      tenantRepo as never,
      memberRepo as never,
      userRepo as never,
      emailService as never,
      createMockAuditService() as never,
    );
    // Default: requester is an ACTIVE owner of an active tenant
    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember());
    tenantRepo.findById.mockResolvedValue({ id: 'tenant-1', name: 'Test Workspace', status: 'ACTIVE' });
  });

  // ── inviteUser ──────────────────────────────────────────────────────────

  describe('inviteUser', () => {
    it('creates the membership as ACCESS_REVOKED with a PENDING invitation', async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.create.mockResolvedValue({ id: 'user-new', email: 'invitee@example.com' });
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(null); // no existing membership for invitee
      memberRepo.create.mockResolvedValue(
        makeMember({
          id: 'member-new',
          userId: 'user-new',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: makePendingInvitation(),
        }),
      );

      await service.inviteUser('user-1', 'tenant-1', 'invitee@example.com', 'MEMBER');

      expect(memberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-new',
          tenantId: 'tenant-1',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: expect.objectContaining({
            status: InvitationStatus.PENDING,
            invitedEmail: 'invitee@example.com',
          }),
        }),
      );
    });

    it('rejects inviting an already-active member without a pending invitation', async () => {
      userRepo.findByEmail.mockResolvedValue({ id: 'user-2', email: 'active@example.com' });
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' })); // active member

      await expect(service.inviteUser('user-1', 'tenant-1', 'active@example.com', 'MEMBER')).rejects.toThrow(
        ConflictError,
      );
    });

    it('re-inviting a member with a PENDING invitation replaces the token and keeps ACCESS_REVOKED', async () => {
      userRepo.findByEmail.mockResolvedValue({ id: 'user-2', email: 'pending@example.com' });

      const pendingMember = makeMember({
        id: 'member-2',
        userId: 'user-2',
        role: 'MEMBER',
        status: MemberStatus.ACCESS_REVOKED,
        invitation: makePendingInvitation({ invitedBy: 'someone-else' }),
      });

      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(pendingMember) // active-check for existing user
        .mockResolvedValueOnce(pendingMember); // pending-invitation lookup
      memberRepo.update.mockResolvedValue(pendingMember);

      await service.inviteUser('user-1', 'tenant-1', 'pending@example.com', 'ADMIN');

      expect(memberRepo.update).toHaveBeenCalledWith(
        'member-2',
        expect.objectContaining({
          role: 'ADMIN',
          invitation: expect.objectContaining({
            status: InvitationStatus.PENDING,
            invitedEmail: 'pending@example.com',
          }),
        }),
      );
      // No second membership doc created
      expect(memberRepo.create).not.toHaveBeenCalled();
    });
  });

  // ── acceptInvitation ────────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    it('flips the membership to ACTIVE and clears the invitation', async () => {
      memberRepo.findById.mockResolvedValue(
        makeMember({
          id: 'member-2',
          userId: 'user-2',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: makePendingInvitation({ invitedOn: new Date().toISOString() }),
        }),
      );

      await service.acceptInvitation('member-2', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', {
        invitation: null,
        status: MemberStatus.ACTIVE,
        expiresAt: null,
      });
    });

    it('rejects a user trying to accept someone else’s invitation (M-01)', async () => {
      memberRepo.findById.mockResolvedValue(
        makeMember({
          id: 'member-2',
          userId: 'user-2',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: makePendingInvitation({ invitedOn: new Date().toISOString() }),
        }),
      );

      await expect(service.acceptInvitation('member-2', 'user-OTHER')).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('on expiry keeps the membership ACCESS_REVOKED and marks the invitation EXPIRED', async () => {
      memberRepo.findById.mockResolvedValue(
        makeMember({
          id: 'member-2',
          userId: 'user-2',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: makePendingInvitation({ invitedOn: '2020-01-01T00:00:00.000Z' }),
        }),
      );

      await expect(service.acceptInvitation('member-2', 'user-2')).rejects.toMatchObject({
        code: 'INVITATION_EXPIRED',
      });

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', {
        invitation: expect.objectContaining({ status: InvitationStatus.EXPIRED }),
      });
    });
  });

  // ── declineInvitation / revokeInvitation ────────────────────────────────

  describe('declineInvitation', () => {
    it('marks the invitation DECLINED and leaves the membership ACCESS_REVOKED', async () => {
      memberRepo.findById.mockResolvedValue(
        makeMember({
          id: 'member-2',
          userId: 'user-2',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: makePendingInvitation(),
        }),
      );

      await service.declineInvitation('member-2', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', {
        invitation: expect.objectContaining({ status: InvitationStatus.DECLINED }),
      });
    });
  });

  describe('revokeInvitation', () => {
    it('marks the invitation REVOKED and leaves the membership ACCESS_REVOKED (target addressed by userId)', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(
          makeMember({
            id: 'member-2',
            userId: 'user-2',
            role: 'MEMBER',
            status: MemberStatus.ACCESS_REVOKED,
            invitation: makePendingInvitation(),
          }),
        );

      await service.revokeInvitation('user-1', 'tenant-1', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', {
        invitation: expect.objectContaining({ status: InvitationStatus.REVOKED }),
      });
    });

    it('rejects when the invitation is no longer pending', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember())
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }));

      await expect(service.revokeInvitation('user-1', 'tenant-1', 'user-2')).rejects.toThrow(ConflictError);
    });
  });

  // ── reinviteUser ────────────────────────────────────────────────────────

  describe('reinviteUser', () => {
    it('resets the invitation to PENDING and enforces the ACCESS_REVOKED invariant (target by userId)', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(
          makeMember({
            id: 'member-2',
            userId: 'user-2',
            role: 'MEMBER',
            status: MemberStatus.ACCESS_REVOKED,
            invitation: makePendingInvitation({ status: InvitationStatus.EXPIRED }),
          }),
        );
      userRepo.findById.mockResolvedValue({ id: 'user-2', email: 'Invitee@Example.com' });

      await service.reinviteUser('user-1', 'tenant-1', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', {
        status: MemberStatus.ACCESS_REVOKED,
        invitation: expect.objectContaining({
          status: InvitationStatus.PENDING,
          invitedEmail: 'invitee@example.com',
        }),
      });
    });
  });

  // ── restoreMembership ───────────────────────────────────────────────────

  describe('restoreMembership', () => {
    it('rejects restoring a membership with a PENDING invitation (BR-036, target by userId)', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(
          makeMember({
            id: 'member-2',
            userId: 'user-2',
            role: 'MEMBER',
            status: MemberStatus.ACCESS_REVOKED,
            invitation: makePendingInvitation(),
          }),
        );

      await expect(service.restoreMembership('user-1', 'tenant-1', 'user-2')).rejects.toThrow(ConflictError);

      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('restores a plain revoked membership (no pending invitation, target by userId)', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(
          makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER', status: MemberStatus.ACCESS_REVOKED }),
        );

      await service.restoreMembership('user-1', 'tenant-1', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', { status: MemberStatus.ACTIVE, expiresAt: null });
    });

    it('revoking access then restoring round-trips via userId addressing', async () => {
      const revoked = makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER', status: 'ACCESS_REVOKED' });

      // revokeAccess
      memberRepo.findByUserAndTenant.mockResolvedValueOnce(makeMember()).mockResolvedValueOnce(revoked);
      await service.revokeAccess('user-1', 'tenant-1', 'user-2');
      expect(memberRepo.update).toHaveBeenCalledWith('member-2', { status: 'ACCESS_REVOKED' });

      // hardDeleteMember
      memberRepo.findByUserAndTenant.mockResolvedValueOnce(makeMember()).mockResolvedValueOnce(revoked);
      memberRepo.deleteById.mockResolvedValue(true);
      await service.hardDeleteMember('user-1', 'tenant-1', 'user-2');
      expect(memberRepo.deleteById).toHaveBeenCalledWith('member-2');
    });
  });

  // ── The last OWNER must never be revocable/demotable ────────────────────

  describe('M-026 last-OWNER invariant', () => {
    /** The requester is the sole ACTIVE owner; there is nobody else. */
    function lastOwnerSetup() {
      memberRepo.findByTenant.mockResolvedValue([makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' })]);
    }

    /** The requester is an owner, but a second ACTIVE owner also exists. */
    function twoOwnersSetup() {
      memberRepo.findByTenant.mockResolvedValue([
        makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }),
        makeMember({ id: 'member-2', userId: 'user-2', role: 'OWNER' }),
      ]);
    }

    it('does not fire for a THIRD party demoting the last owner (keeps the pre-existing 403)', async () => {
      lastOwnerSetup();
      // A different admin acts on the owner — not the owner acting on themselves.
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember({ id: 'admin-1', userId: 'admin-1', role: 'ADMIN' }))
        .mockResolvedValue(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }));

      await expect(service.updateMemberRole('admin-1', 'tenant-1', 'user-1', 'MEMBER')).rejects.toThrow("owner's role");
    });

    it('refuses the last OWNER removing their own membership with 409', async () => {
      lastOwnerSetup();

      await expect(service.removeMember('user-1', 'tenant-1', 'user-1')).rejects.toThrow(ConflictError);
      await expect(service.removeMember('user-1', 'tenant-1', 'user-1')).rejects.toThrow('last active owner');

      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('answers 409 (not 403) for the last-OWNER self-revoke', async () => {
      lastOwnerSetup();

      const err = await service.revokeAccess('user-1', 'tenant-1', 'user-1').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).statusCode).toBe(409);
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses the last OWNER revoking their own access with 409', async () => {
      lastOwnerSetup();

      await expect(service.revokeAccess('user-1', 'tenant-1', 'user-1')).rejects.toThrow('last active owner');

      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses the last OWNER demoting themselves with 409', async () => {
      lastOwnerSetup();
      memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }));

      await expect(service.updateMemberRole('user-1', 'tenant-1', 'user-1', 'ADMIN')).rejects.toThrow(ConflictError);
      await expect(service.updateMemberRole('user-1', 'tenant-1', 'user-1', 'ADMIN')).rejects.toThrow(
        'last active owner',
      );

      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('refuses the last OWNER hard-deleting themselves with 409', async () => {
      lastOwnerSetup();
      memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }));

      await expect(service.hardDeleteMember('user-1', 'tenant-1', 'user-1')).rejects.toThrow(ConflictError);

      expect(memberRepo.deleteById).not.toHaveBeenCalled();
    });

    it('still allows a NON-last owner to act on their own membership (falls through to the 403 guard)', async () => {
      twoOwnersSetup();
      memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }));

      // Another ACTIVE owner remains → the last-OWNER invariant does not fire.
      // The pre-existing blanket "you cannot touch an owner" 403 still applies.
      await expect(service.revokeAccess('user-1', 'tenant-1', 'user-1')).rejects.toThrow("Cannot revoke the owner's");
    });

    it('treats an EXPIRED owner as not a remaining owner (DEC-055 lazy expiry)', async () => {
      const past = '2020-01-01T00:00:00.000Z';

      memberRepo.findByTenant.mockResolvedValue([
        makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }),
        makeMember({ id: 'member-2', userId: 'user-2', role: 'OWNER', expiresAt: past }),
      ]);
      memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }));

      await expect(service.updateMemberRole('user-1', 'tenant-1', 'user-1', 'ADMIN')).rejects.toThrow(
        'last active owner',
      );
    });

    it('does not fire for a non-owner self-demotion', async () => {
      memberRepo.findByTenant.mockResolvedValue([
        makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' }),
        makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }),
      ]);
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember({ id: 'member-1', userId: 'user-1', role: 'OWNER' })) // requester
        .mockResolvedValue(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' })); // target
      memberRepo.update.mockResolvedValue(makeMember({ id: 'member-2', userId: 'user-2', role: 'ADMIN' }));
      userRepo.findById.mockResolvedValue({ id: 'user-2', displayName: 'Member', email: 'm@example.com' });

      const result = await service.updateMemberRole('user-1', 'tenant-1', 'user-2', 'ADMIN');

      expect(result.role).toBe('ADMIN');
    });
  });

  // ── getMyInvitations ────────────────────────────────────────────────────

  describe('getMyInvitations', () => {
    it('returns pending invitations looked up by invited email', async () => {
      memberRepo.findPendingByEmail.mockResolvedValue([
        {
          id: 'member-2',
          userId: 'user-2',
          tenantId: 'tenant-1',
          role: 'MEMBER',
          status: MemberStatus.ACCESS_REVOKED,
          invitation: {
            status: InvitationStatus.PENDING,
            tokenHash: 'hash',
            invitedBy: 'owner-1',
            invitedOn: new Date(NOW),
          },
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        },
      ]);
      userRepo.findByIds.mockResolvedValue([{ id: 'user-2', displayName: 'Invitee', email: 'invitee@example.com' }]);
      tenantRepo.findByIds.mockResolvedValue([{ id: 'tenant-1', name: 'Tenant 1' }]);

      const result = await service.getMyInvitations('invitee@example.com');

      expect(memberRepo.findPendingByEmail).toHaveBeenCalledWith('invitee@example.com');
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe(MemberStatus.ACCESS_REVOKED);
      expect(result[0]?.invitation?.status).toBe(InvitationStatus.PENDING);
    });
  });

  // ── Membership expiration ───────────────────────────────────────────────

  describe('DEC-055 membership expiration', () => {
    it('updateMember persists expiresAt on the membership document', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester (owner)
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' })); // target
      memberRepo.update.mockResolvedValue(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }));
      userRepo.findById.mockResolvedValue({ id: 'user-2', displayName: 'Member', email: 'm@example.com' });

      const result = await service.updateMember('user-1', 'tenant-1', 'user-2', {
        expiresAt: '2030-01-01T00:00:00.000Z',
      });

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', { expiresAt: new Date('2030-01-01T00:00:00.000Z') });
      expect(result.expiresAt).toBeNull(); // from the mocked repo return
    });

    it('updateMember forbids setting an expiration on the workspace OWNER', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'owner-1', role: 'OWNER' })); // target owner

      await expect(
        service.updateMember('user-1', 'tenant-1', 'owner-1', { expiresAt: '2030-01-01T00:00:00.000Z' }),
      ).rejects.toThrow('expiration');

      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('denies access once the expiration date has passed and lazily flips the stored status', async () => {
      const past = '2020-01-01T00:00:00.000Z';

      memberRepo.findByUserAndTenant.mockResolvedValue(
        makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER', expiresAt: past }),
      );

      await expect(service.updateMemberRole('user-2', 'tenant-1', 'user-2', 'ADMIN')).rejects.toThrow(
        'membership has expired',
      );

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', { status: MemberStatus.ACCESS_REVOKED });
    });

    it('restores an expired-but-still-ACTIVE membership by clearing expiresAt', async () => {
      const past = '2020-01-01T00:00:00.000Z';

      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(
          makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER', status: 'ACTIVE', expiresAt: past }),
        );

      await service.restoreMembership('user-1', 'tenant-1', 'user-2');

      expect(memberRepo.update).toHaveBeenCalledWith('member-2', { status: MemberStatus.ACTIVE, expiresAt: null });
    });

    it('updateMember applies name/email changes to the underlying USER record', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }));
      userRepo.findById
        .mockResolvedValueOnce({ id: 'user-2', displayName: 'Old', email: 'old@example.com' }) // profile check
        .mockResolvedValueOnce({ id: 'user-2', displayName: 'New', email: 'new@example.com' }); // fresh read
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.updateProfile.mockResolvedValue({ id: 'user-2', displayName: 'New', email: 'new@example.com' });
      memberRepo.update.mockResolvedValue(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }));

      const result = await service.updateMember('user-1', 'tenant-1', 'user-2', {
        name: 'New',
        email: 'new@example.com',
      });

      expect(userRepo.updateProfile).toHaveBeenCalledWith('user-2', { displayName: 'New', email: 'new@example.com' });
      expect(result.displayName).toBe('New');
      expect(result.email).toBe('new@example.com');
    });

    it('updateMember rejects an email already used by another user', async () => {
      memberRepo.findByUserAndTenant
        .mockResolvedValueOnce(makeMember()) // requester
        .mockResolvedValueOnce(makeMember({ id: 'member-2', userId: 'user-2', role: 'MEMBER' }));
      userRepo.findById.mockResolvedValue({ id: 'user-2', displayName: 'Old', email: 'old@example.com' });
      userRepo.findByEmail.mockResolvedValue({ id: 'user-9', email: 'taken@example.com' });

      await expect(
        service.updateMember('user-1', 'tenant-1', 'user-2', { email: 'taken@example.com' }),
      ).rejects.toThrow(ConflictError);

      expect(memberRepo.update).not.toHaveBeenCalled();
    });
  });
});

// ─── precheckedMembership (tenant-context reuse) ─────────────────────────────

describe('TenantMemberService — precheckedMembership reuse', () => {
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let emailService: ReturnType<typeof createMockEmailService>;
  let service: TenantMemberService;

  beforeEach(() => {
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    userRepo = createMockUserRepo();
    emailService = createMockEmailService();
    service = new TenantMemberService(
      tenantRepo as never,
      memberRepo as never,
      userRepo as never,
      emailService as never,
      createMockAuditService() as never,
    );
    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember());
    memberRepo.findByTenantWithUsers.mockResolvedValue([{ ...makeMember(), userEmail: null, userDisplayName: null }]);
  });

  it('skips the membership lookup when the prechecked membership matches', async () => {
    const prechecked = makeMember() as TenantMember;
    const members = await service.getTenantMembers('user-1', 'tenant-1', prechecked);

    expect(memberRepo.findByUserAndTenant).not.toHaveBeenCalled();
    expect(memberRepo.findByTenantWithUsers).toHaveBeenCalledWith('tenant-1');
    expect(members.length).toBe(1);
  });

  it('performs the lookup when the prechecked membership is for another tenant', async () => {
    const prechecked = makeMember({ tenantId: 'tenant-OTHER' }) as TenantMember;

    await service.getTenantMembers('user-1', 'tenant-1', prechecked);

    expect(memberRepo.findByUserAndTenant).toHaveBeenCalledWith('user-1', 'tenant-1');
  });

  it('performs the lookup when no prechecked membership is provided (standalone invocation)', async () => {
    await service.getTenantMembers('user-1', 'tenant-1');

    expect(memberRepo.findByUserAndTenant).toHaveBeenCalledWith('user-1', 'tenant-1');
  });
});

// ─── Invitation e-mail cooldown (abuse prevention) ────────────────────────────
//
// Every invitation triggers an OUTBOUND e-mail. The cooldown bounds how many one
// user can trigger; it is NOT a delivery-throughput limiter (Resend is not
// configured — that question is deferred to the owner).
//
// The limiters are module-level and shared across tests, so every case below
// uses a UNIQUE requester id (per-user budget) and a UNIQUE invitee address
// (per-(workspace, address) cooldown) to get private counters.

describe('TenantMemberService — invitation cooldown (F10)', () => {
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let emailService: ReturnType<typeof createMockEmailService>;
  let service: TenantMemberService;
  let unique = 0;
  const nextKey = () => `f10inv-${(unique += 1)}`;

  beforeEach(() => {
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    userRepo = createMockUserRepo();
    emailService = createMockEmailService();
    service = new TenantMemberService(
      tenantRepo as never,
      memberRepo as never,
      userRepo as never,
      emailService as never,
      createMockAuditService() as never,
    );
    // Requester is an ACTIVE owner; the invitee has no membership yet.
    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember());
    tenantRepo.findById.mockResolvedValue({ id: 'tenant-1', name: 'Test Workspace', status: 'ACTIVE' });
    userRepo.findByEmail.mockResolvedValue(null);
    userRepo.create.mockResolvedValue({ id: 'user-new', email: 'x@example.com' });
    userRepo.findById.mockResolvedValue({ id: 'user-1', displayName: 'Owner', email: 'owner@example.com' });
    memberRepo.create.mockResolvedValue(makeMember({ id: 'member-new', userId: 'user-new' }));
    memberRepo.update.mockResolvedValue(makeMember({ id: 'member-2', userId: 'user-2' }));
  });

  it('sends the invitation e-mail on the first invite to an address', async () => {
    await service.inviteUser('user-1', 'tenant-1', `${nextKey()}@example.com`, 'MEMBER');

    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects a second invite to the SAME address within the cooldown (no second e-mail)', async () => {
    const email = `${nextKey()}@example.com`;

    await service.inviteUser('user-1', 'tenant-1', email, 'MEMBER');

    const err = await service.inviteUser('user-1', 'tenant-1', email, 'MEMBER').catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(429);
    expect((err as AppError).code).toBe('RATE_LIMITED');
    // No second e-mail went out — that is the whole point of the cooldown.
    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('carries Retry-After on the cooldown rejection (F6 header contract)', async () => {
    const email = `${nextKey()}@example.com`;

    await service.inviteUser('user-1', 'tenant-1', email, 'MEMBER');

    const err = (await service.inviteUser('user-1', 'tenant-1', email, 'MEMBER').catch((e: unknown) => e)) as AppError;

    expect(Number(err.headers?.['Retry-After'])).toBeGreaterThan(0);
    expect(err.headers?.['RateLimit-Remaining']).toBe('0');
  });

  it('normalizes the address, so case/whitespace cannot buy a second e-mail', async () => {
    const email = `${nextKey()}@example.com`;

    await service.inviteUser('user-1', 'tenant-1', email, 'MEMBER');

    const err = await service
      .inviteUser('user-1', 'tenant-1', `  ${email.toUpperCase()} `, 'MEMBER')
      .catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(429);
  });

  it('a DIFFERENT address is a different key — bulk onboarding is unaffected', async () => {
    const requester = `owner-${nextKey()}`;

    await service.inviteUser(requester, 'tenant-1', `${nextKey()}-a@example.com`, 'MEMBER');
    await service.inviteUser(requester, 'tenant-1', `${nextKey()}-b@example.com`, 'MEMBER');
    await service.inviteUser(requester, 'tenant-1', `${nextKey()}-c@example.com`, 'MEMBER');

    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(3);
  });

  it('caps a spray across MANY addresses at the per-user budget (20/hour)', async () => {
    const requester = `sprayer-${nextKey()}`;
    let limited: AppError | null = null;
    let attempts = 0;

    for (let i = 0; i < 40 && limited === null; i++) {
      attempts += 1;

      const err = await service
        .inviteUser(requester, 'tenant-1', `spray-${nextKey()}-${i}@example.com`, 'MEMBER')
        .catch((e: unknown) => e);

      if ((err as AppError).statusCode === 429) {
        limited = err as AppError;
      }
    }

    expect(limited?.code).toBe('RATE_LIMITED');
    expect(limited?.message).toBe('Invitation limit reached. Try again later.');
    // 20 invitations sent, the 21st rejected.
    expect(attempts).toBe(21);
    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(20);
  });

  it('does not let one user exhaust another user’s budget', async () => {
    const noisy = `noisy-${nextKey()}`;
    const quiet = `quiet-${nextKey()}`;

    for (let i = 0; i < 20; i++) {
      await service.inviteUser(noisy, 'tenant-1', `n-${nextKey()}-${i}@example.com`, 'MEMBER');
    }

    const err = await service
      .inviteUser(noisy, 'tenant-1', `${nextKey()}@example.com`, 'MEMBER')
      .catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(429);

    await expect(service.inviteUser(quiet, 'tenant-1', `${nextKey()}@example.com`, 'MEMBER')).resolves.toBeDefined();
  });

  it('a re-invite draws on the same cooldown (it re-sends the e-mail)', async () => {
    const requester = `reinviter-${nextKey()}`;
    const targetUser = `target-${nextKey()}`;

    // Keyed on the addressed user, so BOTH reinvites resolve the same target — the
    // cooldown key is the target's user id.
    memberRepo.findByUserAndTenant.mockImplementation((userId: string) =>
      Promise.resolve(
        userId === requester
          ? makeMember({ id: 'm1', userId: requester })
          : makeMember({ id: 'member-2', userId: targetUser, role: 'MEMBER', invitation: null }),
      ),
    );
    userRepo.findById.mockResolvedValue({ id: targetUser, displayName: 'T', email: 'target@example.com' });

    await service.reinviteUser(requester, 'tenant-1', targetUser);

    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);

    const err = await service.reinviteUser(requester, 'tenant-1', targetUser).catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(429);
    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('a 403 for a non-admin does NOT consume an invitation budget', async () => {
    const requester = `member-${nextKey()}`;

    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'm1', userId: requester, role: 'MEMBER' }));

    const err = await service
      .inviteUser(requester, 'tenant-1', `${nextKey()}@example.com`, 'MEMBER')
      .catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(403);
    expect(emailService.sendInvitationEmail).not.toHaveBeenCalled();

    // The same requester, now an owner, still has a full budget.
    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'm1', userId: requester, role: 'OWNER' }));

    await expect(
      service.inviteUser(requester, 'tenant-1', `${nextKey()}@example.com`, 'MEMBER'),
    ).resolves.toBeDefined();
    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });
});

// ─── Every membership transition is auditable ─────────────────────────────────
//
// The dataset whose purpose is "who may see what" had no actor record for any
// of its transitions. The unit of the guardrail is the TRANSITION, not the
// route: a row per method × from-state × to-state, each asserting that the
// write happened, that it happened EXACTLY once, and that it names an actor.
//
// The table is a property table in the sense that matters: a row states the
// before/after states and derives the expectation, so a new transition is a new
// row rather than a change to what an existing one asserts.
describe('TenantMemberService — membership transitions are auditable (D-09)', () => {
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let emailService: ReturnType<typeof createMockEmailService>;
  let auditService: ReturnType<typeof createMockAuditService>;
  let service: TenantMemberService;

  /** The events written by the LAST call, as plain objects. */
  function events() {
    return (auditService.log as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);
  }

  function membershipEvents() {
    return events().filter((event) => event.entityType === 'MEMBERSHIP');
  }

  beforeEach(() => {
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    userRepo = createMockUserRepo();
    emailService = createMockEmailService();
    auditService = createMockAuditService();
    service = new TenantMemberService(
      tenantRepo as never,
      memberRepo as never,
      userRepo as never,
      emailService as never,
      auditService as never,
    );
    tenantRepo.findById.mockResolvedValue({ id: 'tenant-1', name: 'Test Workspace', status: 'ACTIVE' });
    userRepo.findById.mockResolvedValue({ id: 'user-2', displayName: 'Bob', email: 'bob@example.com' });
    userRepo.findByEmail.mockResolvedValue(null);
    userRepo.create.mockResolvedValue({ id: 'user-2', email: 'invitee@example.com' });
  });

  /** The requester is an ACTIVE OWNER; the second lookup answers for the target. */
  function requesterIsOwner(target: Record<string, unknown>) {
    memberRepo.findByUserAndTenant
      .mockResolvedValueOnce(makeMember({ id: 'm-owner', userId: 'user-1', role: 'OWNER' }))
      .mockResolvedValue(makeMember({ id: 'm-target', userId: 'user-2', role: 'MEMBER', ...target }));
  }

  // from → to, and the method that performs it. `run` drives the service; the
  // expectation (one event, with an actor) is the same for every row.
  const TRANSITIONS: {
    from: string;
    to: string;
    run: () => Promise<void>;
    expectAction: 'CREATED' | 'UPDATED' | 'DELETED';
  }[] = [
    {
      from: 'absent',
      to: 'ACCESS_REVOKED + invitation PENDING',
      expectAction: 'CREATED',
      run: async () => {
        memberRepo.findByUserAndTenant.mockResolvedValueOnce(makeMember()).mockResolvedValueOnce(null);
        memberRepo.create.mockResolvedValue(
          makeMember({ id: 'm-new', userId: 'user-2', status: MemberStatus.ACCESS_REVOKED }),
        );
        await service.inviteUser('user-1', 'tenant-1', `invitee-${crypto.randomUUID()}@example.com`, 'MEMBER');
      },
    },
    {
      from: 'ACCESS_REVOKED + invitation PENDING',
      to: 'ACTIVE',
      expectAction: 'UPDATED',
      run: async () => {
        memberRepo.findById.mockResolvedValue(
          makeMember({
            id: 'm-2',
            userId: 'user-2',
            status: MemberStatus.ACCESS_REVOKED,
            invitation: makePendingInvitation({ invitedOn: new Date().toISOString() }),
          }),
        );
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-2', userId: 'user-2' }));
        await service.acceptInvitation('m-2', 'user-2');
      },
    },
    {
      from: 'ACTIVE + MEMBER',
      to: 'ACTIVE + ADMIN (role changed)',
      expectAction: 'UPDATED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACTIVE });
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-target', userId: 'user-2', role: 'ADMIN' }));
        await service.updateMemberRole('user-1', 'tenant-1', 'user-2', 'ADMIN');
      },
    },
    {
      from: 'ACTIVE',
      to: 'ACCESS_REVOKED (access revoked, row kept)',
      expectAction: 'UPDATED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACTIVE });
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-target', userId: 'user-2' }));
        await service.revokeAccess('user-1', 'tenant-1', 'user-2');
      },
    },
    {
      from: 'ACCESS_REVOKED',
      to: 'ACTIVE (restored)',
      expectAction: 'UPDATED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACCESS_REVOKED, invitation: null });
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-target', userId: 'user-2' }));
        await service.restoreMembership('user-1', 'tenant-1', 'user-2');
      },
    },
    {
      from: 'ACTIVE (expired past expiresAt)',
      to: 'ACCESS_REVOKED (lazy DEC-055 expiry, observed)',
      expectAction: 'UPDATED',
      run: async () => {
        // The requester is an ACTIVE owner; the LISTED member is the expired one.
        memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ id: 'm-owner', userId: 'user-1' }));
        memberRepo.findByTenantWithUsers.mockResolvedValue([
          makeMember({
            id: 'm-2',
            userId: 'user-2',
            status: MemberStatus.ACTIVE,
            expiresAt: '2020-01-01T00:00:00.000Z',
          }),
        ]);
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-2', userId: 'user-2' }));
        // ONE observation: the row stops being ACTIVE after the first flip, so a
        // second read must not write a second event.
        await service.getTenantMembers('user-1', 'tenant-1');
      },
    },
    {
      from: 'ACTIVE',
      to: 'deleted (membership removed)',
      expectAction: 'DELETED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACTIVE });
        await service.removeMember('user-1', 'tenant-1', 'user-2');
      },
    },
    {
      from: 'ACTIVE',
      to: 'deleted (membership hard-deleted)',
      expectAction: 'DELETED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACTIVE });
        await service.hardDeleteMember('user-1', 'tenant-1', 'user-2');
      },
    },
    {
      from: 'invitation PENDING',
      to: 'invitation REVOKED',
      expectAction: 'UPDATED',
      run: async () => {
        requesterIsOwner({ status: MemberStatus.ACCESS_REVOKED, invitation: makePendingInvitation() });
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-target', userId: 'user-2' }));
        await service.revokeInvitation('user-1', 'tenant-1', 'user-2');
      },
    },
    {
      from: 'invitation PENDING',
      to: 'invitation DECLINED',
      expectAction: 'UPDATED',
      run: async () => {
        memberRepo.findById.mockResolvedValue(
          makeMember({
            id: 'm-2',
            userId: 'user-2',
            status: MemberStatus.ACCESS_REVOKED,
            invitation: makePendingInvitation(),
          }),
        );
        memberRepo.update.mockResolvedValue(makeMember({ id: 'm-2', userId: 'user-2' }));
        await service.declineInvitation('m-2', 'user-2');
      },
    },
  ];

  for (const transition of TRANSITIONS) {
    it(`${transition.from} → ${transition.to} writes exactly one event with an actor`, async () => {
      await transition.run();

      const written = membershipEvents();

      expect(written, `${transition.from} → ${transition.to} wrote no MEMBERSHIP event`).toHaveLength(1);
      expect(written[0]).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: null,
          entityType: 'MEMBERSHIP',
          action: transition.expectAction,
        }),
      );
      // An event with no actor is the gap this dependency closes.
      expect(written[0]?.actorId).toBeTruthy();
      expect(typeof written[0]?.actorId).toBe('string');
    });
  }

  it('the event names the MEMBERSHIP the enrichment service can resolve, not the user', async () => {
    memberRepo.findById.mockResolvedValue(
      makeMember({
        id: 'm-2',
        userId: 'user-2',
        status: MemberStatus.ACCESS_REVOKED,
        invitation: makePendingInvitation({ invitedOn: new Date().toISOString() }),
      }),
    );
    memberRepo.update.mockResolvedValue(makeMember({ id: 'm-2', userId: 'user-2' }));
    await service.acceptInvitation('m-2', 'user-2');

    // `AuditEnrichmentService` resolves a MEMBERSHIP entityId through
    // `tenantMembers.findByIds`, so a user id here would always render "Unknown".
    expect(membershipEvents()[0]?.entityId).toBe('m-2');
  });

  it('a REJECTED transition writes nothing (a failed guard is not an event)', async () => {
    // A non-admin cannot remove anyone: the request is refused before any write.
    memberRepo.findByUserAndTenant.mockResolvedValue(makeMember({ role: 'MEMBER' }));

    await expect(service.removeMember('user-2', 'tenant-1', 'user-3')).rejects.toThrow();
    expect(auditService.log).not.toHaveBeenCalled();
    expect(memberRepo.delete).not.toHaveBeenCalled();
  });
});
