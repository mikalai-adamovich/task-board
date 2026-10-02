import { randomBytes } from 'node:crypto';
import { sign } from 'hono/jwt';
import { MemberStatus, InvitationStatus, JWT_TTL_SECONDS, PASSWORD_RESET_TTL_MINUTES } from '@task-board/shared';
import type {
  User,
  AuthResponse,
  RegisterRequest,
  LoginRequest,
  InvitationDetails,
  TenantRole,
  ForgotPasswordResponse,
} from '@task-board/shared';
import { AppError, BadRequestError, ConflictError, NotFoundError, ValidationError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { buildRateLimitHeaders } from '../utils/rate-limiter.js';
import {
  LOGIN_ACCOUNT_MAX_REQUESTS,
  RateLimitAuthorityService,
  REGISTER_MAX_REQUESTS,
} from './rate-limit-authority.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { TenantMemberRepository } from '../repositories/tenant-member.repository.js';

// ─── JWT Utilities (hono/jwt — Workers compatible) ───────────────────────────

/** Claims carried by the access token */
export interface JwtPayload {
  sub: string;
  email: string;
  displayName: string;
  tenantId: string | null;
  tenantRole: TenantRole | null;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BCRYPT_SALT_ROUNDS = 10;

// The four authentication buckets — their ceilings, their windows and the keys
// they resolve to — now belong to the authority that enforces them
// (`services/rate-limit-authority.service.ts`), which is also where the
// in-process limiters they fall back to live. They are re-exported here because
// this module is where the auth HTTP contract reads them from, and a second copy
// of a number is a number that will drift.
export {
  FORGOT_PASSWORD_MAX_REQUESTS,
  LOGIN_ACCOUNT_MAX_REQUESTS,
  LOGIN_SOURCE_MAX_REQUESTS,
  REGISTER_MAX_REQUESTS,
} from './rate-limit-authority.service.js';

/**
 * The login ceiling, exported so `/api/readyz` can report what this
 * deployment is actually enforcing. Named for what it is rather than reusing the
 * private constant, so the probe and the limiter cannot drift apart silently.
 */
export const LOGIN_RATE_LIMIT_MAX_REQUESTS = LOGIN_ACCOUNT_MAX_REQUESTS;

/**
 * Minimal mailer contract needed by AuthService for password-reset emails.
 * Satisfied by both EmailService (Resend) and ConsoleEmailService.
 */
export interface PasswordResetMailer {
  sendPasswordResetEmail(params: { to: string; resetUrl: string; expiresInMinutes: number }): Promise<void>;
}

// ─── Re-export (F6 compatibility) ────────────────────────────────────────────
// `buildRateLimitHeaders` / `RateLimitResult` were defined here and are imported
// from this module elsewhere; they now live with the shared limiter. Re-exported
// so existing imports keep working.
export { buildRateLimitHeaders } from '../utils/rate-limiter.js';
export type { RateLimitResult } from '../utils/rate-limiter.js';

/** Create a deterministic SHA-256 hash of a token for storage/lookup (Web Crypto — Workers compatible) */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Auth Service ────────────────────────────────────────────────────────────

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly tenantRepo: TenantRepository,
    private readonly tenantMemberRepo: TenantMemberRepository,
    // REQUIRED: every rate-limit decision on this path goes through it, and an
    // optional one would compile into a `if (authority)` guard that lets a
    // request through with no ceiling applied at all. It sits here, with the
    // other collaborators, because TypeScript will not accept a required
    // parameter after the optional ones below.
    private readonly rateLimits: RateLimitAuthorityService,
    private readonly jwtSecret: string,
    private readonly mailer?: PasswordResetMailer | null,
    private readonly frontendUrl = 'http://localhost:4200',
  ) {}

  /**
   * Find an active (non-deleted) user by id.
   * Used by authMiddleware to reject tokens of soft-deleted users.
   */
  findActiveUser(id: string): Promise<User | null> {
    return this.userRepo.findById(id);
  }

  /**
   * Register a new user.
   * Creates the user and activates any pending invitations for the email.
   * Rate-limited per client IP (mass account creation mitigation).
   */
  async register(input: RegisterRequest, clientIp?: string): Promise<AuthResponse> {
    const registerLimit = await this.rateLimits.probeRegisterSource(clientIp ?? 'unknown');

    if (registerLimit.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many registration attempts. Try again later.',
        undefined,
        buildRateLimitHeaders(REGISTER_MAX_REQUESTS, registerLimit),
      );
    }

    const normalizedEmail = input.email.toLowerCase().trim();
    const existingUser = await this.userRepo.findByEmail(normalizedEmail);

    if (existingUser) {
      throw new ConflictError('A user with this email already exists');
    }

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);
    // The "email already taken" check above is racy; the unique
    // `users.email` index rejects the loser. The response is byte-for-byte the
    // one the pre-check produces — the driver's "E11000 … dup key: { email: … }"
    // must never reach the client, since it would confirm the account exists.
    const user = await withConflictOnDuplicate(
      () =>
        this.userRepo.create({
          email: normalizedEmail,
          displayName: input.displayName,
          passwordHash,
        }),
      () => new ConflictError('A user with this email already exists'),
    );
    // Activate pending invitations for this email
    const pendingInvitations = await this.tenantMemberRepo.findPendingByEmail(normalizedEmail);
    let firstTenantId: string | null = null;
    let firstTenantRole: TenantRole | null = null;

    for (const member of pendingInvitations) {
      await this.tenantMemberRepo.update(member.id, {
        status: MemberStatus.ACTIVE,
        invitation: null,
      });
      if (!firstTenantId) {
        firstTenantId = member.tenantId;
        firstTenantRole = member.role as TenantRole;
      }
    }

    const token = await this.generateToken(user, firstTenantId, firstTenantRole);

    return { token, user };
  }

  /**
   * Log in with email and password.
   *
   * TWO ceilings apply and BOTH must pass — the stricter one wins:
   * - per account (key: normalized email) — stops brute force against one victim;
   * - per source (key: `CF-Connecting-IP`, see `middleware/rate-limit.ts`) — stops
   *   the spray of one attempt per address across many addresses, which the
   *   per-account ceiling alone never sees.
   * Whichever trips first is reported, together with its own limit in
   * `RateLimit-Limit` and the back-off in `Retry-After`.
   *
   * Both probes run BEFORE any database work, so the ceiling sheds requests
   * before bcrypt — that ordering is load-bearing and is why the rate limit sits
   * here rather than inside the credential lookup. They run SEQUENTIALLY too, so
   * an account that is refused — or that the counter store could not decide —
   * never spends a second operation on a caller who is not being admitted.
   *
   * A probe that cannot be decided refuses here exactly as a refused one does.
   * The counter is a distinct operation from the credential lookup below, so a
   * counter-only fault is a refusal the client can see rather than a login
   * admitted under a ceiling this instance cannot speak for.
   */
  async login(input: LoginRequest, clientIp?: string): Promise<AuthResponse> {
    const normalizedEmail = input.email.toLowerCase().trim();
    const source = clientIp ?? 'unknown';
    const decision = await this.rateLimits.probeLogin({
      email: normalizedEmail,
      source,
    });

    if (!decision.allowed) {
      // Which bucket tripped is an internal discriminator: it picks the message
      // and reaches the client as neither a bucket name nor a counter key. The
      // reported ceiling is the one the deciding tier applied, so the header
      // cannot disagree with the behaviour.
      const perAccount = decision.bucket === 'account';

      throw new AppError(
        429,
        'RATE_LIMITED',
        perAccount
          ? 'Too many login attempts. Try again later.'
          : 'Too many login attempts from this source. Try again later.',
        undefined,
        buildRateLimitHeaders(decision.result.ceiling, decision.result),
      );
    }

    // `findActiveByEmail`, not `findByEmail`. `findByEmail` deliberately
    // matches soft-deleted users (see `user.repository.ts`) because the write
    // paths that call it are uniqueness checks against a `users.email` index
    // that is NOT partial. Authentication is not a uniqueness check, and a
    // soft-deleted account that still knows the password must NOT receive a
    // 24 h JWT: it was deleted, and the only truthful answer is the same
    // INVALID_CREDENTIALS an unknown email gets. Asking for `findByEmail` here
    // made the soft-delete filter a property of the CALLER rather than of the
    // query, and the one caller that forgot it handed out the token.
    const userDoc = await this.userRepo.findActiveByEmail(normalizedEmail);

    // V1-8: wrong credentials must return a distinct INVALID_CREDENTIALS code so
    // the UI can show a neutral "Invalid email or password" message instead of
    // mapping every 401 to session-expired copy.
    if (!userDoc) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const bcrypt = await import('bcryptjs');
    const passwordValid = await bcrypt.compare(input.password, userDoc.passwordHash);

    if (!passwordValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const memberships = await this.tenantMemberRepo.findByUser(userDoc.id);
    const activeMembership = memberships.find((m) => m.status === MemberStatus.ACTIVE);
    const user: User = {
      id: userDoc.id,
      email: userDoc.email,
      displayName: userDoc.displayName,
      avatarUrl: userDoc.avatarUrl,
      createdAt: userDoc.createdAt.toISOString(),
      updatedAt: userDoc.updatedAt.toISOString(),
      deletedAt: userDoc.deletedAt ? userDoc.deletedAt.toISOString() : null,
    };
    const token = await this.generateToken(user, activeMembership?.tenantId ?? null, activeMembership?.role ?? null);

    return { token, user };
  }

  /**
   * Get the current user's profile.
   */
  async me(userId: string): Promise<User> {
    const user = await this.userRepo.findById(userId);

    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  }

  /**
   * Accept an invitation to join a tenant.
   * Token is matched via SHA-256 hash.
   */
  /**
   * The `| undefined` is required because the route forwards the parsed
   * `AcceptInvitationSchema` body, whose absent optionals are explicit
   * `undefined`s. Still a structural type (not a hand-written *body* type with
   * its own field semantics) — the schema remains the single contract.
   */
  async acceptInvitation(input: {
    token: string;
    password?: string | undefined;
    displayName?: string | undefined;
  }): Promise<AuthResponse> {
    const hash = await hashToken(input.token);
    const invitation = await this.tenantMemberRepo.findByInvitationToken(hash);

    if (!invitation || !invitation.invitation || invitation.invitation.status !== InvitationStatus.PENDING) {
      throw new NotFoundError('Invalid or expired invitation');
    }

    // V5-2: inspect the document (not the domain projection) to distinguish a
    // real account from an invitation placeholder (empty passwordHash).
    const doc = await this.userRepo.findDocumentById(invitation.userId);

    if (!doc) {
      throw new NotFoundError('Invitation user not found');
    }

    let user: User = {
      id: doc.id,
      email: doc.email,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      deletedAt: doc.deletedAt ? doc.deletedAt.toISOString() : null,
    };

    if (doc.passwordHash === '') {
      // Placeholder account — completing the invitation REQUIRES password setup.
      if (!input.password || !input.displayName) {
        throw new ValidationError('Password and display name are required to activate this invitation');
      }

      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash(input.password, 10);

      await this.userRepo.setPasswordAndDisplayName(doc.id, passwordHash, input.displayName);
      user = { ...user, displayName: input.displayName };
    }

    // Activate the membership
    await this.tenantMemberRepo.update(invitation.id, {
      status: MemberStatus.ACTIVE,
      invitation: null,
    });

    const token = await this.generateToken(user, invitation.tenantId, invitation.role as TenantRole);

    return { token, user };
  }

  /**
   * Get invitation details by token.
   */
  async getInvitationDetails(token: string): Promise<InvitationDetails> {
    const hash = await hashToken(token);
    const invitation = await this.tenantMemberRepo.findByInvitationToken(hash);

    if (!invitation || !invitation.invitation) {
      throw new NotFoundError('Invitation not found');
    }

    const tenant = await this.tenantRepo.findById(invitation.tenantId);

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    // V5-2: a placeholder account (created at invite time for an email with no
    // account, passwordHash '') is NOT a registered user — the invitee must go
    // through password setup, not the "you already have an account" path.
    const doc = await this.userRepo.findDocumentById(invitation.userId);
    const isRegistered = doc !== null && doc.passwordHash !== '';

    return {
      email: doc?.email ?? '',
      tenantName: tenant.name,
      role: invitation.role as InvitationDetails['role'],
      status: invitation.invitation.status as InvitationDetails['status'],
      isRegistered,
    };
  }

  // ─── Password reset ────────────────────────────────────────────────────────

  /**
   * Request a password reset.
   *
   * Anti-enumeration: always resolves with the same neutral message whether or
   * not the email belongs to an existing, non-deleted account. Rate-limited
   * per email+IP; a caller over ITS OWN limit is dropped with that same neutral
   * response — dropping is the point there, since the alternative (a different
   * answer for a throttled caller) leaks that the limiter, not the account, is
   * what stopped it.
   *
   * The authority logs every refusal it makes, including one caused by the
   * counter store itself being unable to answer — the message names the failure
   * class and the bucket, never the address — so a silent no-op on a
   * password-reset path is never invisible from the logs, even though the
   * caller cannot be told. The raw token is never stored; only its SHA-256 hash.
   */
  async requestPasswordReset(input: { email: string }, clientIp?: string): Promise<ForgotPasswordResponse> {
    const normalizedEmail = input.email.toLowerCase().trim();
    const probe = await this.rateLimits.probeForgotPassword(normalizedEmail, clientIp ?? 'unknown');

    if (!probe.limited) {
      const user = await this.userRepo.findActiveByEmail(normalizedEmail);

      if (user) {
        const token = randomBytes(32).toString('hex');
        const tokenHash = await hashToken(token);

        await this.userRepo.setPasswordReset(user.id, tokenHash, new Date());

        if (this.mailer) {
          await this.mailer.sendPasswordResetEmail({
            to: user.email,
            resetUrl: `${this.frontendUrl}/auth/reset-password?token=${token}`,
            expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
          });
        }
      }
    }

    return {
      message: `If an account exists for that email, a password reset link has been sent. It expires in ${PASSWORD_RESET_TTL_MINUTES} minutes.`,
    };
  }

  /**
   * Reset a password with a single-use, expiring token.
   * Unknown / expired / already-used tokens all yield the same neutral error.
   */
  async resetPassword(input: { token: string; newPassword: string }): Promise<{ message: string }> {
    const tokenHash = await hashToken(input.token);
    const user = await this.userRepo.findByPasswordResetToken(tokenHash);
    const expired =
      !user ||
      !user.passwordReset ||
      Date.now() - user.passwordReset.requestedOn.getTime() > PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

    if (expired) {
      throw new BadRequestError('Invalid or expired reset token', 'INVALID_RESET_TOKEN');
    }

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_SALT_ROUNDS);

    // Single-use: clears the token as part of the update
    await this.userRepo.updatePasswordAndClearReset(user.id, passwordHash);

    return { message: 'Password has been reset.' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async generateToken(user: User, tenantId: string | null, tenantRole: TenantRole | null): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
      tenantId,
      tenantRole,
      iat: now,
      exp: now + JWT_TTL_SECONDS,
    };

    return sign(payload, this.jwtSecret, 'HS256');
  }
}
