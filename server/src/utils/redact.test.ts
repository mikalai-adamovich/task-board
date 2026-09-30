import { describe, it, expect } from 'vitest';
import { redactAuthorization, scrubLogLine } from './redact.js';

describe('redactAuthorization (M-05)', () => {
  it('redacts a Bearer token in a log line', () => {
    expect(redactAuthorization('--> GET /api/tasks?token=Bearer abc.def.ghi 200 5ms')).toBe(
      '--> GET /api/tasks?token=Bearer <redacted> 200 5ms',
    );
  });

  it('is case-insensitive', () => {
    expect(redactAuthorization('bearer secret-token')).toBe('Bearer <redacted>');
  });

  it('leaves lines without credentials untouched', () => {
    const line = '<-- GET /api/projects';

    expect(redactAuthorization(line)).toBe(line);
  });

  it('redacts only the token, not surrounding text', () => {
    expect(redactAuthorization('Authorization: Bearer xyz, Content-Type: application/json')).toBe(
      'Authorization: Bearer <redacted>, Content-Type: application/json',
    );
  });
});

/**
 * The property: **a capability token never reaches a log line.**
 *
 * The original rule only knew about `Bearer`, and the invitation token is not
 * a Bearer credential: it is a path segment (`GET /invitations/:token`) and a
 * query parameter (`?token=`) that the access logger writes verbatim, twice per
 * request, for a token that is the entire security model of the link ("only the
 * mail recipient has this link") and that stays valid for days.
 */
describe('scrubLogLine (D-22: capability tokens)', () => {
  /** What `hono/logger` actually emits for a request, per its own source. */
  const accessLogLines = (url: string): string[] => [`<-- ${url}`, `--> ${url} 200 5ms`];

  it('removes the invitation token from a real access-log line', () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

    for (const line of accessLogLines(`/api/invitations/${token}`)) {
      const scrubbed = scrubLogLine(line);

      expect(scrubbed, line).not.toContain(token);
      expect(scrubbed).toBe(line.replace(token, '<redacted>'));
    }
  });

  it('removes a token carried as a query parameter', () => {
    const scrubbed = scrubLogLine('--> GET /api/auth/accept-invitation?token=SECRET123&next=/tasks 200 5ms');

    expect(scrubbed).not.toContain('SECRET123');
    expect(scrubbed).toBe('--> GET /api/auth/accept-invitation?token=<redacted>&next=/tasks 200 5ms');
  });

  it('covers a credential parameter nobody has written yet (the NAME is the rule)', () => {
    // The anti-coupling half: a new `?api_key=` / `?reset_token=` is scrubbed by
    // the same expression, with no edit to the scrubber.
    for (const param of ['api_key', 'reset_token', 'access_token', 'password', 'secret']) {
      expect(scrubLogLine(`GET /x?${param}=LEAKED`), param).not.toContain('LEAKED');
    }
  });

  it('leaves paths that are not capability paths fully readable', () => {
    // The scrubber must not be a blanket blinker: an ordinary id-addressed path
    // keeps its meaning in the log, or the log stops being usable for anything.
    expect(scrubLogLine('<-- GET /api/tenants/550e8400-e29b-41d4-a716-446655440099')).toBe(
      '<-- GET /api/tenants/550e8400-e29b-41d4-a716-446655440099',
    );
    expect(scrubLogLine('--> GET /api/projects/abc/tasks?page=2 200 5ms')).toBe(
      '--> GET /api/projects/abc/tasks?page=2 200 5ms',
    );
  });

  it('masks EVERY segment after a capability path, including a route name', () => {
    // The deliberate trade, asserted so it cannot be changed silently: the rule
    // is shape-blind on a capability path, because a rule that could tell a
    // token from a route name would need a list of route names that rots.
    expect(scrubLogLine('<-- GET /api/invitations/my')).toBe('<-- GET /api/invitations/<redacted>');
  });

  it('still redacts a Bearer credential that happens to sit in a query string', () => {
    // The regression this rule was written to prevent: treating the literal word
    // `Bearer` as the parameter's value would leave what FOLLOWS it in clear.
    const scrubbed = scrubLogLine('--> GET /api/tasks?token=Bearer abc.def.ghi 200 5ms');

    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).toBe('--> GET /api/tasks?token=Bearer <redacted> 200 5ms');
  });

  it('is idempotent — scrubbing a scrubbed line changes nothing', () => {
    const once = scrubLogLine('--> GET /api/invitations/abc123?token=def456 200 5ms');

    expect(scrubLogLine(once)).toBe(once);
  });
});
