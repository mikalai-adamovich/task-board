import { Resend } from 'resend';
import { createLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/escape-html.js';

/**
 * Budget for a single outbound Resend call.
 *
 * The server has no `waitUntil` — every outbound call sits on the request
 * path — and the Resend SDK exposes no `signal` option, so an unresponsive
 * Resend endpoint (or a hung TLS handshake) used to hold a Worker request open
 * for as long as the platform allowed, burning CPU-budget headroom for a
 * feature the user did not ask for. 5 s is ~10x the observed p99 of the call
 * (Resend answers in 200–800 ms from WEU) and still well inside the CPU budget,
 * so normal delivery is never cut short while a hung one is bounded.
 */
export const EMAIL_SEND_TIMEOUT_MS = 5_000;

/**
 * Raised when the outbound e-mail call exceeds {@link EMAIL_SEND_TIMEOUT_MS}.
 *
 * It is an ordinary `Error`, so it propagates exactly like a network failure
 * from the same call already does — the failure semantics of every call site
 * (best-effort for invitations, fail-hard for password reset) are unchanged.
 */
export class EmailTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Outbound e-mail request exceeded the ${timeoutMs}ms budget`);
    this.name = 'EmailTimeoutError';
  }
}

/**
 * Raised when the provider ACCEPTED the request and REFUSED the message.
 *
 * The Resend SDK does not reject on an API error. `resend.post` resolves
 * with `Response<T>`, which is a discriminated union —
 * `{ data, error: null }` **or** `{ error: { message, name, statusCode }, data: null }`
 * (`node_modules/resend/dist/index.d.mts:122-135`). An invalid `from` address, a
 * suppressed recipient, a daily-quota exhaustion or a restricted API key all
 * arrive as a RESOLVED `{ error }`. Every call site was therefore treating a
 * refused send as a delivered one: the invitation route returned 201 for a mail
 * that was never sent, and the password-reset "fail-hard" path could not fail
 * because there was nothing to catch.
 *
 * Inspecting the resolved value is therefore the only way to know, and this
 * error is what makes it visible to a caller that already distinguishes
 * best-effort from fail-hard. A network failure or a timeout still rejects, as
 * before, so the two failure modes stay distinguishable at the call site.
 */
export class EmailDeliveryError extends Error {
  /** The provider's own error code (`validation_error`, `daily_quota_exceeded`, …). */
  readonly reason: string;
  readonly statusCode: number | null;

  constructor(reason: string, message: string, statusCode: number | null) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/** The shape `resend.emails.send` resolves with — both halves, never one. */
interface ResendSendResponse {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number | null } | null;
}

const sendLog = createLogger({ scope: 'email' });

/**
 * Reject with an {@link EmailTimeoutError} if `operation` has not settled in
 * `timeoutMs`.
 *
 * The underlying fetch cannot be aborted — the installed SDK (6.25.0) accepts
 * only `query` and `headers` in its request options — but the REQUEST stops
 * waiting for it, which is what protects the Worker's budget. A late reply is
 * discarded, exactly as it would be after any other failed send.
 */
async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // No recipient, no token, no id — see utils/redact.ts.
      sendLog.warn('Outbound e-mail request timed out', { timeoutMs });
      reject(new EmailTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

export class EmailService {
  private readonly resend: Resend;
  private readonly fromEmail: string;
  private readonly frontendUrl: string;

  constructor(apiKey: string, fromEmail: string, frontendUrl: string) {
    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail;
    this.frontendUrl = frontendUrl;
  }

  /**
   * The one place an outbound send happens: budget it, then INSPECT what came
   * back. Wrapping once rather than at three call sites is deliberate — the
   * defect was three copies of "await and hope", and a fourth send added later
   * would be the same defect again.
   */
  private async send(payload: { to: string; subject: string; html: string }): Promise<void> {
    const response = (await withTimeout(
      () =>
        this.resend.emails.send({ from: this.fromEmail, to: payload.to, subject: payload.subject, html: payload.html }),
      EMAIL_SEND_TIMEOUT_MS,
    )) as ResendSendResponse;

    if (response.error) {
      // No recipient, no token, no subject — the same rule the log scrubber in
      // utils/redact.ts follows. The provider's own message is not logged: it
      // can echo the address the send was refused for.
      sendLog.error('Outbound e-mail refused by the provider', { reason: response.error.name });
      throw new EmailDeliveryError(response.error.name, response.error.message, response.error.statusCode);
    }
  }

  async sendPasswordResetEmail(params: { to: string; resetUrl: string; expiresInMinutes: number }): Promise<void> {
    const html = `
      <h2>Password reset request</h2>
      <p>We received a request to reset your password.</p>
      <p><a href="${escapeHtml(params.resetUrl)}">Reset your password</a></p>
      <p>This link is valid for ${escapeHtml(String(params.expiresInMinutes))} minutes and can only be used once. If you didn't request a password reset, you can safely ignore this email.</p>
    `;

    await this.send({ to: params.to, subject: 'Reset your password', html });
  }

  async sendInvitationEmail(params: {
    to: string;
    inviterName: string;
    tenantName: string;
    role: string;
    token: string;
  }): Promise<void> {
    const acceptUrl = `${this.frontendUrl}/auth/accept-invitation?token=${params.token}`;
    const html = `
      <h2>You've been invited to ${escapeHtml(params.tenantName)}</h2>
      <p>${escapeHtml(params.inviterName)} has invited you to join <strong>${escapeHtml(params.tenantName)}</strong> as a <strong>${escapeHtml(params.role)}</strong>.</p>
      <p><a href="${escapeHtml(acceptUrl)}">Accept Invitation</a></p>
      <p>If you don't have an account yet, you'll be able to create one when accepting the invitation.</p>
    `;

    await this.send({ to: params.to, subject: `You're invited to join ${params.tenantName}`, html });
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    await this.send({ to: options.to, subject: options.subject, html: options.html });
  }
}

/** Mask the `token` query parameter of a URL before logging it — if the
 * console mailer ever runs in production (missing RESEND_API_KEY), raw
 * invitation/reset tokens must not leak into logs. */
function maskTokenInUrl(url: string): string {
  return url.replace(/(token=)[^&]+/, '$1<redacted>');
}

const log = createLogger({ scope: 'email' });

export class ConsoleEmailService implements Pick<
  EmailService,
  'sendEmail' | 'sendInvitationEmail' | 'sendPasswordResetEmail'
> {
  async sendPasswordResetEmail(params: { to: string; resetUrl: string; expiresInMinutes: number }): Promise<void> {
    log.info('Password reset email (dev stub — not delivered)', {
      to: params.to,
      resetUrl: maskTokenInUrl(params.resetUrl),
      expiresInMinutes: params.expiresInMinutes,
    });
  }

  async sendInvitationEmail(params: {
    to: string;
    inviterName: string;
    tenantName: string;
    role: string;
    token: string;
  }): Promise<void> {
    const acceptUrl = `${process.env.FRONTEND_URL || 'http://localhost:4200'}/auth/accept-invitation?token=${params.token}`;

    log.info('Invitation email (dev stub — not delivered)', {
      to: params.to,
      tenantName: params.tenantName,
      role: params.role,
      acceptUrl: maskTokenInUrl(acceptUrl),
    });
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    log.info('Email (dev stub — not delivered)', { to: options.to, subject: options.subject });
  }
}
