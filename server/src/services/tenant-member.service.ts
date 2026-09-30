import { randomUUID, createHash } from 'node:crypto';
import { MemberStatus, TenantRole, TenantStatus, InvitationStatus, INVITATION_TTL_MS } from '@task-board/shared';
import type { Tenant, TenantMember, MyInvitation } from '@task-board/shared';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { buildRateLimitHeaders, createRateLimiter } from '../utils/rate-limiter.js';
import { logger } from '../utils/logger.js';
import { MyInvitationSchema } from '../schemas/tenant.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { TenantMemberRepository } from '../repositories/tenant-member.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import type { InvitationDocument } from '../repositories/tenant-member.repository.js';
import type { EmailService } from './email.service.js';
import type { AuditService } from './audit.service.js';
import { isTenantAdmin } from './rbac.service.js';

/** Structural type that both EmailService and ConsoleEmailService satisfy */
type EmailSender = Pick<EmailService, 'sendInvitationEmail'>;

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Invitation e-mail cooldown — ONE invitation e-mail per
 * (workspace, invitee address) per {@link INVITE_COOLDOWN_MS}.
 *
 * Every invitation triggers an OUTBOUND e-mail. Without a cooldown an owner (or
 * an authenticated attacker holding a stolen token) can hammer "invite" against a
 * single address and turn the workspace into a mail cannon for a third party;
 * with a per-address cooldown the blast radius is bounded to one message per
 * address per minute, no matter how fast the requests arrive.
 *
 * 60 s is chosen to be invisible to a human inviting a team (a person inviting
 * twenty people clicks once per person, seconds apart) while capping a flood at
 * one message per address per minute. A different address is a different key, so
 * a legitimate bulk onboarding of 20 distinct people is unaffected.
 */
const INVITE_COOLDOWN_MS = 60 * 1000;
/**
 * Per-user invitation budget — {@link INVITE_MAX_PER_USER} outbound
 * invitation e-mails per requester per {@link INVITE_USER_WINDOW_MS}.
 *
 * The per-(workspace, address) cooldown above only bounds a SINGLE address; a
 * spray across many addresses would still produce unbounded mail. This is the
 * outbound-mail ceiling for one authenticated user. 20/hour comfortably covers a
 * real onboarding (an admin inviting a whole department in one sitting) and
 * bounds a compromised account to 20 messages an hour instead of thousands.
 */
const INVITE_MAX_PER_USER = 20;
const INVITE_USER_WINDOW_MS = 60 * 60 * 1000;
// Module-level: the budget must survive across requests (see utils/rate-limiter.ts).
const inviteCooldown = createRateLimiter(1, INVITE_COOLDOWN_MS);
const inviteUserBudget = createRateLimiter(INVITE_MAX_PER_USER, INVITE_USER_WINDOW_MS);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A membership whose `expiresAt` is on/after now is treated as
 * ACCESS_REVOKED (lazy evaluation — no cron; the status flips when observed).
 */
export function isMembershipExpired(member: { expiresAt: string | null }): boolean {
  return member.expiresAt !== null && new Date(member.expiresAt).getTime() <= Date.now();
}

/** Minimal repository surface the last-OWNER invariant needs. */
export interface LastOwnerMembershipRepo {
  findByTenant(tenantId: string): Promise<TenantMember[]>;
}

/**
 * A tenant must always keep at least one ACTIVE OWNER — otherwise it
 * is permanently unmanageable, and the restore path explicitly refuses the
 * resulting state.
 *
 * Exported (not just a private method) so that EVERY path which can remove an
 * owner's membership applies the SAME rule: the self-service lifecycle
 * operations in {@link TenantMemberService} AND the cross-tenant
 * `TenantService.deleteUser` sweep, which deletes ALL of a user's memberships
 * at once and could otherwise strip the last owner of a tenant the caller was
 * merely an ADMIN of.
 *
 * "Active" follows the DEC-055 lazy-expiry rule: a membership past its
 * `expiresAt` is treated as ACCESS_REVOKED, so an expired owner does not count
 * as a remaining owner.
 *
 * 409 CONFLICT is the code the domain already uses for state conflicts
 * (e.g. "Only ACCESS_REVOKED memberships can be restored"). The `message` is
 * parameterised because the callers name the thing the user must act on
 * (a membership vs. a whole user account).
 */
