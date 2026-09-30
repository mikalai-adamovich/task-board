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
import { buildRateLimitHeaders, createRateLimiter } from '../utils/rate-limiter.js';
import { resolveRateLimitScope, type RateLimitScope } from '../utils/rate-limit-scope.js';
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
/** Forgot-password rate limit: max requests per email+IP within the window */
const FORGOT_PASSWORD_MAX_REQUESTS = 5;
const FORGOT_PASSWORD_WINDOW_MS = 15 * 60 * 1000;
/**
 * Login rate limit, PER ACCOUNT: max attempts for one email inside the window
 * (brute-force mitigation).
 *
 * The key is the normalized email ALONE. The previous key was
 * `email:ip`, which an attacker defeats by rotating source addresses — the
 * per-account ceiling then never engages. Keying on the account means a
 * distributed attempt against one victim is still capped.
 */
const LOGIN_MAX_REQUESTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The login ceiling, exported so `/api/readyz` can report what this
 * deployment is actually enforcing. Named for what it is rather than reusing the
 * private constant, so the probe and the limiter cannot drift apart silently.
 */
export const LOGIN_RATE_LIMIT_MAX_REQUESTS = LOGIN_MAX_REQUESTS;

/**
 * Login rate limit, PER SOURCE: max attempts from one client identifier inside
 * the window. This is the ceiling the per-account key cannot provide — it stops
 * the SPRAY (one attempt against many different accounts from one source), which
 * the audit measured at 60 requests / 0 rejections before this change.
 *
 * VALUE: 30 attempts per 15 min per source. Defensible against the spray (the
 * measured 60-request probe now stops at request 31) while tolerating a shared
 * NAT egress: an office of ~20 people all signing in inside the same 15 minutes
 * stays under the ceiling. A botnet sidesteps it by spreading over sources —
 * that is the known residual risk of an in-process per-source ceiling. Raise it
 * if shared-NAT false positives show up in production; lower it if credential
 * stuffing is observed.
 */
const LOGIN_SOURCE_MAX_REQUESTS = 30;
const LOGIN_SOURCE_WINDOW_MS = 15 * 60 * 1000;
/** Registration rate limit: max accounts per source within the window (mass-creation mitigation) */
const REGISTER_MAX_REQUESTS = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Minimal mailer contract needed by AuthService for password-reset emails.
 * Satisfied by both EmailService (Resend) and ConsoleEmailService.
 */
export interface PasswordResetMailer {
  sendPasswordResetEmail(params: { to: string; resetUrl: string; expiresInMinutes: number }): Promise<void>;
}

// Both login limiters live at module level so their counters
// survive across requests — a limiter rebuilt per request would never trip.
// The shared, memory-bounded implementation now lives in `utils/rate-limiter.ts`
// (see that file for the in-process limitations and the eviction strategy).
const isForgotPasswordRateLimited = createRateLimiter(FORGOT_PASSWORD_MAX_REQUESTS, FORGOT_PASSWORD_WINDOW_MS);
const isLoginRateLimited = createRateLimiter(LOGIN_MAX_REQUESTS, LOGIN_WINDOW_MS);
const isLoginSourceRateLimited = createRateLimiter(LOGIN_SOURCE_MAX_REQUESTS, LOGIN_SOURCE_WINDOW_MS);
const isRegisterRateLimited = createRateLimiter(REGISTER_MAX_REQUESTS, REGISTER_WINDOW_MS);

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
  /**
   * The login limiter's SCOPE for this deployment.
   *
   * The limiters below are module-level (their counters MUST survive across
   * requests — a limiter rebuilt per request would never trip), so the mode
   * cannot be applied to them at construction. Instead the per-instance CEILING
   * is resolved once per service graph from `DB_CLIENT_MODE` and used in place
   * of the raw constant at each probe. The counters themselves are untouched:
   * in `durable` mode the ceiling is exactly what it always was, so production
   * behaviour is bit-for-bit unchanged; in a multi-instance mode the ceiling is
   * divided by the declared instance count so the DEPLOYMENT-wide ceiling stays
   * the configured number instead of growing with the isolate count.
   *
   * See `utils/rate-limit-scope.ts` for the full reasoning, including why the
   * counter is deliberately NOT moved into the Durable Object.
   */
  private readonly loginScope: RateLimitScope;

  constructor(
    private readonly userRepo: UserRepository,
    private readonly tenantRepo: TenantRepository,
    private readonly tenantMemberRepo: TenantMemberRepository,
    private readonly jwtSecret: string,
    private readonly mailer?: PasswordResetMailer | null,
    private readonly frontendUrl = 'http://localhost:4200',
    dbClientMode?: string,
    instanceBudget?: string,
  ) {
    this.loginScope = resolveRateLimitScope(dbClientMode, instanceBudget, LOGIN_MAX_REQUESTS);
  }

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
    const registerLimit = isRegisterRateLimited(clientIp ?? 'unknown');

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
   */
  async login(input: LoginRequest, clientIp?: string): Promise<AuthResponse> {
    const normalizedEmail = input.email.toLowerCase().trim();
    const source = clientIp ?? 'unknown';
    // The per-account limiter keeps the deployment-wide ceiling in
    // `durable` mode and the divided one everywhere else, so rolling back to
    // `per-request` no longer multiplies the credential-stuffing ceiling by an
    // unknown isolate count. `RateLimit-Limit` reports the ceiling that actually
    // applied, so the header and the behaviour cannot disagree.
    const accountCeiling = this.loginScope.effectiveCeiling;
    const sourceCeiling = Math.max(1, Math.floor(LOGIN_SOURCE_MAX_REQUESTS / this.loginScope.instances));
    const accountLimit = isLoginRateLimited(`account:${normalizedEmail}`, accountCeiling);
    const sourceLimit = isLoginSourceRateLimited(`source:${source}`, sourceCeiling);

    if (accountLimit.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many login attempts. Try again later.',
        undefined,
        buildRateLimitHeaders(accountCeiling, accountLimit),
      );
    }

    if (sourceLimit.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many login attempts from this source. Try again later.',
        undefined,
        buildRateLimitHeaders(sourceCeiling, sourceLimit),
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
   * per email+IP; over-limit requests are silently dropped with the same
   * neutral response. The raw token is never stored — only its SHA-256 hash.
   */
  async requestPasswordReset(input: { email: string }, clientIp?: string): Promise<ForgotPasswordResponse> {
    const normalizedEmail = input.email.toLowerCase().trim();

    if (!isForgotPasswordRateLimited(`${normalizedEmail}:${clientIp ?? 'unknown'}`).limited) {
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
