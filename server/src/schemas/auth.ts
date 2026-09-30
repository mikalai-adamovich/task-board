import * as z from 'zod';
import { TenantRoleValues } from '@task-board/shared';

/**
 * Schema for login request body.
 */
export const LoginRequestSchema = z.object({
  email: z.email({ message: 'Invalid email address', pattern: z.regexes.html5Email }),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Schema for registration request body.
 */
export const RegisterRequestSchema = z.object({
  email: z.email({ message: 'Invalid email address', pattern: z.regexes.html5Email }),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  displayName: z.string().min(1, 'Display name is required').max(100, 'Display name must be at most 100 characters'),
});
// `AuthResponseSchema` was removed as dead code. It claimed to be the
// login/register response contract but was never wired to anything, so the
// response was never actually validated — the claim was untested. The real
// contract is the shared `AuthResponse` interface plus `UserSchema` (still used
// by the request schemas).

/**
 * Schema for the forgot-password request body.
 */
export const ForgotPasswordSchema = z.object({
  email: z.email({ message: 'Invalid email address', pattern: z.regexes.html5Email }),
});

/**
 * Schema for the reset-password request body.
 */
export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

/**
 * Schema for accepting an invitation to join a tenant.
 */
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1, 'Invitation token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

// `InvitationDetailsSchema` was removed as dead code — same reason as
// `AuthResponseSchema`: an unwired "response contract" that validated nothing.
// `MyInvitationSchema` (used by GET /invitations/my) is kept.

/**
 * Schema for invitation details visible to the current user.
 * Returned by GET /invitations/my.
 */
export const MyInvitationSchema = z.object({
  /** Unique invitation identifier (UUID v4) */
  id: z.uuid(),
  /** Tenant the invitation belongs to */
  tenantId: z.uuid(),
  /** Display name of the tenant */
  tenantName: z.string(),
  /** Role the invitee will receive */
  role: z.enum(TenantRoleValues),
  /** Email the invitation was sent to */
  invitedEmail: z.email(),
  /** Timestamp when the invitation was sent (ISO 8601) */
  invitedAt: z.iso.datetime().nullable(),
});

// `PendingInvitationSchema` was removed as dead code (unwired response
// schema, see above).