export async function assertNotLastOwner(
  repo: LastOwnerMembershipRepo,
  tenantId: string,
  target: TenantMember,
  message = 'This is the last active owner of the workspace — promote another owner before changing this membership',
): Promise<void> {
  const members = await repo.findByTenant(tenantId);
  const anotherActiveOwner = members.some(
    (m) =>
      m.id !== target.id && m.role === TenantRole.OWNER && m.status === MemberStatus.ACTIVE && !isMembershipExpired(m),
  );

  if (!anotherActiveOwner) {
    throw new ConflictError(message);
  }
}

// ─── Tenant Member Service ───────────────────────────────────────────────────

/**
 * Member management and invitation lifecycle for a tenant.
 * Split from {@link TenantService} so each file has a single responsibility.
 */
export class TenantMemberService {
  /**
   * Every parameter is REQUIRED (the same rule `TenantService` follows).
   *
   * `auditService` was absent entirely, which is why the dataset whose purpose is
   * "who may see what" carried no actor record for any of its transitions
   * Optional-and-guarded would have reproduced that: a required
   * dependency that the container forgets is a compile error, a conditional one
   * is silence.
   */
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly tenantMemberRepo: TenantMemberRepository,
    private readonly userRepo: UserRepository,
    private readonly emailService: EmailSender,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Write the audit event for ONE membership transition.
   *
   * The membership IS the audited entity, and its `id` is what
   * `AuditEnrichmentService` resolves to a person's display name — so the id
   * passed here must be the membership id, never the user id, except where the
   * row is addressed by user (an invite for an address with no membership yet).
   */
  private async auditMembership(
    tenantId: string,
    entityId: string,
    action: 'CREATED' | 'UPDATED' | 'DELETED',
    actorId: string,
    changes: { field: string; oldValue: unknown; newValue: unknown }[] = [],
  ): Promise<void> {
    await this.auditService.log({
      tenantId,
      projectId: null,
      entityType: 'MEMBERSHIP',
      entityId,
      action,
      actorId,
      changes,
    });
  }

  // ─── Member Management ─────────────────────────────────────────────────────

  async getTenantMembers(
    requesterId: string,
    tenantId: string,
    precheckedMembership?: TenantMember,
  ): Promise<TenantMember[]> {
    // IDOR guard: only tenant members may list the tenant's members
    await this.requireMembership(requesterId, tenantId, precheckedMembership);

    // One round-trip: members with their user profiles joined server-side
    // ($lookup, soft-deleted users excluded) — replaces the previous
    // findByTenant → users.$in two-step enrichment.
    const members = await this.tenantMemberRepo.findByTenantWithUsers(tenantId);
    const effectiveMembers: (TenantMember & { userEmail: string | null; userDisplayName: string | null })[] = [];

    for (const member of members) {
      // DEC-055 lazy revoke: an ACTIVE membership past its expiration is
      // flipped to ACCESS_REVOKED when observed (no cron on Workers).
      let effective = member;

      if (member.status === MemberStatus.ACTIVE && isMembershipExpired(member)) {
        const flipped = await this.tenantMemberRepo.update(member.id, { status: MemberStatus.ACCESS_REVOKED });

        if (flipped) effective = { ...flipped, userEmail: member.userEmail, userDisplayName: member.userDisplayName };

        // DEC-055 expires a membership lazily, when it is observed, and
        // there is no cron on Workers. Without this event the expiry leaves no
        // trace at all until somebody reads the list. The actor is the member
        // whose own access lapsed — nothing else acts here, and an event with no
        // actor is exactly the gap this closes.
        await this.auditMembership(member.tenantId, member.id, 'UPDATED', member.userId, [
          { field: 'status', oldValue: MemberStatus.ACTIVE, newValue: MemberStatus.ACCESS_REVOKED },
          { field: 'reason', oldValue: null, newValue: 'expired' },
        ]);
      }

      effectiveMembers.push(effective);
    }

    return effectiveMembers.map((effective) => ({
      ...effective,
      displayName: effective.userId ? (effective.userDisplayName ?? null) : null,
      email: effective.userId ? (effective.userEmail ?? null) : null,
    }));
  }

