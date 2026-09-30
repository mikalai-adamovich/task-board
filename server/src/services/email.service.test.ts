import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMAIL_SEND_TIMEOUT_MS,
  EmailService,
  EmailTimeoutError,
  EmailDeliveryError,
  ConsoleEmailService,
} from './email.service.js';

// ─── Mock Resend ─────────────────────────────────────────────────────────────

/**
 * The mock now answers with the shape the SDK actually resolves —
 * `{ data, error: null, headers }` — not a bare `{ id }`.
 *
 * The old `{ id: 'email-123' }` had no `error` property at all, so a mock
 * "refusing" the send was not constructible: every test resolved something
 * that looked like success, which is exactly why the fixed branch was
 * unreachable and the defect was invisible. The type is `Response<T>` in
 * `node_modules/resend/dist/index.d.mts:122-135`, and the discriminated union
 * is the whole point.
 */
const ACCEPTED = { data: { id: 'email-123' }, error: null, headers: {} };
/** A provider that accepted the request and refused the message. */
const REFUSED = {
  data: null,
  error: { message: 'The from address is not verified', name: 'validation_error', statusCode: 422 },
  headers: {},
};
const mockSend = vi.fn().mockResolvedValue(ACCEPTED);

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: mockSend,
    },
  })),
}));

describe('EmailService', () => {
  let service: EmailService;

  beforeEach(() => {
    mockSend.mockClear();
    service = new EmailService('re_test_key', 'noreply@taskboard.app', 'https://app.example.com');
  });

  describe('sendInvitationEmail', () => {
    it('sends an email with the correct params', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: 'John',
        tenantName: 'Acme',
        role: 'member',
        token: 'inv-token-123',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith({
        from: 'noreply@taskboard.app',
        to: 'user@example.com',
        subject: "You're invited to join Acme",
        html: expect.stringContaining('inv-token-123'),
      });
    });

    it('includes the accept URL in the HTML body', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: 'John',
        tenantName: 'Acme',
        role: 'admin',
        token: 'abc',
      });

      const html = mockSend.mock.calls[0]?.[0]?.html as string;

      expect(html).toContain('https://app.example.com/auth/accept-invitation?token=abc');
    });

    it('includes inviter and tenant info in the HTML body', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: 'Jane',
        tenantName: 'My Workspace',
        role: 'member',
        token: 'tok',
      });

      const html = mockSend.mock.calls[0]?.[0]?.html as string;

      expect(html).toContain('Jane');
      expect(html).toContain('My Workspace');
      expect(html).toContain('member');
    });

    it('HTML-escapes interpolated values (N-13)', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: '<script>alert("x")</script>',
        tenantName: 'Acme & Co <b>',
        role: 'member"><img src=x onerror=alert(1)>',
        token: 'tok',
      });

      const html = mockSend.mock.calls[0]?.[0]?.html as string;

      // Raw markup must not survive into the HTML body
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<b>');
      expect(html).not.toContain('<img');
      // Escaped forms are present instead (entities built via concatenation so
      // this source file never contains a raw HTML entity)
      expect(html).toContain('&' + 'lt;script' + '&' + 'gt;');
      expect(html).toContain('Acme &' + 'amp; Co &' + 'lt;b' + '&' + 'gt;');
      expect(html).toContain('&' + 'quot;');
    });

    it('escapes the tenant name in the subject as plain text (no HTML context)', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: 'Jane',
        tenantName: 'A<B>',
        role: 'member',
        token: 'tok',
      });

      const call = mockSend.mock.calls[0]?.[0] as { subject: string; html: string };

      // Subject is plain text — raw value is fine there; the HTML body must be escaped
      expect(call.subject).toBe("You're invited to join A<B>");
      expect(call.html).not.toContain('<B>');
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('sends an email with the reset URL and expiry', async () => {
      await service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/auth/reset-password?token=abc123',
        expiresInMinutes: 60,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith({
        from: 'noreply@taskboard.app',
        to: 'user@example.com',
        subject: 'Reset your password',
        html: expect.stringContaining('https://app.example.com/auth/reset-password?token=abc123'),
      });

      const html = mockSend.mock.calls[0]?.[0]?.html as string;

      expect(html).toContain('60 minutes');
    });
  });

  describe('sendEmail', () => {
    it('sends a generic email', async () => {
      await service.sendEmail({
        to: 'test@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
      });

      expect(mockSend).toHaveBeenCalledWith({
        from: 'noreply@taskboard.app',
        to: 'test@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
      });
    });
  });
});

/**
 * An outbound call that never answers must not hold a Worker request
 * open. The Resend SDK has no `signal` option, so the bound is enforced by
 * racing the promise — what changes is that the REQUEST stops waiting, not
 * that the send silently succeeds.
 */
/**
 * A send the provider REFUSES must not read as a send that succeeded.
 *
 * These are the absent-input tests the SDK's shape made impossible to write
 * before: `resend.post` resolves `{ error }` for a validation failure, a
 * suppressed recipient, an exhausted quota or a restricted key, and never
 * rejects for any of them. A caller that only awaited could not tell any of
 * them from a delivered message.
 */
