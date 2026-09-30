import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService, buildRateLimitHeaders } from './auth.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { AppError } from '../errors/app-error.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockUserRepo() {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findDocumentById: vi.fn(),
    setPasswordAndDisplayName: vi.fn(),
    findActiveByEmail: vi.fn(),
    findByPasswordResetToken: vi.fn(),
    setPasswordReset: vi.fn(),
    updatePasswordAndClearReset: vi.fn(),
    create: vi.fn(),
  };
}

function createMockMailer() {
  return {
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTenantRepo() {
  return {
    findById: vi.fn(),
    findByUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockTenantMemberRepo() {
  return {
    findByUserAndTenant: vi.fn(),
    findByTenant: vi.fn(),
    findByUser: vi.fn(),
    findByInvitationToken: vi.fn(),
    findPendingByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateRole: vi.fn(),
    delete: vi.fn(),
  };
}

const NOW = '2025-01-01T00:00:00.000Z';
const TEST_SECRET = 'test-jwt-secret-for-auth-service';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeUserDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    passwordHash: 'hashed-pw',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    deletedAt: null,
    ...overrides,
  };
}

function makeMemberDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'MEMBER',
    status: 'ACTIVE',
    invitation: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let service: AuthService;

  beforeEach(() => {
    userRepo = createMockUserRepo();
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    // 'durable' is the DEPLOYED mode and the one these ceilings are documented
    // for: one Durable Object instance, so the in-process counter is already a
    // deployment-wide one and the ceiling is exactly 10 / 30. The
    // multi-instance arithmetic is asserted in `rate-limit-scope.test.ts` and in
    // the "mode-aware ceiling" block at the end of this file.
    service = new AuthService(
      userRepo as never,
      tenantRepo as never,
      memberRepo as never,
      TEST_SECRET,
      null,
      undefined,
      'durable',
    );
  });

  // ── requestPasswordReset ────────────────────────────────────────────────

  describe('requestPasswordReset', () => {
    let mailer: ReturnType<typeof createMockMailer>;

    beforeEach(() => {
      mailer = createMockMailer();
      service = new AuthService(
        userRepo as never,
        tenantRepo as never,
        memberRepo as never,
        TEST_SECRET,
        mailer as never,
        'https://app.example.com',
        'durable',
      );
    });

    it('stores a hashed token and sends the reset email for an existing user', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc());
      userRepo.setPasswordReset.mockResolvedValue(undefined);

      const result = await service.requestPasswordReset({ email: 'user@example.com' }, '1.2.3.4');

      expect(userRepo.findActiveByEmail).toHaveBeenCalledWith('user@example.com');
      expect(userRepo.setPasswordReset).toHaveBeenCalledTimes(1);

      const [, tokenHash] = userRepo.setPasswordReset.mock.calls[0] ?? [];

      // SHA-256 hex digest of the raw token — 64 chars, never the raw token itself
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

      expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);

      const mailParams = mailer.sendPasswordResetEmail.mock.calls[0]?.[0] ?? {
        to: '',
        resetUrl: '',
        expiresInMinutes: 0,
      };

      expect(mailParams.to).toBe('test@example.com');
      expect(mailParams.resetUrl).toMatch(/^https:\/\/app\.example\.com\/auth\/reset-password\?token=[0-9a-f]{64}$/);
      expect(mailParams.expiresInMinutes).toBe(60);

      // Neutral response regardless of account existence
      expect(result.message).toContain('If an account exists');
    });

    it('normalizes the email before lookup', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(null);

      await service.requestPasswordReset({ email: '  USER@EXAMPLE.COM  ' });

      expect(userRepo.findActiveByEmail).toHaveBeenCalledWith('user@example.com');
    });

    it('responds neutrally without storing a token or sending email for unknown emails', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(null);

      const result = await service.requestPasswordReset({ email: 'ghost@example.com' });

      expect(userRepo.setPasswordReset).not.toHaveBeenCalled();
      expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
      expect(result.message).toContain('If an account exists');
    });

    it('never matches soft-deleted users', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(null);

      await service.requestPasswordReset({ email: 'deleted@example.com' });

      expect(userRepo.setPasswordReset).not.toHaveBeenCalled();
      expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    // The password-reset send is the ONE outbound call that is supposed
    // to fail hard. Before the fix it could not: `EmailService` awaited the SDK
    // and the SDK resolves `{ error }` for a refused message instead of
    // rejecting, so a user was told a reset link was on its way when it was
    // not, and the only trace was a 200 in an access log.
    it('D-27: a mail client that REFUSES the send is reported, not swallowed', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc());
      userRepo.setPasswordReset.mockResolvedValue(undefined);

      const refused = new Error('The from address is not verified');

      refused.name = 'EmailDeliveryError';
      mailer.sendPasswordResetEmail.mockRejectedValue(refused);

      await expect(service.requestPasswordReset({ email: 'user@example.com' })).rejects.toThrow(
        'The from address is not verified',
      );
      // The token is stored BEFORE the send, so a retry is still possible —
      // which is exactly why the caller must learn that this attempt failed.
      expect(userRepo.setPasswordReset).toHaveBeenCalledTimes(1);
    });

    it('D-27: the neutral message is still returned when the send succeeds', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc());
      userRepo.setPasswordReset.mockResolvedValue(undefined);

      await expect(service.requestPasswordReset({ email: 'user@example.com' })).resolves.toMatchObject({
        message: expect.stringContaining('password reset link has been sent'),
      });
    });

    it('still responds neutrally when rate-limited (no lookup, no email)', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc());

      // Exhaust the per-email+IP limit (5 requests / 15 min window)
      for (let i = 0; i < 5; i++) {
        await service.requestPasswordReset({ email: 'ratelimit@example.com' }, '9.9.9.9');
      }

      const callsBefore = userRepo.setPasswordReset.mock.calls.length;
      const mailsBefore = mailer.sendPasswordResetEmail.mock.calls.length;
      const result = await service.requestPasswordReset({ email: 'ratelimit@example.com' }, '9.9.9.9');

      expect(result.message).toContain('If an account exists');
      expect(userRepo.setPasswordReset.mock.calls.length).toBe(callsBefore);
      expect(mailer.sendPasswordResetEmail.mock.calls.length).toBe(mailsBefore);
    });
  });

  // ── resetPassword ───────────────────────────────────────────────────────

  describe('resetPassword', () => {
    function makeUserWithReset(requestedOnOffsetMs = 0) {
      return makeUserDoc({
        passwordReset: { tokenHash: 'a'.repeat(64), requestedOn: new Date(Date.now() + requestedOnOffsetMs) },
      });
    }

    it('hashes the new password, clears the token and returns success for a valid token', async () => {
      userRepo.findByPasswordResetToken.mockResolvedValue(makeUserWithReset());
      userRepo.updatePasswordAndClearReset.mockResolvedValue(undefined);

      const result = await service.resetPassword({ token: 'valid-token', newPassword: 'newSecurePass123' });

      expect(userRepo.findByPasswordResetToken).toHaveBeenCalledTimes(1);

      const [lookupHash] = userRepo.findByPasswordResetToken.mock.calls[0] ?? [];

      expect(lookupHash).toMatch(/^[0-9a-f]{64}$/); // token stored/looked up as SHA-256 hash

      expect(userRepo.updatePasswordAndClearReset).toHaveBeenCalledTimes(1);

      const [userId, passwordHash] = userRepo.updatePasswordAndClearReset.mock.calls[0] ?? [];

      expect(userId).toBe('user-1');
      expect(passwordHash).not.toBe('newSecurePass123');
      expect(passwordHash.length).toBeGreaterThan(10);

      expect(result.message).toContain('has been reset');
    });

    it('throws neutral INVALID_RESET_TOKEN error for unknown tokens', async () => {
      userRepo.findByPasswordResetToken.mockResolvedValue(null);

      await expect(service.resetPassword({ token: 'unknown', newPassword: 'newSecurePass123' })).rejects.toMatchObject({
        code: 'INVALID_RESET_TOKEN',
        statusCode: 400,
      });
      expect(userRepo.updatePasswordAndClearReset).not.toHaveBeenCalled();
    });

    it('throws neutral INVALID_RESET_TOKEN error for expired tokens (> 1 hour)', async () => {
      userRepo.findByPasswordResetToken.mockResolvedValue(
        makeUserWithReset(-(61 * 60 * 1000)), // requested 61 minutes ago
      );

      await expect(service.resetPassword({ token: 'expired', newPassword: 'newSecurePass123' })).rejects.toMatchObject({
        code: 'INVALID_RESET_TOKEN',
      });
      expect(userRepo.updatePasswordAndClearReset).not.toHaveBeenCalled();
    });

    it('accepts a token at the edge of the TTL window (< 1 hour)', async () => {
      userRepo.findByPasswordResetToken.mockResolvedValue(makeUserWithReset(-(30 * 60 * 1000)));
      userRepo.updatePasswordAndClearReset.mockResolvedValue(undefined);

      await expect(service.resetPassword({ token: 'fresh', newPassword: 'newSecurePass123' })).resolves.toMatchObject({
        message: expect.stringContaining('has been reset'),
      });
    });

    it('single-use: a used token no longer matches (token cleared on success)', async () => {
      userRepo.findByPasswordResetToken.mockResolvedValueOnce(makeUserWithReset());
      userRepo.updatePasswordAndClearReset.mockResolvedValue(undefined);

      await service.resetPassword({ token: 'used-token', newPassword: 'newSecurePass123' });

      // Second attempt: token was cleared → repository finds nothing
      userRepo.findByPasswordResetToken.mockResolvedValueOnce(null);

      await expect(service.resetPassword({ token: 'used-token', newPassword: 'anotherPass123' })).rejects.toMatchObject(
        {
          code: 'INVALID_RESET_TOKEN',
        },
      );
    });
  });

  // ── register ────────────────────────────────────────────────────────────

  describe('register', () => {
    it('creates user and returns token with null tenant when no pending invitations', async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.create.mockResolvedValue(makeUser({ email: 'new@example.com', displayName: 'New User' }));
      memberRepo.findPendingByEmail.mockResolvedValue([]);

      const result = await service.register({
        email: 'new@example.com',
        password: 'securepass123',
        displayName: 'New User',
      });

      expect(userRepo.findByEmail).toHaveBeenCalledWith('new@example.com');
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@example.com', displayName: 'New User' }),
      );

      const createCall = userRepo.create.mock.calls[0]?.[0];

      expect(createCall.passwordHash).not.toBe('securepass123');
      expect(createCall.passwordHash.length).toBeGreaterThan(10);

      expect(result.token).toBeDefined();
      expect(result.token.split('.')).toHaveLength(3);
      expect(result.user.email).toBe('new@example.com');
      expect(result.user.avatarUrl).toBeNull();
      expect(result.user.deletedAt).toBeNull();
    });

    it('normalizes email before registration', async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.create.mockResolvedValue(makeUser({ email: 'new@example.com' }));
      memberRepo.findPendingByEmail.mockResolvedValue([]);

      await service.register({ email: '  NEW@EXAMPLE.COM  ', password: 'securepass123', displayName: 'New User' });

      expect(userRepo.findByEmail).toHaveBeenCalledWith('new@example.com');
      expect(userRepo.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
    });

    it('activates pending invitations and sets tenantId in token', async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.create.mockResolvedValue(makeUser());
      memberRepo.findPendingByEmail.mockResolvedValue([
        makeMemberDoc({
          userId: null,
          invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
        }),
      ]);
      memberRepo.update.mockResolvedValue(makeMemberDoc());

      const result = await service.register({
        email: 'invited@example.com',
        password: 'securepass123',
        displayName: 'Invited User',
      });

      expect(memberRepo.findPendingByEmail).toHaveBeenCalledWith('invited@example.com');

      const parts = result.token.split('.');
      const payloadJson = atob((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(payloadJson);

      expect(payload.tenantId).toBe('tenant-1');
      expect(payload.tenantRole).toBe('MEMBER');
    });

    it('throws ConflictError when email is already taken', async () => {
      userRepo.findByEmail.mockResolvedValue({ id: 'existing', email: 'taken@example.com' });

      await expect(
        service.register({ email: 'taken@example.com', password: 'securepass123', displayName: 'Taken' }),
      ).rejects.toThrow('already exists');
    });
  });

  // ── login ───────────────────────────────────────────────────────────────

  describe('login', () => {
    it('returns token and user for valid credentials', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash('securepass123', 10);

      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc({ email: 'user@example.com', passwordHash: hash }));
      memberRepo.findByUser.mockResolvedValue([makeMemberDoc({ role: 'OWNER' })]);

      const result = await service.login({ email: 'user@example.com', password: 'securepass123' });

      expect(result.token).toBeDefined();
      expect(result.user.email).toBe('user@example.com');
      expect(result.user.displayName).toBe('Test User');
      expect(result.user.avatarUrl).toBeNull();
      expect(result.user.deletedAt).toBeNull();
    });

    it('normalizes email before login lookup', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash('securepass123', 10);

      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc({ passwordHash: hash }));
      memberRepo.findByUser.mockResolvedValue([]);

      await service.login({ email: '  USER@EXAMPLE.COM  ', password: 'securepass123' });

      expect(userRepo.findActiveByEmail).toHaveBeenCalledWith('user@example.com');
    });

    // V1-8: wrong credentials must carry the distinct INVALID_CREDENTIALS code
    // so the UI can show a neutral message instead of session-expired copy.
    it('throws INVALID_CREDENTIALS for unknown email', async () => {
      userRepo.findActiveByEmail.mockResolvedValue(null);

      await expect(service.login({ email: 'nope@example.com', password: 'x' })).rejects.toMatchObject({
        message: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });

    it('throws INVALID_CREDENTIALS for wrong password', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash('correctpass', 10);

      userRepo.findActiveByEmail.mockResolvedValue(makeUserDoc({ passwordHash: hash }));

      await expect(service.login({ email: 'user@example.com', password: 'wrongpass' })).rejects.toMatchObject({
        message: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });

    // ── A soft-deleted account must not authenticate ─────────────────────────
    //
    // This test wires the REAL `UserRepository` over an in-memory collection
    // instead of a mock, because the defect was never in a mock: it was the
    // `deletedAt` predicate. With a mocked repository the service is handed
    // whatever the test says, so "a soft-deleted user is refused" was
    // unassertable — the input no fixture constructed. The fake below answers
    // `findOne` by APPLYING the filter it is given, exactly as MongoDB does,
    // so the query the service builds is the thing under test.
    describe('D-12 — a soft-deleted account is refused', () => {
      /** An in-memory `users` collection: `findOne` applies the filter given. */
      function userCollectionOver(docs: Record<string, unknown>[]) {
        const findOne = vi.fn((filter: Record<string, unknown>) =>
          Promise.resolve(
            docs.find((doc) =>
              Object.entries(filter).every(([field, value]) => {
                const actual = field === 'email' ? String(doc[field]).toLowerCase() : doc[field];

                return actual === value;
              }),
            ) ?? null,
          ),
        );

        return {
          collection: { findOne } as never,
          findOne,
          docs,
        };
      }

      it('returns 401 for a soft-deleted user who still knows the password', async () => {
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('securepass123', 10);
        const fake = userCollectionOver([
          {
            ...makeUserDoc({ email: 'user@example.com', passwordHash: hash }),
            deletedAt: new Date('2025-06-01T00:00:00.000Z'),
          },
        ]);
        const realRepo = new UserRepository(fake.collection);
        const wired = new AuthService(
          realRepo,
          tenantRepo as never,
          memberRepo as never,
          TEST_SECRET,
          null,
          undefined,
          'durable',
        );

        await expect(wired.login({ email: 'user@example.com', password: 'securepass123' })).rejects.toMatchObject({
          code: 'INVALID_CREDENTIALS',
          statusCode: 401,
        });
        // …and the answer is byte-identical to an unknown email's, so the login
        // form is not an oracle for which addresses have accounts.
        await expect(wired.login({ email: 'ghost@example.com', password: 'x' })).rejects.toMatchObject({
          message: 'Invalid email or password',
        });
      });

      it('still authenticates the ACTIVE user with the same email in the same collection', async () => {
        // The absent-input path is only meaningful if the present one still
        // works: a "fix" that made every login fail would pass the test above.
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('securepass123', 10);
        const fake = userCollectionOver([
          {
            ...makeUserDoc({ email: 'user@example.com', passwordHash: hash }),
            id: 'user-deleted',
            deletedAt: new Date('2025-06-01T00:00:00.000Z'),
          },
          {
            ...makeUserDoc({ email: 'user@example.com', passwordHash: hash }),
            id: 'user-active',
            deletedAt: null,
          },
        ]);
        const realRepo = new UserRepository(fake.collection);
        const member = makeMemberDoc({ role: 'OWNER' });
        const activeMemberRepo = { findByUser: vi.fn().mockResolvedValue([member]) };
        const wired = new AuthService(
          realRepo,
          tenantRepo as never,
          activeMemberRepo as never,
          TEST_SECRET,
          null,
          undefined,
          'durable',
        );
        const result = await wired.login({ email: 'user@example.com', password: 'securepass123' });

        expect(result.token).toBeDefined();
        expect(result.user.deletedAt).toBeNull();
      });
    });
  });

  // ── me ──────────────────────────────────────────────────────────────────

  describe('me', () => {
    it('returns the user profile', async () => {
      userRepo.findById.mockResolvedValue(makeUser({ email: 'user@example.com' }));

      const result = await service.me('user-1');

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('user@example.com');
      expect(result.avatarUrl).toBeNull();
      expect(result.deletedAt).toBeNull();
    });

    it('throws NotFoundError when user does not exist', async () => {
      userRepo.findById.mockResolvedValue(null);

      await expect(service.me('missing')).rejects.toThrow('not found');
    });
  });

  // ── acceptInvitation ────────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    const pendingMember = () =>
      makeMemberDoc({
        status: 'ACCESS_REVOKED',
        invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
      });

    it('activates invitation for existing (registered) user', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(pendingMember());
      userRepo.findDocumentById.mockResolvedValue(
        makeUserDoc({ id: 'user-existing', email: 'existing@example.com', passwordHash: 'hashed-pw' }),
      );
      memberRepo.update.mockResolvedValue(makeMemberDoc({ invitation: null }));

      const result = await service.acceptInvitation({ token: 'token-abc' });

      expect(memberRepo.findByInvitationToken).toHaveBeenCalled();
      expect(memberRepo.update).toHaveBeenCalled();
      expect(result.user.id).toBe('user-existing');
      expect(result.token).toBeDefined();
      // Registered users must NOT get their password overwritten via a token
      expect(userRepo.setPasswordAndDisplayName).not.toHaveBeenCalled();
    });

    // ── V5-2: invitee without an account must set a password ──────────────

    it('rejects a placeholder invitee without password/displayName (no fake auto-login)', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(pendingMember());
      userRepo.findDocumentById.mockResolvedValue(makeUserDoc({ passwordHash: '' }));

      await expect(service.acceptInvitation({ token: 'token-abc' })).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(memberRepo.update).not.toHaveBeenCalled();
    });

    it('creates usable credentials for a placeholder invitee, activates membership, then login works', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(pendingMember());
      userRepo.findDocumentById.mockResolvedValue(
        makeUserDoc({ email: 'v5member@t.local', displayName: 'v5member', passwordHash: '' }),
      );
      memberRepo.update.mockResolvedValue(makeMemberDoc({ status: 'ACTIVE', invitation: null }));
      userRepo.setPasswordAndDisplayName.mockResolvedValue(undefined);

      const result = await service.acceptInvitation({
        token: 'token-abc',
        password: 'securepass123',
        displayName: 'V Five Member',
      });

      // Account created: real bcrypt hash + chosen display name persisted
      expect(userRepo.setPasswordAndDisplayName).toHaveBeenCalledTimes(1);

      const [, storedHash, storedName] = userRepo.setPasswordAndDisplayName.mock.calls[0] ?? [];
      const bcrypt = await import('bcryptjs');

      await expect(bcrypt.compare('securepass123', storedHash as string)).resolves.toBe(true);
      expect(storedName).toBe('V Five Member');

      // Membership ACTIVE
      expect(memberRepo.update).toHaveBeenCalledWith(
        'member-1',
        expect.objectContaining({ status: 'ACTIVE', invitation: null }),
      );
      expect(result.user.displayName).toBe('V Five Member');
      expect(result.token).toBeDefined();

      // …and the invitee can log in with that password afterwards. The login
      // path resolves through `findActiveByEmail`, so that is the stub
      // the assertion below actually exercises.
      userRepo.findActiveByEmail.mockResolvedValue(
        makeUserDoc({ email: 'v5member@t.local', displayName: 'V Five Member', passwordHash: storedHash }),
      );
      memberRepo.findByUser.mockResolvedValue([makeMemberDoc({ status: 'ACTIVE', invitation: null })]);

      const login = await service.login({ email: 'v5member@t.local', password: 'securepass123' });

      expect(login.user.email).toBe('v5member@t.local');
      expect(login.token).toBeDefined();
    });

    it('throws NotFoundError for invalid token', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(null);

      await expect(service.acceptInvitation({ token: 'invalid' })).rejects.toThrow('Invalid or expired invitation');
    });

    it('throws NotFoundError for non-pending invitation', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(
        makeMemberDoc({
          invitation: { status: 'REVOKED', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
        }),
      );

      await expect(service.acceptInvitation({ token: 'token-abc' })).rejects.toThrow('Invalid or expired invitation');
    });
  });

  // ── getInvitationDetails ────────────────────────────────────────────────

  describe('getInvitationDetails', () => {
    it('returns invitation details for valid token', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(
        makeMemberDoc({
          invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
        }),
      );
      tenantRepo.findById.mockResolvedValue({
        id: 'tenant-1',
        name: 'Acme Corp',
        status: 'ACTIVE',
        description: null,
        deletionScheduledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // Registered account (real password hash) → isRegistered true
      userRepo.findDocumentById.mockResolvedValue(
        makeUserDoc({ email: 'invited@example.com', passwordHash: 'hashed-pw' }),
      );
      userRepo.findByEmail.mockResolvedValue(null);

      const result = await service.getInvitationDetails('token-abc');

      expect(result.email).toBe('invited@example.com');
      expect(result.tenantName).toBe('Acme Corp');
      expect(result.role).toBe('MEMBER');
      expect(result.status).toBe('PENDING');
      expect(result.isRegistered).toBe(true);
    });

    it('reports isRegistered=false for a placeholder invitee without an account (V5-2)', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(
        makeMemberDoc({
          invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
        }),
      );
      tenantRepo.findById.mockResolvedValue({
        id: 'tenant-1',
        name: 'Acme Corp',
        status: 'ACTIVE',
        description: null,
        deletionScheduledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // Placeholder created at invite time: exists but has no password
      userRepo.findDocumentById.mockResolvedValue(makeUserDoc({ email: 'v5member@t.local', passwordHash: '' }));

      const result = await service.getInvitationDetails('token-abc');

      expect(result.email).toBe('v5member@t.local');
      expect(result.isRegistered).toBe(false);
    });

    it('throws NotFoundError for invalid token', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(null);

      await expect(service.getInvitationDetails('invalid')).rejects.toThrow('Invitation not found');
    });

    it('throws NotFoundError when tenant is missing', async () => {
      memberRepo.findByInvitationToken.mockResolvedValue(
        makeMemberDoc({
          invitation: { status: 'PENDING', tokenHash: 'hash', invitedBy: 'owner', invitedOn: new Date() },
        }),
      );
      tenantRepo.findById.mockResolvedValue(null);

      await expect(service.getInvitationDetails('token-abc')).rejects.toThrow('Tenant not found');
    });
  });

  // ── JWT token format ────────────────────────────────────────────────────

  describe('JWT token', () => {
    it('contains the correct payload fields', async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      userRepo.create.mockResolvedValue(makeUser({ email: 'new@example.com', displayName: 'New User' }));
      memberRepo.findPendingByEmail.mockResolvedValue([]);

      const result = await service.register({
        email: 'new@example.com',
        password: 'securepass123',
        displayName: 'New User',
      });
      const parts = result.token.split('.');
      const payloadJson = atob((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(payloadJson);

      expect(payload.sub).toBe('user-1');
      expect(payload.email).toBe('new@example.com');
      expect(payload.displayName).toBe('New User');
      expect(payload.tenantId).toBeNull();
      expect(payload.tenantRole).toBeNull();
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBe(payload.iat + 24 * 60 * 60);
    });
  });
});