  async inviteUser(
    requesterId: string,
    tenantId: string,
    email: string,
    role: string,
    precheckedMembership?: TenantMember,
  ): Promise<TenantMember> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    // Every `Only owner or admin can …` guard below answers the RBAC
    // matrix's `manage_tenant` row (see `isTenantAdmin`) while keeping its own
    // domain message — eleven routes and their tests assert that text.
    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can invite members');
    }

    const tenant = await this.requireActiveTenant(tenantId);
    // Check if user is already an active member
    const existingUser = await this.userRepo.findByEmail(email);

    if (existingUser) {
      const existingMember = await this.tenantMemberRepo.findByUserAndTenant(existingUser.id, tenantId);

      if (existingMember && existingMember.status === MemberStatus.ACTIVE && !existingMember.invitation) {
        throw new ConflictError('User is already a member of this tenant');
      }
    }

    // Both invitation-e-mail limits are checked AFTER the authorization and
    // conflict guards, so a 403/409 never consumes an invite budget, and BEFORE
    // any mail is sent.
    this.assertInvitationAllowed(requesterId, tenantId, email);

    // Generate invitation token and hash
    const token = randomUUID();
    const tokenHash = hashToken(token);
    const invitationDoc: InvitationDocument = {
      status: InvitationStatus.PENDING,
      tokenHash,
      invitedBy: requesterId,
      invitedOn: new Date(),
      invitedEmail: email.toLowerCase().trim(),
    };
    // If user doesn't exist, create a placeholder user
    let userId = existingUser?.id;

    if (!userId) {
      const placeholderUser = await this.userRepo.create({
        email,
        displayName: email.split('@')[0] ?? email,
        passwordHash: '', // no password yet
      });

      userId = placeholderUser.id;
    }

    // Check for existing pending invitation — replace it instead of throwing
    const existingMember = await this.tenantMemberRepo.findByUserAndTenant(userId, tenantId);

    if (existingMember && existingMember.invitation?.status === InvitationStatus.PENDING) {
      // Replace existing invitation with new token — membership stays ACCESS_REVOKED until accepted
      const replacementDoc: InvitationDocument = {
        status: InvitationStatus.PENDING,
        tokenHash,
        invitedBy: requesterId,
        invitedOn: new Date(),
        invitedEmail: email.toLowerCase().trim(),
      };

      await this.auditMembership(tenantId, existingMember.id, 'UPDATED', requesterId, [
        { field: 'role', oldValue: existingMember.role, newValue: role },
        { field: 'invitation', oldValue: InvitationStatus.PENDING, newValue: InvitationStatus.PENDING },
      ]);
      await this.tenantMemberRepo.update(existingMember.id, {
        role,
        invitation: replacementDoc,
      });

      // Send new invitation email
      try {
        const inviter = await this.userRepo.findById(requesterId);

        await this.emailService.sendInvitationEmail({
          to: email,
          inviterName: inviter?.displayName ?? 'A team member',
          tenantName: tenant.name,
          role,
          token,
        });
      } catch (err) {
        // Invitation mail is BEST-EFFORT (the membership is already
        // persisted, so failing the request would leave a member nobody can
        // reach). That only stays correct while the failure is REPORTED, and
        // `EmailService` now throws `EmailDeliveryError` when the provider
        // resolves `{ error }` — the case the SDK used to hide. This catch is
        // therefore reachable for a refused send and not only for a network
        // fault, and a structured line is what an operator reads when nobody
        // got the mail.
        logger.error('Failed to send re-invitation email', { err });
      }

      return {
        ...existingMember,
        role,
        invitation: { ...replacementDoc, invitedOn: replacementDoc.invitedOn.toISOString() },
      } as unknown as TenantMember;
    }

    // An invited membership persists as ACCESS_REVOKED + invitation PENDING;
    // only explicit acceptance flips it to ACTIVE.
    // The "already a member" check above is racy; the unique
    // `{tenantId,userId}` index rejects a concurrent loser, which is the same
    // domain conflict rather than a 500.
    const member = await withConflictOnDuplicate(
      () =>
        this.tenantMemberRepo.create({
          userId,
          tenantId,
          role,
          status: MemberStatus.ACCESS_REVOKED,
          invitation: invitationDoc,
        }),
      () => new ConflictError('User is already a member of this tenant'),
    );

    // An invitation IS a membership transition — the row exists, with
    // ACCESS_REVOKED status, from the moment it is created.
    await this.auditMembership(tenantId, member.id, 'CREATED', requesterId, [
      { field: 'role', oldValue: null, newValue: role },
      { field: 'status', oldValue: null, newValue: MemberStatus.ACCESS_REVOKED },
    ]);

    // Send invitation email (fire and forget)
    try {
      const inviter = await this.userRepo.findById(requesterId);

      await this.emailService.sendInvitationEmail({
        to: email,
        inviterName: inviter?.displayName ?? 'A team member',
        tenantName: tenant.name,
        role,
        token, // plaintext token sent in email
      });
    } catch (err) {
      logger.error('Failed to send invitation email', { err });
    }

    return member;
  }

  async updateMemberRole(requesterId: string, tenantId: string, userId: string, role: string): Promise<TenantMember> {
    return this.updateMember(requesterId, tenantId, userId, { role });
  }

  /**
   * Full member update — role, expiration date and the underlying
   * user's profile (display name / email). Only provided fields are applied.
   * Setting an expiration on (or changing the role of) the workspace OWNER is
   * forbidden. Returns the enriched member so callers can refresh their rows.
   */
  async updateMember(
    requesterId: string,
    tenantId: string,
    userId: string,
    // The PATCH body is validated but fully optional, so omitted fields
    // arrive as explicit `undefined`s — "only provided fields are applied".
    patch: {
      role?: string | undefined;
      expiresAt?: string | null | undefined;
      name?: string | undefined;
      email?: string | undefined;
    },
  ): Promise<TenantMember> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can update members');
    }

    const target = await this.requireMembershipByUserId(userId, tenantId);

    if (target.role === TenantRole.OWNER) {
      // An OWNER demoting THEMSELVES when they are the last owner leaves
      // the tenant permanently unmanageable — nobody is left who can promote
      // anyone back, and the restore path cannot fix a tenant with no owner.
      // Scoped to the SELF case: a third party changing an owner's role keeps
      // hitting the pre-existing blanket 403 below, unchanged.
      if (patch.role !== undefined && patch.role !== target.role && requesterId === userId) {
        await this.assertNotLastOwner(tenantId, target);
      }

      if (patch.expiresAt !== undefined) {
        throw new ForbiddenError('Cannot set an expiration date on the workspace owner');
      }

      if (patch.role !== undefined && patch.role !== target.role) {
        throw new ForbiddenError("Cannot change the owner's role");
      }
    }

    // Profile updates go to the underlying USER record
    if (patch.name !== undefined || patch.email !== undefined) {
      const user = await this.userRepo.findById(target.userId);

      if (!user) {
        throw new NotFoundError('User not found');
      }

      if (patch.email !== undefined && patch.email !== user.email) {
        const existing = await this.userRepo.findByEmail(patch.email);

        if (existing && existing.id !== user.id) {
          throw new ConflictError('A user with this email already exists');
        }
      }

      await this.userRepo.updateProfile(user.id, {
        ...(patch.name !== undefined ? { displayName: patch.name } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
      });
    }

    const memberPatch: { role?: string; expiresAt?: Date | null } = {};

    if (patch.role !== undefined) memberPatch.role = patch.role;
    if (patch.expiresAt !== undefined)
      memberPatch.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt);

    let updated = target;

    if (Object.keys(memberPatch).length > 0) {
      updated = (await this.tenantMemberRepo.update(target.id, memberPatch)) ?? target;
    }

    // A role or expiration change is a membership transition. Only the
    // fields that actually changed are recorded, so the event is the difference
    // and not a copy of the row.
    const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];

    if (updated.role !== target.role) {
      changes.push({ field: 'role', oldValue: target.role, newValue: updated.role });
    }

    // `TenantMember.expiresAt` is an ISO string (not a Date), so the comparison
    // is between two strings and the event carries what the row holds.
    if ((updated.expiresAt ?? null) !== (target.expiresAt ?? null)) {
      changes.push({ field: 'expiresAt', oldValue: target.expiresAt, newValue: updated.expiresAt });
    }

    if (changes.length > 0) {
      await this.auditMembership(tenantId, target.id, 'UPDATED', requesterId, changes);
    }

    // Return the enriched member (fresh profile after possible name/email change)
    const freshUser = await this.userRepo.findById(updated.userId);

    return { ...updated, displayName: freshUser?.displayName ?? null, email: freshUser?.email ?? null };
  }

  async removeMember(
    requesterId: string,
    tenantId: string,
    userId: string,
    precheckedMembership?: TenantMember,
  ): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can remove members');
    }

    const targetMembership = await this.requireMembership(userId, tenantId);

    if (targetMembership.role === TenantRole.OWNER) {
      // Self-removal by the last OWNER bricks the tenant. Checked first
      // so the 409 names the real problem. Scoped to the SELF case — see
      // updateMember for why.
      if (requesterId === userId) {
        await this.assertNotLastOwner(tenantId, targetMembership);
      }
      throw new ForbiddenError('Cannot remove the owner from the tenant');
    }

    await this.auditMembership(tenantId, targetMembership.id, 'DELETED', requesterId, [
      { field: 'role', oldValue: targetMembership.role, newValue: null },
    ]);
    await this.tenantMemberRepo.delete(tenantId, userId);
  }

  // ─── Invitation Lifecycle ──────────────────────────────────────────────────

  async acceptInvitation(memberId: string, userId: string): Promise<void> {
    const member = await this.tenantMemberRepo.findById(memberId);

    if (!member) {
      throw new NotFoundError('Invitation not found');
    }

    if (!member.invitation || member.invitation.status !== InvitationStatus.PENDING) {
      throw new NotFoundError('Invitation is no longer pending');
    }

    // IDOR guard, mirroring `declineInvitation`: only the invitee may accept
    if (member.userId !== userId) {
      throw new ForbiddenError('You can only accept your own invitations');
    }

    // Check TTL expiration — membership stays ACCESS_REVOKED; only the invitation flips to EXPIRED
    const invitedOn = new Date(member.invitation.invitedOn).getTime();

    if (Date.now() - invitedOn > INVITATION_TTL_MS) {
      await this.tenantMemberRepo.update(memberId, {
        invitation: { ...member.invitation, status: InvitationStatus.EXPIRED },
      });
      throw new AppError(410, 'INVITATION_EXPIRED', 'Invitation has expired');
    }

    await this.auditMembership(member.tenantId, member.id, 'UPDATED', userId, [
      { field: 'status', oldValue: MemberStatus.ACCESS_REVOKED, newValue: MemberStatus.ACTIVE },
    ]);
    await this.tenantMemberRepo.update(memberId, {
      invitation: null,
      status: MemberStatus.ACTIVE,
      expiresAt: null, // DEC-055: a fresh acceptance never starts expired
    });
  }

  async declineInvitation(memberId: string, userId: string): Promise<void> {
    const member = await this.tenantMemberRepo.findById(memberId);

    if (!member) {
      throw new NotFoundError('Invitation not found');
    }

    if (!member.invitation || member.invitation.status !== InvitationStatus.PENDING) {
      throw new ConflictError('Invitation is no longer pending');
    }

    if (member.userId !== userId) {
      throw new ForbiddenError('You can only decline your own invitations');
    }

    await this.auditMembership(member.tenantId, member.id, 'UPDATED', userId, [
      { field: 'invitation', oldValue: InvitationStatus.PENDING, newValue: InvitationStatus.DECLINED },
    ]);
    await this.tenantMemberRepo.update(memberId, {
      invitation: { ...member.invitation, status: InvitationStatus.DECLINED },
    });
  }

  /**
   * An owner must not be able to remove, revoke or demote THEMSELVES
   * when they are the last ACTIVE owner.
   *
   * Deliberately scoped to the SELF case only. A third party acting on an
   * owner's membership keeps hitting the pre-existing blanket 403s, unchanged
   * (see `updateMemberRole when trying to change the owner role` in
   * tenant.service.test.ts). So this guard can only ever turn an opaque 403
   * into a precise 409 — it never widens what is permitted.
   *
   * The rule itself lives in the module-level {@link assertNotLastOwner}, shared
   * with `TenantService.deleteUser`.
   */
  private async assertNotLastOwner(tenantId: string, target: TenantMember): Promise<void> {
    await assertNotLastOwner(this.tenantMemberRepo, tenantId, target);
  }

  private async requireMembershipByUserId(userId: string, tenantId: string): Promise<TenantMember> {
    const member = await this.tenantMemberRepo.findByUserAndTenant(userId, tenantId);

    if (!member) {
      throw new NotFoundError('Member not found in this tenant');
    }

    return member;
  }

  async revokeInvitation(requesterId: string, tenantId: string, userId: string): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can revoke invitations');
    }

    const member = await this.requireMembershipByUserId(userId, tenantId);

    if (!member.invitation || member.invitation.status !== InvitationStatus.PENDING) {
      throw new ConflictError('Invitation is no longer pending');
    }

    await this.auditMembership(tenantId, member.id, 'UPDATED', requesterId, [
      { field: 'invitation', oldValue: InvitationStatus.PENDING, newValue: InvitationStatus.REVOKED },
    ]);
    await this.tenantMemberRepo.update(member.id, {
      invitation: {
        ...member.invitation,
        status: InvitationStatus.REVOKED,
        invitedOn: new Date(member.invitation.invitedOn),
      },
    });
  }

  async reinviteUser(
    requesterId: string,
    tenantId: string,
    userId: string,
    precheckedMembership?: TenantMember,
  ): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can reinvite users');
    }

    const member = await this.requireMembershipByUserId(userId, tenantId);

    // A re-invite re-sends the invitation e-mail, so it draws from the same
    // per-(workspace, address) cooldown and the same per-user budget.
    this.assertInvitationAllowed(requesterId, tenantId, member.userId);

    // Generate new token
    const token = randomUUID();
    const tokenHash = hashToken(token);
    const user = await this.userRepo.findById(member.userId);
    const invitationDoc: InvitationDocument = {
      status: InvitationStatus.PENDING,
      tokenHash,
      invitedBy: requesterId,
      invitedOn: new Date(),
      invitedEmail: user?.email.toLowerCase().trim() ?? null,
    };

    // DEC-018 invariant: a membership with a PENDING invitation is never ACTIVE
    await this.auditMembership(tenantId, member.id, 'UPDATED', requesterId, [
      { field: 'invitation', oldValue: member.invitation?.status ?? null, newValue: InvitationStatus.PENDING },
    ]);
    await this.tenantMemberRepo.update(member.id, { status: MemberStatus.ACCESS_REVOKED, invitation: invitationDoc });

    // Send email
    try {
      const freshUser = await this.userRepo.findById(member.userId);
      const tenant = await this.requireActiveTenant(tenantId);
      const inviter = await this.userRepo.findById(requesterId);

      if (freshUser) {
        await this.emailService.sendInvitationEmail({
          to: freshUser.email,
          inviterName: inviter?.displayName ?? 'A team member',
          tenantName: tenant.name,
          role: member.role,
          token,
        });
      }
    } catch (err) {
      console.error('Failed to send reinvitation email:', err);
    }
  }

  async restoreMembership(
    requesterId: string,
    tenantId: string,
    userId: string,
    precheckedMembership?: TenantMember,
  ): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can restore memberships');
    }

    const member = await this.requireMembershipByUserId(userId, tenantId);

    // An ACTIVE membership past its expiration is effectively revoked too
    if (member.status !== MemberStatus.ACCESS_REVOKED && !isMembershipExpired(member)) {
      throw new ConflictError('Only ACCESS_REVOKED memberships can be restored');
    }

    // A pending invitation can only be activated by the invitee's explicit acceptance
    if (member.invitation?.status === InvitationStatus.PENDING) {
      throw new ConflictError('Cannot restore a membership with a pending invitation — the invitee must accept it');
    }

    // Restoring clears the expiration — access is regained with all
    // projects/roles intact (nothing was ever removed).
    await this.auditMembership(tenantId, member.id, 'UPDATED', requesterId, [
      { field: 'status', oldValue: member.status, newValue: MemberStatus.ACTIVE },
      { field: 'expiresAt', oldValue: member.expiresAt, newValue: null },
    ]);
    await this.tenantMemberRepo.update(member.id, { status: MemberStatus.ACTIVE, expiresAt: null });
  }

  async revokeAccess(
    requesterId: string,
    tenantId: string,
    userId: string,
    precheckedMembership?: TenantMember,
  ): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can revoke access');
    }

    const membership = await this.requireMembershipByUserId(userId, tenantId);

    if (membership.role === TenantRole.OWNER) {
      // See removeMember — checked first so the self-revoke of the last
      // OWNER is a precise 409 rather than an opaque 403.
      if (requesterId === userId) {
        await this.assertNotLastOwner(tenantId, membership);
      }
      throw new ForbiddenError("Cannot revoke the owner's access");
    }

    await this.auditMembership(tenantId, membership.id, 'UPDATED', requesterId, [
      { field: 'status', oldValue: membership.status, newValue: MemberStatus.ACCESS_REVOKED },
    ]);
    await this.tenantMemberRepo.update(membership.id, { status: MemberStatus.ACCESS_REVOKED });
  }

  async hardDeleteMember(
    requesterId: string,
    tenantId: string,
    userId: string,
    precheckedMembership?: TenantMember,
  ): Promise<void> {
    const requesterMembership = await this.requireMembership(requesterId, tenantId, precheckedMembership);

    if (!isTenantAdmin(requesterMembership.role)) {
      throw new ForbiddenError('Only owner or admin can permanently remove members');
    }

    const membership = await this.requireMembershipByUserId(userId, tenantId);

    if (membership.role === TenantRole.OWNER) {
      // See removeMember — checked first so the self-revoke of the last
      // OWNER is a precise 409 rather than an opaque 403.
      if (requesterId === userId) {
        await this.assertNotLastOwner(tenantId, membership);
      }
      throw new ForbiddenError('Cannot permanently remove the owner');
    }

    await this.auditMembership(tenantId, membership.id, 'DELETED', requesterId, [
      { field: 'role', oldValue: membership.role, newValue: null },
    ]);
    await this.tenantMemberRepo.deleteById(membership.id);
  }

  async getMyInvitations(email: string): Promise<MyInvitation[]> {
    const memberships = await this.tenantMemberRepo.findPendingByEmail(email);
    // Batch lookups (N+1 fix): one `$in` query per collection instead of
    // per-invitation user/tenant fetches
    const userIds = [...new Set(memberships.map((doc) => doc.userId).filter((id): id is string => Boolean(id)))];
    const tenantIds = [...new Set(memberships.map((doc) => doc.tenantId))];
    const [users, tenants] = await Promise.all([
      this.userRepo.findByIds(userIds),
      this.tenantRepo.findByIds(tenantIds),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const enriched: MyInvitation[] = [];

    for (const doc of memberships) {
      const user = doc.userId ? (userById.get(doc.userId) ?? null) : null;
      const tenant = tenantById.get(doc.tenantId);

      // MyInvitationSchema is the single source of truth: parsing the
      // raw document both validates the enum fields coming out of MongoDB and
      // yields the schema-inferred domain type — no casts needed.
      enriched.push(
        MyInvitationSchema.parse({
          tenantName: tenant?.name ?? '',
          id: doc.id,
          tenantId: doc.tenantId,
          userId: doc.userId,
          role: doc.role,
          status: doc.status,
          expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
          invitation: doc.invitation
            ? {
                status: doc.invitation.status,
                tokenHash: doc.invitation.tokenHash,
                invitedBy: doc.invitation.invitedBy,
                invitedOn: doc.invitation.invitedOn.toISOString(),
              }
            : null,
          displayName: user?.displayName ?? null,
          email: user?.email ?? null,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
        }),
      );
    }
    return enriched;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Consume one invitation slot, or throw 429.
   *
   * `target` is the invitee identity the per-(workspace, address) cooldown is
   * keyed on: an e-mail address for a fresh invite, a user id for a re-invite
   * (whose address is only known after the user document is read). Both are
   * normalized so `Bob@Example.com` and `bob@example.com` share one cooldown.
   *
   * Order: the per-user budget is probed FIRST so a user who exhausted their
   * hourly quota is told that, rather than being told to wait a minute for a
   * cooldown that would not help them anyway.
   */
  private assertInvitationAllowed(requesterId: string, tenantId: string, target: string): void {
    const normalizedTarget = target.toLowerCase().trim();
    const budget = inviteUserBudget(`user:${requesterId}`);

    if (budget.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Invitation limit reached. Try again later.',
        undefined,
        buildRateLimitHeaders(INVITE_MAX_PER_USER, budget),
      );
    }

    const cooldown = inviteCooldown(`invite:${tenantId}:${normalizedTarget}`);

    if (cooldown.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'An invitation was already sent to this address recently. Try again later.',
        undefined,
        buildRateLimitHeaders(1, cooldown),
      );
    }
  }

  private async requireActiveTenant(tenantId: string): Promise<Tenant> {
    const tenant = await this.tenantRepo.findById(tenantId);

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    if (tenant.status === TenantStatus.ARCHIVED) {
      throw new AppError(409, 'TENANT_ARCHIVED', 'Tenant is archived and cannot be modified');
    }
    return tenant;
  }

  /**
   * `precheckedMembership`: the membership already resolved by the
   * tenant-context middleware for THIS request (same user + tenant, ACTIVE,
   * not expired — the middleware enforces all of that). When provided and
   * matching, the repeated `findOne` is skipped.
   */
  private async requireMembership(
    userId: string,
    tenantId: string,
    precheckedMembership?: TenantMember,
  ): Promise<TenantMember> {
    if (precheckedMembership && precheckedMembership.userId === userId && precheckedMembership.tenantId === tenantId) {
      return precheckedMembership;
    }

    const membership = await this.tenantMemberRepo.findByUserAndTenant(userId, tenantId);

    if (!membership) {
      throw new ForbiddenError('You are not a member of this tenant');
    }

    // DEC-055 lazy revoke: an ACTIVE membership past its expiration denies
    // access; the stored status is flipped when observed (no cron on Workers).
    if (membership.status === MemberStatus.ACTIVE && isMembershipExpired(membership)) {
      await this.auditMembership(tenantId, membership.id, 'UPDATED', userId, [
        { field: 'status', oldValue: MemberStatus.ACTIVE, newValue: MemberStatus.ACCESS_REVOKED },
        { field: 'reason', oldValue: null, newValue: 'expired' },
      ]);
      await this.tenantMemberRepo.update(membership.id, { status: MemberStatus.ACCESS_REVOKED });
      throw new ForbiddenError('Your membership has expired');
    }

    if (membership.status !== MemberStatus.ACTIVE) {
      throw new ForbiddenError('You are not a member of this tenant');
    }
    return membership;
  }
}