describe('D-27: a refused send is a failure, not a success', () => {
  let service: EmailService;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(ACCEPTED);
    service = new EmailService('re_test_key', 'noreply@taskboard.app', 'https://app.example.com');
  });

  it('throws EmailDeliveryError when the provider resolves { error }', async () => {
    mockSend.mockResolvedValue(REFUSED);

    await expect(
      service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/auth/reset-password?token=abc',
        expiresInMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('carries the provider reason and status, so a caller can tell quota from validation', async () => {
    mockSend.mockResolvedValue(REFUSED);

    const error = await service
      .sendEmail({ to: 'user@example.com', subject: 's', html: '<p>x</p>' })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).reason).toBe('validation_error');
    expect((error as EmailDeliveryError).statusCode).toBe(422);
  });

  it('every send path reports a refusal — the check is not on one of three', async () => {
    mockSend.mockResolvedValue(REFUSED);

    const sends = [
      service.sendPasswordResetEmail({ to: 'a@b.c', resetUrl: 'https://x/y', expiresInMinutes: 60 }),
      service.sendInvitationEmail({ to: 'a@b.c', inviterName: 'J', tenantName: 'T', role: 'member', token: 't' }),
      service.sendEmail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' }),
    ];

    for (const send of sends) {
      await expect(send).rejects.toBeInstanceOf(EmailDeliveryError);
    }
  });

  it('a refusal is still distinguishable from a transport failure', async () => {
    // Two failure modes, two errors: the call sites that treat one as
    // best-effort and the other as fatal need to be able to.
    mockSend.mockResolvedValue(REFUSED);

    const refused = await service
      .sendEmail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' })
      .catch((err: unknown) => err as Error);

    mockSend.mockRejectedValue(new Error('ECONNREFUSED'));

    const transport = await service
      .sendEmail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' })
      .catch((err: unknown) => err as Error);

    expect(refused).toBeInstanceOf(EmailDeliveryError);
    expect(transport).toBeInstanceOf(Error);
    expect(transport).not.toBeInstanceOf(EmailDeliveryError);
    expect((transport as Error).message).toBe('ECONNREFUSED');
  });

  it('a send the provider ACCEPTS still resolves', async () => {
    mockSend.mockResolvedValue(ACCEPTED);

    await expect(service.sendEmail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' })).resolves.toBeUndefined();
  });
});

describe('EmailService outbound timeout (F-516)', () => {
  let service: EmailService;

  beforeEach(() => {
    mockSend.mockReset();
    service = new EmailService('re_test_key', 'noreply@taskboard.app', 'https://app.example.com');
  });

  it('has a bounded budget', () => {
    expect(EMAIL_SEND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EMAIL_SEND_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('rejects with EmailTimeoutError when the send hangs', async () => {
    vi.useFakeTimers();
    mockSend.mockReturnValue(new Promise(() => undefined));

    try {
      const pending = service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/auth/reset-password?token=abc',
        expiresInMinutes: 60,
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(EmailTimeoutError);

      await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on the same budget for invitations and generic sends', async () => {
    vi.useFakeTimers();
    mockSend.mockReturnValue(new Promise(() => undefined));

    try {
      const invitation = expect(
        service.sendInvitationEmail({
          to: 'user@example.com',
          inviterName: 'John',
          tenantName: 'Acme',
          role: 'member',
          token: 'tok',
        }),
      ).rejects.toBeInstanceOf(EmailTimeoutError);
      const generic = expect(
        service.sendEmail({ to: 'user@example.com', subject: 's', html: '<p>x</p>' }),
      ).rejects.toBeInstanceOf(EmailTimeoutError);

      await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS);
      await Promise.all([invitation, generic]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a call that answers in time', async () => {
    mockSend.mockResolvedValue({ id: 'email-1' });

    await expect(
      service.sendEmail({ to: 'user@example.com', subject: 's', html: '<p>x</p>' }),
    ).resolves.toBeUndefined();
  });

  it('propagates a transport failure unchanged (call sites keep their semantics)', async () => {
    mockSend.mockRejectedValue(new Error('ECONNRESET'));

    // Best-effort call sites (invitations) already catch this; a fail-hard one
    // (password reset) already answered 500. A timeout behaves identically.
    await expect(
      service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/auth/reset-password?token=abc',
        expiresInMinutes: 60,
      }),
    ).rejects.toThrow('ECONNRESET');
  });
});

describe('ConsoleEmailService', () => {
  let service: ConsoleEmailService;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new ConsoleEmailService();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('sendInvitationEmail', () => {
    it('logs the invitation details as a single structured line', async () => {
      await service.sendInvitationEmail({
        to: 'user@example.com',
        inviterName: 'John',
        tenantName: 'Acme',
        role: 'member',
        token: 'tok-123',
      });

      // One single-line JSON entry per email
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      const entry = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;

      expect(entry.level).toBe('info');
      expect(entry.scope).toBe('email');
      expect(entry.to).toBe('user@example.com');
      expect(entry.tenantName).toBe('Acme');
      expect(entry.role).toBe('member');
      // token is masked in logs — raw tokens must never leak via the console stub
      expect(entry.acceptUrl).toContain('accept-invitation?token=<redacted>');
      expect(JSON.stringify(entry)).not.toContain('tok-123');
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('logs the reset details as a single structured line without leaking the token', async () => {
      await service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'http://localhost:4200/auth/reset-password?token=tok-123',
        expiresInMinutes: 60,
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      const entry = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;

      expect(entry.to).toBe('user@example.com');
      // token is masked in logs — raw tokens must never leak via the console stub
      expect(entry.resetUrl).toContain('/auth/reset-password?token=<redacted>');
      expect(entry.expiresInMinutes).toBe(60);
      expect(JSON.stringify(entry)).not.toContain('tok-123');
    });
  });

  describe('sendEmail', () => {
    it('logs the email details as a single structured line', async () => {
      await service.sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Hi</p>',
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      const entry = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;

      expect(entry.to).toBe('test@example.com');
      expect(entry.subject).toBe('Test');
    });
  });
});
