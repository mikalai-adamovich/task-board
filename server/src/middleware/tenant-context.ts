import * as z from 'zod';
import { createMiddleware } from 'hono/factory';
import { MemberStatus, TenantRole } from '@task-board/shared';
import type { TenantMember } from '@task-board/shared';
import { ForbiddenError, ValidationError } from './error-handler.js';
import { getCollection } from '../db/mongo.js';
import type { TenantMemberDocument } from '../repositories/tenant-member.repository.js';
import type { AppEnv } from '../types/context.js';
import { isTenantAdmin } from '../services/rbac.service.js';
import { uuid, slug } from '../validators/common.js';

// ─── Document Shapes ─────────────────────────────────────────────────────────

interface ProjectMemberDocument {
  userId: string;
  projectId: string;
  role: string;
}

/**
 * Matches project-scoped request paths and captures the projectId:
 * `/api/projects/:projectId` and any sub-resource
 * (`/api/projects/:projectId/tasks`, `/statuses`, `/sprints`, …).
 * Routes that address a resource by its own id (`/tasks/:taskId`,
 * `/statuses/:statusId`, …) do NOT match — those enforce permissions at the
 * service layer after resolving the owning project (see task/status/sprint services).
 */
const PROJECT_PATH_PATTERN = /^\/api\/projects\/([^/]+)(?:\/|$)/;
/** Matches a canonical tenant id (UUID) — anything else is treated as a slug. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The shapes `X-Tenant-Id` may take — the SAME two `resolveTenantMembership`
 * understands, expressed with the shared validators every path parameter uses.
 * Stated as a union of the two shapes rather than a list of values, so a future
 * tenant-id format is judged by the same rule.
 */
const TENANT_REF_SCHEMA = z.union([uuid(), slug()]);
/**
 * The ONE answer for "you may not use this tenant" — given for an unknown
 * tenant and for a known one the caller does not belong to alike, so the header
 * cannot be used to enumerate which workspace slugs exist.
 */
const TENANT_ACCESS_DENIED = 'You are not a member of this tenant';

// ─── Tenant Context Middleware ────────────────────────────────────────────────

/**
 * Hono middleware that resolves the active tenant context.
 *
 * 1. Reads the `X-Tenant-Id` header. The value may be a tenant **id** or a
 *    tenant **slug**: if a membership exists for the raw value it is
 *    used directly (id path, backward compatible); otherwise the value is
 *    resolved as a slug to its tenant id.
 * 2. Validates the authenticated user has an ACTIVE membership in that tenant.
 * 3. Rejects ACCESS_REVOKED members with 403.
 * 4. Sets `tenantId` and `tenantRole` on the context.
 *
 * Error responses:
 * - 400 VALIDATION_ERROR if `X-Tenant-Id` header is missing
 * - 403 FORBIDDEN if the user is not a member, or membership is ACCESS_REVOKED
 *
 * This middleware should be applied per-route, not globally,
 * so that auth and invitation routes can skip it.
 */
/**
 * Resolve the membership document for `userId` in the tenant referenced by
 * `tenantRef` (id or slug). Exported so the auth middleware can start this
 * lookup IN PARALLEL with the user lookup (they are independent: membership
 * needs only the JWT `sub` claim, not the user document).
 */
export async function resolveTenantMembership(userId: string, tenantRef: string): Promise<TenantMemberDocument | null> {
  const tenantMembers = getCollection<TenantMemberDocument>('tenant_members');

  if (UUID_PATTERN.test(tenantRef)) {
    // Id path — a UUID can never be a slug, so a single lookup suffices.
    return tenantMembers.findOne({ userId, tenantId: tenantRef });
  }

  // Slug path: probe the raw value as an id (backward compatible with
  // legacy non-UUID ids) and resolve the slug CONCURRENTLY — one parallel
  // round-trip instead of two sequential ones. The membership query for the
  // resolved tenant id is inherently dependent and stays sequential.
  const tenants = getCollection<{ id: string; slug: string }>('tenants');
  const [byRef, tenant] = await Promise.all([
    tenantMembers.findOne({ userId, tenantId: tenantRef }),
    tenants.findOne({ slug: tenantRef }),
  ]);

  if (byRef) return byRef;
  if (tenant) return tenantMembers.findOne({ userId, tenantId: tenant.id });
  return null;
}

