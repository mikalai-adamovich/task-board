/**
 * Rate limiting for the login path and for authenticated routes.
 *
 * Two independent mechanisms, one shared implementation:
 * - {@link clientIdentifier} — the client identifier used by the login limiters
 *   in `services/auth.service.ts` (and by the register / forgot-password ones).
 * - {@link authRateLimit} — the generic per-USER ceiling mounted as middleware
 *   for every authenticated route (see `app.ts`), so a new route inherits it by
 *   construction instead of having to remember it.
 */
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors/app-error.js';
import { buildRateLimitHeaders, createRateLimiter, type RateLimitResult } from '../utils/rate-limiter.js';
import type { AppEnv } from '../types/context.js';

// ─── Client identifier ────────────────────────────────────────────────────────

/**
 * Fallback bucket for requests that arrive without a Cloudflare edge identifier
 * (a non-Workers runtime, a direct origin hit, a test harness). It is
 * deliberately COARSE — one shared bucket — so the ceiling still applies instead
 * of silently disabling itself. See {@link clientIdentifier}.
 */
export const UNKNOWN_CLIENT_ID = 'unknown';

/**
 * Resolve the client identifier used as a rate-limit key.
 *
 * **Which header and why it is not client-spoofable: `CF-Connecting-IP`.**
 * Cloudflare's edge overwrites this header on every proxied request — a client
 * that sends its own `CF-Connecting-IP` (or a chain of `X-Forwarded-For`) has
 * its value replaced before the Worker ever sees it. That is exactly the property
 * a rate-limit key needs and the reason `X-Forwarded-For` is NOT used here: it
 * is a plain request header, fully controlled by whoever sends the request, so
 * keying on it would let an attacker mint a fresh budget per request by varying
 * it.
 *
 * **Trust boundary (stated, not hidden).** This is trustworthy *because the
 * deployment is fronted by Cloudflare's edge* — a Worker route is only reachable
 * through the edge, and the edge is what sets the header. If the API were ever
 * exposed directly (bypassing Cloudflare), the header could be forged and the
 * per-source ceiling would become per-attacker-chosen-key again. The mitigation
 * is deployment-level (do not expose the origin), and the failure mode is a
 * return to today's behaviour, not a crash or a lockout.
 *
 * Requests without the header fall into ONE shared {@link UNKNOWN_CLIENT_ID}
 * bucket rather than a client-chosen one: an attacker cannot opt out of the
 * ceiling by omitting the header, they can only join everyone else who omitted
 * it. The trade-off is that a runtime which never sets the header throttles all
 * of its users together — the coarser, safer direction to fail in.
 */
export function clientIdentifier(c: { req: { header(name: string): string | undefined } }): string {
  const edgeIp = c.req.header('CF-Connecting-IP')?.trim();

  return edgeIp === undefined || edgeIp === '' ? UNKNOWN_CLIENT_ID : edgeIp;
}

// ─── Authenticated-route limiter ──────────────────────────────────────────────

/**
 * Per-user ceiling for authenticated routes: {@link AUTH_MAX_REQUESTS} requests
 * per {@link AUTH_WINDOW_MS}.
 *
 * VALUE DERIVED FROM THE UI'S ACTUAL REQUEST PATTERN (measured by reading the
 * `rxResource`/`httpResource` call sites per page):
 *
 * | Page / interaction                | Requests | Notes                                        |
 * | --------------------------------- | -------- | -------------------------------------------- |
 * | Cold load (bootstrap + shell)     | ~3       | `/auth/bootstrap`, preferences, tenants      |
 * | Project overview                  | ~7       | project, status-summary, recent tasks, refs  |
 * | Board                             | ~6       | board config, column pages, 4 ref kinds       |
 * | Task table                        | ~7       | task page, 5 ref kinds, saved filters         |
 * | Free-text search (worst case)     | 3.3/s    | 300 ms debounce → 1 request per pause        |
 * | Board "load more"                 | 1/batch  | micro-batched across hungry columns          |
 *
 * A human flipping pages and typing in the search box peaks around 120-180
 * requests/minute. 300/minute leaves roughly 2× headroom over that peak while
 * still capping a flooding client at 5 req/s — enough to stop invitation e-mail
 * floods, audit-log floods and search hammering, which is the point of the per-user limiter.
 */
