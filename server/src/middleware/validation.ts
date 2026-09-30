import { zValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';
import { ValidationError } from './error-handler.js';
import { pathParamSchema, PATH_PARAM_NAMES } from '../validators/path-params.js';

// ─── Validation Middleware (built on @hono/zod-validator) ────────────────────

/** Zod v4 issue shape — path uses PropertyKey[] (includes symbol). */
interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
  code: string;
}

/**
 * Format Zod v4 issues into structured validation error details.
 * Zod v4 uses PropertyKey[] for path (includes symbol), so we stringify safely.
 */
function formatZodIssues(issues: ZodIssueLike[]) {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

const TARGET_MESSAGES = {
  json: 'Request body validation failed',
  query: 'Query parameter validation failed',
  param: 'Path parameter validation failed',
} as const;

/**
 * Typed request validation built on the official `@hono/zod-validator`.
 *
 * On success the parsed data is available in the handler via
 * `c.req.valid(target)` — fully typed from the schema, no casts needed.
 * On failure throws {@link ValidationError} → 400 VALIDATION_ERROR
 * (same response contract as the previous hand-rolled middleware).
 *
 * @example
 * ```ts
 * router.post('/projects/:projectId/tasks', validateBody(CreateTaskSchema), async (c) => {
 *   const body = c.req.valid('json'); // typed as z.infer<typeof CreateTaskSchema>
 * });
 * ```
 */
function validated<T extends ZodType>(target: keyof typeof TARGET_MESSAGES, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ValidationError(TARGET_MESSAGES[target], formatZodIssues(result.error.issues));
    }
  });
}

/** Validate and type the JSON request body against a Zod v4 schema. */
export function validateBody<T extends ZodType>(schema: T) {
  return validated('json', schema);
}

/** Validate and type the query parameters against a Zod v4 schema. */
export function validateQuery<T extends ZodType>(schema: T) {
  return validated('query', schema);
}

/** Validate and type the path parameters against a Zod v4 schema. */
export function validateParams<T extends ZodType>(schema: T) {
  return validated('param', schema);
}

// ─── Path Parameter Validation ──────────────────────────────────────────────────

/**
 * Split a Hono route pattern into its literal segments and `:param` names.
 *
 * `'/projects/:projectId/members/:memberUserId'` → `{ literals: ['projects'],
 * names: ['projectId', 'memberUserId'] }`. A `*` segment is a tail wildcard
 * that declares no parameter (this codebase only uses it in `use(...)`
 * patterns, which are middleware entries and never reach the handler).
 */
export function parseRoutePattern(pattern: string): { literals: string[]; names: string[] } {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  const literals: string[] = [];
  const names: string[] = [];

  for (const segment of segments) {
    if (segment === '*') {
      continue;
    }

    if (segment.startsWith(':')) {
      const name = segment.slice(1);

      if (!names.includes(name)) {
        names.push(name);
      }

      continue;
    }

    literals.push(segment);
  }

  return { literals, names };
}

/**
 * Parameter names declared by a route pattern, de-duplicated and in order.
 * Exported for the guardrail test, which asserts every declared parameter has a
 * schema in `PATH_PARAM_SCHEMAS` and is read through `param()`.
 */
export function routeParamNames(pattern: string): string[] {
  return parseRoutePattern(pattern).names;
}

/**
 * The concrete (non-middleware) route Hono matched for this request.
 *
 * `c.req.matchedRoutes` is the only place a `use('*')` middleware can learn
 * WHICH route it is guarding: `c.req.param()` is resolved lazily from
 * `routeIndex`, which at middleware level still points at the middleware
 * itself, so it returns `{}`. The matched route list, by contrast, is fully
 * populated before any handler runs.
 *
 * The concrete route is the first entry that is not a middleware (`ALL`
 * registered via `use`) — middleware entries must be skipped, otherwise
 * `/api/tenants/slug-available` would be validated against the `*` pattern
 * of the guard itself.
 */
function concreteRoute(c: { req: { matchedRoutes: readonly { method: string; path: string }[] } }) {
  return c.req.matchedRoutes.find((route) => route.method !== 'ALL');
}

