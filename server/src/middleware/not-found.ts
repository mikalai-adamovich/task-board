import type { NotFoundHandler } from 'hono';
import type { RouterRoute } from 'hono/types';
import type { AppEnv } from '../types/context.js';

/**
 * Router-level 404 / 405 handler.
 *
 * Hono's default `notFound` returns a bare `text/plain` "404 Not Found", and a
 * request whose METHOD does not match a registered path falls through to the
 * very same handler (Hono has no built-in 405). That is the only class of
 * response in the whole API that escaped the documented envelope
 * `{ error: { code, message, requestId } }` — in production, 29 of 213 probe
 * responses carried no envelope at all, and the UI surfaces the raw text
 * verbatim in the support form's error alert.
 *
 * Registered on the app so that EVERY response — including unmatched routes and
 * unmatched methods — uses the standard envelope, with the request id attached
 * (correlation id, already set by `requestIdMiddleware` before we get here).
 *
 * The three 404/405 shapes stay distinguishable, which is what clients and the
 * UI actually key off:
 * - **unknown path** → 404 `NOT_FOUND`, generic router message
 * - **wrong method on a known path** → 405 `METHOD_NOT_ALLOWED` + `Allow` header
 * - **404 raised inside a route** → never reaches this handler at all: the
 *   route throws `NotFoundError`, which `app.onError(errorHandler)` renders as
 *   404 `NOT_FOUND` with the domain-specific message ("Sprint x not found").
 */

/**
 * Compile a Hono route pattern (`/projects/:projectId/tasks`, `/files/*`) into a
 * RegExp matching a concrete request path.
 *
 * Only the two wildcard forms this codebase actually uses are supported:
 * `:param` (one path segment) and `*` (any remainder). Anything else is escaped
 * literally, so a pattern can never be interpreted as a regex.
 */
export function routePatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';

      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  return new RegExp(`^${source}/?$`);
}

/**
 * Methods registered for `path`, excluding the method of the current request
 * and excluding `ALL` entries (middleware registered via `app.use` is not an
 * endpoint and must never turn a 404 into a 405).
 */
export function findAllowedMethods(routes: readonly RouterRoute[], path: string, currentMethod: string): string[] {
  const allowed = new Set<string>();

  for (const route of routes) {
    if (route.method === 'ALL' || route.method === currentMethod) continue;
    if (!routePatternToRegExp(route.path).test(path)) continue;

    allowed.add(route.method);
  }

  return [...allowed].sort();
}

/**
 * Build the app's `notFound` handler.
 *
 * Takes the app (not the route list) so the table is read lazily at request
 * time — routes are still being registered while this module is evaluated.
 */
export function createNotFoundHandler(getRoutes: () => readonly RouterRoute[]): NotFoundHandler<AppEnv> {
  return (c) => {
    const requestId = c.get('requestId') as string | undefined;
    const withRequestId = requestId === undefined ? {} : { requestId };
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const allowed = findAllowedMethods(getRoutes(), path, method);

    if (allowed.length > 0) {
      // Hono treats "no route matched this method" as a 404; RFC 9110 §15.5.6
      // says a known path with an unsupported method is a 405 and the `Allow`
      // header MUST list what is supported.
      c.header('Allow', [...allowed, method].join(', '));

      return c.json(
        {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `Method ${method} is not allowed for ${path}`,
            ...withRequestId,
          },
        },
        405,
      );
    }

    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          ...withRequestId,
        },
      },
      404,
    );
  };
}