// ─── 429 must carry Retry-After + RateLimit-* ────────────────────────────────
//
// The limiter itself always worked (it trips on the 11th login attempt), but
// the response said nothing about how long to back off, so a client could only
// guess. The limiters are module-level and shared across tests, so every test
// below uses a UNIQUE email+IP key to keep its own counter.

describe('rate-limit response headers (W-42)', () => {
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let service: AuthService;
  // Unique per call so each test gets a private counter in the shared limiter.
  let unique = 0;
  const nextKey = () => `rl-${(unique += 1)}`;

  beforeEach(() => {
    userRepo = createMockUserRepo();
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    service = new AuthService(
      userRepo as never,
      tenantRepo as never,
      memberRepo as never,
      TEST_SECRET,
      null,
      undefined,
      'durable',
    );
    // No such user → the limiter is the only thing under test; the call fails
    // fast on the credential check instead of paying for a bcrypt compare.
    userRepo.findByEmail.mockResolvedValue(null);
  });

  /** Drive the login limiter past its limit and return the thrown 429. */
  async function exhaustLoginLimiter(email: string, ip: string): Promise<unknown> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await service.login({ email, password: 'wrongpass123' }, ip);
      } catch (err) {
        const status = (err as AppError).statusCode;

        if (status === 429) return err;
      }
    }
    throw new Error('login limiter never tripped');
  }

  it('attaches Retry-After and RateLimit-* headers to the 429', async () => {
    const err = (await exhaustLoginLimiter(`w42a-${nextKey()}@example.com`, '10.0.0.1')) as AppError;

    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.headers).toBeDefined();
  });

  it('sets Retry-After to a positive whole number of seconds inside the window', async () => {
    const err = (await exhaustLoginLimiter(`w42b-${nextKey()}@example.com`, '10.0.0.2')) as AppError;
    const headers = err.headers ?? {};
    const retryAfter = Number(headers['Retry-After']);

    expect(Number.isInteger(retryAfter)).toBe(true);
    // The login window is 15 minutes, so the caller must be told to back off
    // for a positive, non-zero span — never "retry immediately".
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it('reports the configured limit and zero remaining requests', async () => {
    const err = (await exhaustLoginLimiter(`w42c-${nextKey()}@example.com`, '10.0.0.3')) as AppError;
    const headers = err.headers ?? {};

    expect(headers['RateLimit-Limit']).toBe('10'); // LOGIN_MAX_REQUESTS
    expect(headers['RateLimit-Remaining']).toBe('0');
    expect(headers['RateLimit-Reset']).toBe(headers['Retry-After']);
  });

  it('still throws the same RATE_LIMITED envelope code (no contract change)', async () => {
    const err = (await exhaustLoginLimiter(`w42d-${nextKey()}@example.com`, '10.0.0.4')) as AppError;

    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe('Too many login attempts. Try again later.');
    expect(err.details).toBeUndefined();
  });

  it('does not add headers to a non-429 AppError', async () => {
    const err = await service
      .login({ email: `w42e-${nextKey()}@example.com`, password: 'x' }, '10.0.0.5')
      .catch((e: unknown) => e);

    expect((err as AppError).statusCode).toBe(401);
    expect((err as AppError).headers).toBeUndefined();
  });

  it('applies the same headers to the registration limiter', async () => {
    let thrown: unknown;

    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await service.register(
          { email: `w42f-${nextKey()}@example.com`, password: 'securepass123', displayName: 'X' },
          '10.0.0.6',
        );
      } catch (err) {
        if ((err as AppError).statusCode === 429) {
          thrown = err;
          break;
        }
      }
    }

    const err = thrown as AppError;

    expect(err).toBeInstanceOf(AppError);
    expect(err.headers?.['Retry-After']).toBeDefined();
    expect(err.headers?.['RateLimit-Limit']).toBe('20'); // REGISTER_MAX_REQUESTS
  });
});