/**
 * Extract the declared path-parameter values for a matched route.
 *
 * WHY NOT `c.req.param()`: Hono resolves params from
 * `#matchResult[0][routeIndex]`, and at `use('*')` level `routeIndex` still
 * points at the middleware's own entry — so `c.req.param()` is `{}` there
 * (verified against hono 4.13.5). The matched route list IS populated, so the
 * values are recovered by aligning the request path with the route pattern:
 * literal segments must match exactly, each `:name` consumes one non-empty
 * path segment. Segment values are percent-decoded exactly like Hono does it
 * (`tryDecodeURIComponent`), so a `%24ne` payload is validated in its decoded
 * form — the same string the handler would otherwise have used.
 *
 * Returns `null` when the alignment fails (should not happen: Hono already
 * matched this pattern) — the caller then leaves the request alone rather than
 * rejecting a request on a guess.
 */
export function extractPathParams(pattern: string, requestPath: string): Record<string, string> | null {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  // A trailing `*` matches the remainder of the path (possibly empty).
  const tailWildcard = segments.at(-1) === '*';
  const expected = tailWildcard ? segments.slice(0, -1) : segments;
  const actual = requestPath.split('/').filter((segment) => segment.length > 0);

  if (actual.length !== expected.length) {
    return null;
  }

  const values: Record<string, string> = {};

  for (const [index, segment] of expected.entries()) {
    const value = actual[index];

    if (value === undefined) {
      return null;
    }

    if (segment === '*') {
      continue;
    }

    if (segment.startsWith(':')) {
      values[segment.slice(1)] = tryDecode(value);

      continue;
    }

    if (segment !== value) {
      return null;
    }
  }

  return values;
}

/** Percent-decode like Hono: a malformed sequence falls back to the raw value. */
function tryDecode(value: string): string {
  if (!value.includes('%')) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Validate every path parameter of the matched route before its handler
 * runs, using the per-name schemas in `validators/path-params.ts`.
 *
 * WHY MIDDLEWARE AND NOT PER-ROUTE `validateParams(...)`:
 * 62 path parameters over 48 routes used to reach Mongo unvalidated. Wiring
 * `validateParams` into each handler is a 62-call change that a NEW route can
 * silently forget — exactly the regression this task must make impossible. A
 * single `router.use('*', pathParamValidation())` inside each route factory
 * makes validation the DEFAULT: a route inherits it by construction, and the
 * guardrail test fails the build if a route declares a `:param` with no schema.
 *
 * Failure contract: identical to the body/query path — `ValidationError` →
 * `errorHandler` → 400 with `{ error: { code: 'VALIDATION_ERROR', message,
 * details, requestId } }`.
 *
 * Unmatched paths (404/405) are left alone: there is no concrete route, hence
 * no declared parameters, and `not-found.ts` owns that response.
 */
export function pathParamValidation(): MiddlewareHandler {
  return async (c, next) => {
    const route = concreteRoute(c);

    if (route === undefined) {
      await next();

      return;
    }

    const declared = routeParamNames(route.path);
    const raw = extractPathParams(route.path, c.req.path);

    if (raw === null) {
      await next();

      return;
    }

    const issues: { path: string; message: string; code: string }[] = [];

    for (const name of declared) {
      const schema = pathParamSchema(name);

      // A declared parameter with no registered schema is a programming error.
      // Fail loudly (500) rather than letting an unvalidated value through —
      // the guardrail test is expected to catch this long before runtime.
      if (schema === undefined) {
        throw new Error(
          `No path-parameter schema registered for ':${name}' (route ${route.method} ${route.path}). ` +
            'Add it to PATH_PARAM_SCHEMAS in server/src/validators/path-params.ts.',
        );
      }

      const result = schema.safeParse(raw[name]);

      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ path: name, message: issue.message, code: issue.code });
        }
      }
    }

    if (issues.length > 0) {
      throw new ValidationError('Path parameter validation failed', issues);
    }

    await next();
  };
}

/**
 * Read a validated path parameter.
 *
 * Route handlers MUST use this instead of `c.req.param(...)`: the guardrail
 * test fails the build on a bare `c.req.param(` in `server/src/routes/**`.
 * The value was already parsed by {@link pathParamValidation}; this accessor
 * exists so the "validated, not raw" contract is visible at every call site
 * and so a missing parameter fails loudly instead of yielding `undefined`.
 */
export function param<K extends string>(c: { req: { param(key: K): string } }, name: K): string {
  const value = c.req.param(name);

  if (value === undefined) {
    throw new ValidationError(`Path parameter validation failed`, [
      { path: name, message: 'Path parameter is missing', code: 'invalid_type' },
    ]);
  }

  return value;
}

/** Every registered path-parameter name — re-exported for the guardrail test. */
export { PATH_PARAM_NAMES };