export const tenantContextMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const tenantRef = c.req.header('X-Tenant-Id');

  if (!tenantRef) {
    throw new ValidationError('Missing X-Tenant-Id header');
  }

  // `X-Tenant-Id` was the only externally-supplied value that crossed NO
  // schema boundary — every path parameter is parsed by `pathParamValidation`
  // first, while this header went straight into two indexed queries as an
  // arbitrary, unbounded, unnormalised string. A malformed value is now a 400
  // here, not a 403 ten lines later.
  const parsed = TENANT_REF_SCHEMA.safeParse(tenantRef);

  if (!parsed.success) {
    throw new ValidationError('Invalid X-Tenant-Id header', parsed.error.issues);
  }

  const userId = c.get('userId');

  if (!userId) {
    throw new ForbiddenError('Authentication required for tenant context');
  }

  // The auth middleware may have already resolved the membership in parallel
  // with the user lookup (they are independent). Reuse it; otherwise resolve
  // here (standalone invocation / direct service calls).
  let membership: TenantMemberDocument | null | undefined = c.get('tenantMembershipDoc');

  if (membership === undefined) {
    membership = await resolveTenantMembership(userId, tenantRef);
  }

  if (!membership) {
    // The shared message is deliberate — an unknown tenant and a known one
    // the caller is not a member of must be indistinguishable, or the header
    // becomes a workspace-slug enumeration oracle.
    throw new ForbiddenError(TENANT_ACCESS_DENIED);
  }

  // DEC-055 lazy revoke: an ACTIVE membership past its expiration is treated
  // as ACCESS_REVOKED at access time (no cron on Workers).
  const expiresAtMs = membership.expiresAt ? new Date(membership.expiresAt).getTime() : null;

  if (membership.status === MemberStatus.ACTIVE && expiresAtMs !== null && expiresAtMs <= Date.now()) {
    // Best-effort: flip the stored status so the members list reflects it too
    await getCollection<TenantMemberDocument>('tenant_members').updateOne(
      { userId, tenantId: membership.tenantId },
      { $set: { status: MemberStatus.ACCESS_REVOKED, updatedAt: new Date() } },
    );
    throw new ForbiddenError('Your membership has expired');
  }

  // Check membership status — only ACTIVE and ACCESS_REVOKED per v5 spec
  if (membership.status === MemberStatus.ACCESS_REVOKED) {
    throw new ForbiddenError('Your access to this tenant has been revoked');
  }

  if (membership.status !== MemberStatus.ACTIVE) {
    throw new ForbiddenError('Your membership is not active');
  }

  // Set tenant context for downstream handlers. The resolved membership is
  // shared with services so requireMembership() does not repeat the query.
  // (Local mapping — the middleware's document may be a partial projection;
  // services only consume role/status/userId/tenantId from it.)
  const now = new Date().toISOString();
  const membershipDomain: TenantMember = {
    id: membership.id ?? '',
    tenantId: membership.tenantId,
    userId: membership.userId,
    role: membership.role as TenantMember['role'],
    status: membership.status as TenantMember['status'],
    expiresAt: membership.expiresAt ? new Date(membership.expiresAt).toISOString() : null,
    invitation: null,
    displayName: null,
    email: null,
    createdAt: membership.createdAt ? new Date(membership.createdAt).toISOString() : now,
    updatedAt: membership.updatedAt ? new Date(membership.updatedAt).toISOString() : now,
  };

  c.set('tenantMembership', membershipDomain);
  c.set('tenantId', membership.tenantId);
  c.set('tenantRole', membership.role as TenantRole);

  // V2-4: populate the caller's project role for project-scoped requests so
  // requirePermission(action, true) / ensurePermission() see the real role.
  // Tenant Owner/Admin bypass happens inside the RBAC matrix, so no special
  // casing here — but we can skip the lookup entirely for them.
  //
  // The lookup used to be restricted to non-GET/HEAD requests
  // (F3 "perf audit #2"), on the assumption that no read route consumes
  // `projectRole`. That assumption is now known to be false: `GET
  // /projects/:projectId/audit` gates on `requirePermission('view_audit_events',
  // true)`, so on a GET the project-level permission was ALWAYS evaluated with
  // `projectRole === null` — i.e. "tenant OWNER/ADMIN only", silently. Reads and
  // writes must see the same authorization context, so GET/HEAD are treated like
  // every other verb.
  //
  // Behavioural consequence (intended): a tenant MEMBER who is a PROJECT_ADMIN of
  // the project now passes `view_audit_events` and can read that project's audit
  // log. A tenant MEMBER who is NOT a project member is still denied (403), and
  // the tenant-wide `/tenants/:tenantId/audit` route is unaffected (it passes
  // `projectLevel = false` and has no project in the path).
  //
  // Cost: one indexed `project_members.findOne({ userId, projectId })` per
  // project-scoped GET for tenant MEMBERs. The tenant OWNER/ADMIN shortcut below
  // is unchanged, so admin traffic pays nothing.
  const tenantRole = membership.role as TenantRole;

  // The last ad-hoc allow-list on a request path outside the services. It
  // asks the same question the matrix answers — "is this tenant role one that
  // bypasses project-level checks?" — and it gates a pure optimisation: tenant
  // admins skip the `project_members` lookup because the matrix would ignore the
  // project role anyway. Answering it from the matrix keeps the bypass rule in
  // ONE place, so a change to `manage_tenant` cannot leave this lookup firing (or
  // wrongly skipping) for a role the matrix no longer exempts.
  if (!isTenantAdmin(tenantRole)) {
    const projectMatch = PROJECT_PATH_PATTERN.exec(c.req.path);

    if (projectMatch) {
      // `noUncheckedIndexedAccess` types the capture group as
      // `string | undefined`. Under `exactOptionalPropertyTypes` that no longer
      // silently becomes `{ userId, projectId: undefined }` — and it must not:
      // in MongoDB a filter on `projectId: undefined` matches documents where
      // the field is MISSING or null, i.e. it would match the membership row of
      // an unrelated project and grant the wrong `projectRole`. Bail out unless
      // the capture really produced a project id.
      const projectId = projectMatch[1];

      if (!projectId) {
        throw new ValidationError('Malformed project path');
      }

      const projectMembers = getCollection<ProjectMemberDocument>('project_members');
      const projectMembership = await projectMembers.findOne({ userId, projectId });

      if (projectMembership) {
        c.set('projectRole', projectMembership.role as AppEnv['Variables']['projectRole']);
      }
    }
  }

  await next();
});
