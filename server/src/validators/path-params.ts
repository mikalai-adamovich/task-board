import * as z from 'zod';
import { uuid } from './uuid.js';
import { TASK_KEY_NUMBER_PATTERN } from './task-ref.js';

/**
 * Path parameter schemas.
 *
 * Before this module every `c.req.param(...)` in `server/src/routes/**` went
 * straight into a Mongo filter. Nothing rejected a `$ne` / `$gt` operator
 * payload, an over-long string or a wrong-charset string; the routes only
 * happened to answer 404 because the driver stringifies whatever it is given.
 * This registry makes "everything entering the system from outside is
 * untrusted" a type-level, test-enforced property for PATH parameters.
 *
 * The registry is deliberately keyed by PARAMETER NAME, not by route: the
 * `pathParamValidation` middleware (see `middleware/validation.ts`) resolves
 * the concrete route from `c.req.matchedRoutes`, extracts the `:names` the
 * route declares, and validates each value against `PATH_PARAM_SCHEMAS[name]`.
 * A route that declares a parameter with no registry entry is a hard build/
 * test failure (guardrail: `routes/param-validation.guardrail.test.ts`), so a
 * new route cannot silently ship an unvalidated parameter.
 *
 * NOT everything is a UUID — the three non-UUID shapes in this API are
 * modelled explicitly rather than forced through `uuid()`:
 *
 * - `key`   — a PROJECT KEY (`PROJ`, `AB12`): 2-10 chars, uppercase letter
 *             then uppercase letters/digits. Same rule as the `key` field of
 *             `CreateProjectSchema` (schemas/project.ts).
 * - `token` — an INVITATION TOKEN. Opaque by design: it is only ever hashed
 *             (SHA-256) and looked up, never parsed, so we validate its SHAPE
 *             (printable, bounded, no whitespace/control chars) rather than a
 *             format. `randomBytes(32).toString('hex')` → 64 lowercase hex
 *             chars; `randomUUID()` → a canonical UUID. Both fit, so the
 *             schema accepts the union of "lowercase hex" and "UUID" plus a
 *             conservative charset/length envelope that still rejects
 *             `$ne`-style payloads and over-long strings.
 * - `taskId` — a TASK is addressable by id OR by `KEY-NUMBER` (e.g. `PRO-1`).
 *             Every route that accepts a `:taskId` resolves BOTH forms through
 *             `TaskService.resolveTaskId`, so the union below is honoured
 *             wherever it is accepted (see `validators/task-ref.ts`).
 */

/**
 * `KEY-NUMBER` task reference, e.g. `PRO-1`.
 *
 * The pattern is imported, not restated: `task-ref.ts` holds the ONE definition
 * of this shape, and `TaskService.resolveTaskId` resolves with it. A second copy
 * of the regex here is exactly how the schema came to accept a form four routes
 * did not honour.
 */
const taskKeyNumber = () =>
  z.string().regex(TASK_KEY_NUMBER_PATTERN, 'Task key must look like KEY-NUMBER (e.g. PRO-1)');
/**
 * Opaque invitation/reset token: bounded length and a conservative charset.
 *
 * Deliberately a SHAPE check, not a format check — the value is only hashed,
 * so the server has no reason to know its structure. `$`, `.`, whitespace and
 * control characters are excluded, which is what makes a NoSQL operator
 * payload impossible to smuggle in.
 */
const opaqueToken = () =>
  z
    .string()
    .min(8, 'Token must be at least 8 characters')
    .max(128, 'Token must be at most 128 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Token must contain only letters, digits, hyphens and underscores');
/** Project key, e.g. `PROJ` (mirrors `projectKey()` in schemas/project.ts). */
const projectKey = () =>
  z
    .string()
    .min(2, 'Key must be at least 2 characters')
    .max(10, 'Key must be at most 10 characters')
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must start with a letter and contain only uppercase letters and digits');

/**
 * The single source of truth for path-parameter shapes, keyed by the parameter
 * name as it appears in the route pattern.
 *
 * Adding a new key here is what makes a new `:param` routable-and-valid; the
 * guardrail test fails if a route declares a parameter this map does not know.
 */
export const PATH_PARAM_SCHEMAS = {
  // Tenant / user / membership scope
  tenantId: uuid(),
  userId: uuid(),
  memberUserId: uuid(),
  invitationId: uuid(),

  // Project scope
  projectId: uuid(),
  key: projectKey(),

  // Entity ids
  taskId: z.union([uuid(), taskKeyNumber()], {
    error: 'Task id must be a UUID or a KEY-NUMBER reference (e.g. PRO-1)',
  }),
  commentId: uuid(),
  filterId: uuid(),
  labelId: uuid(),
  sprintId: uuid(),
  statusId: uuid(),
  taskTypeId: uuid(),
  relationshipId: uuid(),

  // Opaque token (invitation details lookup)
  token: opaqueToken(),
} as const satisfies Record<string, z.ZodType>;

/** Union of every declared path-parameter name. */
export type PathParamName = keyof typeof PATH_PARAM_SCHEMAS;

export const PATH_PARAM_NAMES = Object.keys(PATH_PARAM_SCHEMAS) as PathParamName[];

/** Resolve the schema for a path-parameter name (undefined when unknown). */
export function pathParamSchema(name: string): z.ZodType | undefined {
  return Object.prototype.hasOwnProperty.call(PATH_PARAM_SCHEMAS, name)
    ? PATH_PARAM_SCHEMAS[name as PathParamName]
    : undefined;
}
