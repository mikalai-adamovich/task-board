/**
 * The compensating security headers on the API tier.
 *
 * The authentication token lives in browser storage and the API is a DIFFERENT
 * origin from the page (the CORS middleware in `app.ts` allows that origin
 * explicitly). Nothing in the server sent a `Content-Security-Policy`,
 * `X-Frame-Options`, `Referrer-Policy` or `Strict-Transport-Security`, so if
 * script were ever injected into the page it would read a token a different
 * origin accepts, with no policy to constrain the injection.
 *
 * WHAT THIS IS NOT: it does not change where the token is stored. Moving it to
 * an `HttpOnly` cookie is a redesign with its own CSRF work and is a separate
 * owner decision — this module only adds the headers that cost one file and
 * close most of the exposure.
 *
 * ── Why Content-Security-Policy is REPORT-ONLY ───────────────────────────────
 * The policy below is shipped as `Content-Security-Policy-Report-Only`, which
 * the browser evaluates and reports on WITHOUT blocking anything. That is the
 * staged rollout the owner approved: a policy nobody has observed in
 * production is a policy that will break the application the first time it is
 * enforced (this UI is an Angular SPA with inline styles, `ng-*` bootstrapping
 * and a Milkdown editor that injects ProseMirror DOM).
 *
 * WHAT A SUBSEQUENT ENFORCING SWITCH WOULD NEED — all four, or the switch
 * trades one outage for another:
 *   1. A REPORT-ONLY PERIOD WITH SIGNAL. `report-to` (or `report-uri`) must
 *      point at an endpoint that actually collects reports; without a
 *      collector the report-only header produces no evidence at all and the
 *      switch would be a guess. No such endpoint exists in this repository
 *      today, so the header is currently inert — stated here so the gap is
 *      visible rather than implied.
 *   2. EVERY DIRECTIVE PROVEN AGAINST REAL TRAFFIC. Angular emits inline
 *      `<style>` and uses `unsafe-inline` for styles by default; the Milkdown
 *      / ProseMirror editor injects DOM the app did not author; the theme
 *      stylesheets and the icon fonts load from same-origin paths that must be
 *      spelled out. Each of those has to be observed, not assumed.
 *   3. THE `connect-src` ALLOW-LIST TO MATCH THE DEPLOYED API ORIGIN. The API
 *      is cross-origin and its URL is injected at build time
 *      (`API_URL` → `ui/src/environments/environment.prod.ts`), so the value is
 *      deployment-specific and cannot be written down in the repository.
 *   4. A ROLLBACK PATH. A single header rename
 *      (`Content-Security-Policy-Report-Only` → `Content-Security-Policy`) is
 *      the whole switch, which is exactly why it should be one deliberate,
 *      reviewed commit rather than a flag flipped on a hunch.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/context.js';

/**
 * The API serves JSON only, so its policy is the strictest one that is still
 * true: no content of any kind may be loaded or framed. It is report-only for
 * the reasons in the file header — the same reasoning as the page tier, kept
 * here so the two tiers move to enforcing together rather than one at a time.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

/**
 * The header set, as one record so the guardrail can assert the whole set
 * rather than a hand-picked few: adding a header here and forgetting the test
 * is the failure mode a name list prevents.
 *
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are
 * deliberately absent: this API is called cross-origin by design, so a
 * restrictive CORP would break the product rather than harden it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Content-Security-Policy-Report-Only': API_CSP,
});

/**
 * Set the headers on every API response, including error and not-found ones.
 *
 * Mounted FIRST (immediately after the request-id middleware, which must stay
 * first so every envelope carries a correlation id) so a response produced by
 * any later layer — a handler, `onError`, or `notFound` — already carries
 * them: `c.header()` writes into the response Hono is building, so a rejection
 * raised further down cannot escape them.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }

    await next();
  };
}
