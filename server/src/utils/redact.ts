/**
 * Scrub credentials from log output.
 *
 * `hono/logger` prints one line per log entry (`<-- GET /path?query`,
 * `--> GET /path?query 200 5ms`) and the path it prints is the FULL path
 * including the query string. It does not print headers today, but any token
 * that ever reaches a log line — query string, future header logging, an error
 * message that quotes the url — must never appear in cleartext.
 *
 * Two classes are scrubbed, both because they are BEARERS of the thing they
 * name rather than identifiers of a user:
 *
 * 1. `Authorization: Bearer …` headers (the original case);
 * 2. **capability tokens** — the invitation token is the whole security model
 *    of `GET /invitations/:token` ("only the mail recipient has this link"),
 *    it is valid for days, and it was written to the access log in cleartext on
 *    every lookup, twice per request. A log line is durable, widely readable
 *    and routinely shipped off-box, so a token in a log is a token in
 *    everyone's hands.
 *
 * The rules are stated as PATTERNS, not as a list of routes: a new
 * capability-bearing path is covered by the same expression, with no edit here.
 */

/** Path segments that carry a bearer value rather than identifying a resource. */
const CAPABILITY_PATHS = 'invitations';
/**
 * `?token=…`, `&token=…`, `?invitationToken=…` … — the parameter NAME, not its
 * value, so a new parameter carrying a credential is covered with no edit here.
 *
 * The `(?!Bearer\s)` guard matters: `?token=Bearer abc.def` is an Authorization
 * header that happens to sit in a query string. Matching the literal word
 * `Bearer` as this parameter's value would replace only the word and leave the
 * credential that FOLLOWS it in the clear — which is exactly what the Bearer
 * rule exists to remove. So that shape is left to the Bearer rule.
 */
const TOKEN_PARAM =
  /\b(token|access_token|invitation_token|reset_token|api_key|apikey|secret|password)\s*=\s*(?:(?!Bearer\s)[^&\s"'`])+/gi;

export function redactAuthorization(str: string): string {
  return scrubLogLine(str);
}

/**
 * The single entry point every log line passes through.
 *
 * Exported under its own name because the property is about the LINE, not
 * about the authorization header: a future sink (audit, error report, a
 * metrics label) should call this rather than re-derive a redaction.
 */
export function scrubLogLine(str: string): string {
  const withoutBearer = str.replace(/Bearer\s+[^\s,"']+/gi, 'Bearer <redacted>');
  const withoutTokenParams = withoutBearer.replace(TOKEN_PARAM, '$1=<redacted>');
  // `/invitations/<token>` — the segment after the capability path is the secret,
  // whatever it looks like. Deliberately SHAPE-BLIND: on a capability path every
  // segment is assumed to be a secret, so the listing route `/invitations/my`
  // also logs as `/invitations/<redacted>`. That is the trade, taken in the safe
  // direction — a rule that could tell a token from a route name would have to
  // know the route names, and the list would rot exactly when a new one is
  // added. Paths that are not capability paths keep their full meaning.
  const withoutCapabilityPath = withoutTokenParams.replace(
    new RegExp(`(/\\b${CAPABILITY_PATHS}\\b/)([^/?#\\s"'\`]+)`, 'gi'),
    '$1<redacted>',
  );

  return withoutCapabilityPath;
}