export const AUTH_MAX_REQUESTS = 300;
export const AUTH_WINDOW_MS = 60 * 1000;

/** Module-level so the budget spans requests (see `utils/rate-limiter.ts`). */
const authLimiter = createRateLimiter(AUTH_MAX_REQUESTS, AUTH_WINDOW_MS);
/**
 * Paths that must never be throttled: liveness / readiness probes, the no-DB
 * ping, and CORS preflights. They are cheap, unauthenticated-by-nature and
 * polled by infrastructure — a 429 there would look like an outage.
 */
const EXEMPT_PATHS: readonly string[] = ['/api/health', '/api/ping', '/api/readyz'];

/** True when `path` is exempt from the authenticated limiter. */
export function isRateLimitExempt(path: string, method: string): boolean {
  return method === 'OPTIONS' || EXEMPT_PATHS.includes(path);
}

/**
 * Per-user rate limiting for authenticated routes, mounted ONCE in `app.ts`
 * right after `authMiddleware`.
 *
 * WHY MIDDLEWARE AND NOT PER-HANDLER: a limiter added inside each handler is one
 * a new route can silently forget — the exact regression this middleware exists to prevent. Mounting
 * it once after authentication makes the ceiling the DEFAULT: every route
 * inherits it, and the key comes from the token-verified `userId` that
 * `authMiddleware` just set (`c.set('userId', payload.sub)`), never from
 * anything the client can choose. A stolen token is throttled exactly like the
 * account it belongs to; a client cannot opt out by sending a different header.
 *
 * Failure contract: {@link AppError} 429 `RATE_LIMITED` → `errorHandler` renders
 * `{ error: { code, message, requestId } }` and applies the `Retry-After` /
 * `RateLimit-*` headers from F6's shared builder.
 */
export function authRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isRateLimitExempt(c.req.path, c.req.method)) {
      await next();

      return;
    }

    const userId = c.get('userId');

    // Mounted after authMiddleware, so `userId` is always set here. Guard anyway
    // — and FAIL CLOSED. A missing key means the chain is mis-ordered (or a new
    // route was mounted above `authMiddleware`), and the two "safe" fallbacks are
    // both wrong:
    //
    //  - passing the request through uncounted removes the per-user ceiling
    //    entirely, which is the exact regression the per-user limiter exists to prevent; the old
    //    code did this and its own comment said it should not;
    //  - keying on a shared anonymous bucket would let one misconfigured request
    //    throttle every other un-keyed caller, converting a bug into an outage.
    //
    // Rejecting is the only branch that is loud: the misconfiguration becomes a
    // 429 in production and a red test here, instead of a silently absent control.
    // The liveness paths above are exempt BEFORE this check, so a probe stays
    // reachable even in the broken configuration.
    if (userId === undefined) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Rate limiter is not keyed: the request carries no authenticated user id.',
        undefined,
        buildRateLimitHeaders(AUTH_MAX_REQUESTS, {
          limited: true,
          // A missing key is the caller over the limiter's own budget in the
          // strictest sense: there is nothing to count against.
          outcome: 'limited',
          remaining: 0,
          retryAfterSeconds: 1,
        }),
      );
    }

    const result: RateLimitResult = authLimiter(userId);

    if (result.limited) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        undefined,
        buildRateLimitHeaders(AUTH_MAX_REQUESTS, result),
      );
    }

    await next();
  };
}

/** Test seam: current number of tracked users (eviction test). */
export function authLimiterSize(): number {
  return authLimiter.size();
}