describe('buildRateLimitHeaders', () => {
  it('emits the RFC 9110 / RFC 6585 header set', () => {
    const headers = buildRateLimitHeaders(10, { limited: true, remaining: 0, retryAfterSeconds: 42 });

    expect(headers).toEqual({
      'Retry-After': '42',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '42',
    });
  });

  it('stringifies the values (headers must be strings)', () => {
    const headers = buildRateLimitHeaders(5, { limited: true, remaining: 0, retryAfterSeconds: 1 });

    for (const value of Object.values(headers)) {
      expect(typeof value).toBe('string');
    }
  });
});

// ─── Per-account AND per-source login ceilings ────────────────────────────────
//
// Before F10 the login limiter was keyed `email:ip`. Two consequences the audit
// proved at runtime:
//   1. spraying ONE request per address across many addresses from one source
//      never hit a ceiling (measured: 60 requests, 0 × 429);
//   2. rotating the source against a single victim account reset the counter.
//
// Now BOTH ceilings apply and the stricter one wins. As above, the limiters are
// module-level and shared across tests, so every case below uses a unique source
// AND a unique email to get a private pair of counters.

describe('login rate limiting — per-account and per-source (F10 / M-007)', () => {
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let tenantRepo: ReturnType<typeof createMockTenantRepo>;
  let memberRepo: ReturnType<typeof createMockTenantMemberRepo>;
  let service: AuthService;
  let unique = 0;
  const nextKey = () => `f10-${(unique += 1)}`;
  /** A fresh source identifier per call (stands in for CF-Connecting-IP). */
  const nextSource = () => `198.51.100.${(unique += 1)}`;

  beforeEach(() => {
    userRepo = createMockUserRepo();
    tenantRepo = createMockTenantRepo();
    memberRepo = createMockTenantMemberRepo();
    service = new AuthService(
      userRepo as never,
      tenantRepo as never,
      memberRepo as never,
      TEST_SECRET,
      null,
      undefined,
      'durable',
    );
    // No such user → the limiter is the only thing under test; the call fails on
    // the credential check instead of paying for a bcrypt compare.
    userRepo.findByEmail.mockResolvedValue(null);
  });

  /** Run one login attempt and return the thrown error, if any. */
  async function attempt(email: string, source?: string): Promise<AppError | null> {
    const err = await service.login({ email, password: 'wrongpass123' }, source).catch((e: unknown) => e);

    return (err as AppError).statusCode === 429 ? (err as AppError) : null;
  }

  // ── per-account ceiling ──────────────────────────────────────────────────

  it('trips the per-account ceiling on the 11th attempt for the same email', async () => {
    const email = `${nextKey()}@example.com`;
    const source = nextSource();

    for (let i = 0; i < 10; i++) {
      expect(await attempt(email, source)).toBeNull();
    }

    const limited = await attempt(email, source);

    expect(limited?.statusCode).toBe(429);
    expect(limited?.code).toBe('RATE_LIMITED');
  });

  it('reports the per-account limit and a back-off in the F6 headers', async () => {
    const email = `${nextKey()}@example.com`;
    const source = nextSource();
    let limited: AppError | null = null;

    for (let i = 0; i < 12; i++) {
      limited = (await attempt(email, source)) ?? limited;
    }

    expect(limited?.headers?.['RateLimit-Limit']).toBe('10'); // LOGIN_MAX_REQUESTS
    expect(limited?.headers?.['RateLimit-Remaining']).toBe('0');
    expect(Number(limited?.headers?.['Retry-After'])).toBeGreaterThan(0);
  });

  it('keys the per-account ceiling on the email ALONE — rotating the source does not reset it', async () => {
    const email = `${nextKey()}@example.com`;

    for (let i = 0; i < 10; i++) {
      // A DIFFERENT source on every single attempt (the old `email:ip` key would
      // hand the attacker a fresh budget each time).
      expect(await attempt(email, nextSource())).toBeNull();
    }

    expect((await attempt(email, nextSource()))?.statusCode).toBe(429);
  });

  it('normalizes the email so case/whitespace cannot buy a second budget', async () => {
    const email = `${nextKey()}@example.com`;
    const source = nextSource();

    for (let i = 0; i < 10; i++) {
      expect(await attempt(`  ${email.toUpperCase()} `, source)).toBeNull();
    }

    expect((await attempt(email, source))?.statusCode).toBe(429);
  });

  // ── per-source ceiling (the spray) ───────────────────────────────────────

  it('throttles a spray of DISTINCT emails from one source (the measured 0 × 429 attack)', async () => {
    const source = nextSource();
    let limited: AppError | null = null;
    let attempts = 0;

    // 60 requests, one per address — exactly the shape the audit probed.
    for (let i = 0; i < 60 && limited === null; i++) {
      attempts += 1;
      limited = await attempt(`spray-${nextKey()}-${i}@example.com`, source);
    }

    expect(limited?.statusCode).toBe(429);
    // Rejected well before the 60th request: the per-source ceiling engaged.
    expect(attempts).toBeLessThanOrEqual(31); // LOGIN_SOURCE_MAX_REQUESTS + the rejecting call
    expect(limited?.message).toBe('Too many login attempts from this source. Try again later.');
  });

  it('reports the per-source limit in RateLimit-Limit (so the client knows which ceiling it hit)', async () => {
    const source = nextSource();
    let limited: AppError | null = null;

    for (let i = 0; i < 40 && limited === null; i++) {
      limited = await attempt(`src-${nextKey()}-${i}@example.com`, source);
    }

    expect(limited?.headers?.['RateLimit-Limit']).toBe('30'); // LOGIN_SOURCE_MAX_REQUESTS
    expect(limited?.headers?.['Retry-After']).toBeDefined();
  });

  it('does not let one source consume another source’s budget', async () => {
    const noisy = nextSource();
    const quiet = nextSource();

    for (let i = 0; i < 30; i++) {
      await attempt(`noisy-${nextKey()}-${i}@example.com`, noisy);
    }

    expect((await attempt(`${nextKey()}@example.com`, noisy))?.statusCode).toBe(429);
    expect(await attempt(`${nextKey()}@example.com`, quiet)).toBeNull();
  });

  it('falls back to one shared bucket when the source identifier is unknown', async () => {
    // No source at all (e.g. a runtime that sets no edge header): everything lands
    // in the 'unknown' bucket rather than bypassing the ceiling.
    let limited: AppError | null = null;

    for (let i = 0; i < 60 && limited === null; i++) {
      limited = await attempt(`unknown-${nextKey()}-${i}@example.com`, undefined);
    }

    expect(limited?.statusCode).toBe(429);
  });

  // ── the stricter of the two wins ──────────────────────────────────────────

  it('the per-account ceiling wins when it is the stricter one (same email, fresh source)', async () => {
    const email = `${nextKey()}@example.com`;

    for (let i = 0; i < 10; i++) {
      await attempt(email, nextSource());
    }

    const limited = await attempt(email, nextSource());

    expect(limited?.message).toBe('Too many login attempts. Try again later.');
    expect(limited?.headers?.['RateLimit-Limit']).toBe('10');
  });

  it('the per-source ceiling wins when it is the stricter one (many emails, one source)', async () => {
    const source = nextSource();
    let limited: AppError | null = null;

    for (let i = 0; i < 60 && limited === null; i++) {
      limited = await attempt(`stricter-${nextKey()}-${i}@example.com`, source);
    }

    expect(limited?.message).toBe('Too many login attempts from this source. Try again later.');
    expect(limited?.headers?.['RateLimit-Limit']).toBe('30');
  });

  it('a legitimate single login from a fresh source and account is never throttled', async () => {
    // Regression guard: the ceilings must not touch the happy path.
    for (let i = 0; i < 20; i++) {
      expect(await attempt(`${nextKey()}@example.com`, nextSource())).toBeNull();
    }
  });
});
