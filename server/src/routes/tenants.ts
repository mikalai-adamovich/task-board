import { Hono } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody, validateQuery } from '../middleware/validation.js';
import {
  CreateTenantSchema,
  UpdateTenantSchema,
  InviteMemberSchema,
  UpdateMemberSchema,
  SlugAvailableQuerySchema,
} from '../schemas/tenant.js';

// ─── Tenant Routes ───────────────────────────────────────────────────────────

export function createTenantRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  // ─── Tenant CRUD ────────────────────────────────────────────────────────

  router.get('/', async (c) => {
    const userId = c.get('userId');
    const tenants = await c.get('svc').tenants.listTenantsWithRole(userId);

    return c.json({ data: tenants });
  });

  router.post('/', validateBody(CreateTenantSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const tenant = await c.get('svc').tenants.createTenant(userId, body);

    return c.json({ data: tenant }, 201);
  });

  // Slug availability check — enumeration-safe: only a boolean,
  // no distinction between invalid format and taken.
  // Must be registered before /:tenantId.
  router.get('/slug-available', validateQuery(SlugAvailableQuerySchema), async (c) => {
    const { slug } = c.req.valid('query');
    const available = await c.get('svc').tenants.isSlugAvailable(slug);

    return c.json({ data: { available } });
  });

  router.get('/:tenantId', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    // Membership check inside the service (IDOR guard)
    const tenant = await c.get('svc').tenants.getTenantForUser(userId, tenantId);

    return c.json({ data: tenant });
  });

  router.patch('/:tenantId', validateBody(UpdateTenantSchema), async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const body = c.req.valid('json');
    const tenant = await c.get('svc').tenants.updateTenant(userId, tenantId, body, c.get('tenantMembership'));

    return c.json({ data: tenant });
  });

  // ─── Tenant Lifecycle ───────────────────────────────────────────────────

  router.delete('/:tenantId', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');

    await c.get('svc').tenants.deleteTenant(userId, tenantId, c.get('tenantMembership'));

    return c.json({ data: { success: true } });
  });

  router.post('/:tenantId/archive', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');

    await c.get('svc').tenants.archiveTenant(userId, tenantId, c.get('tenantMembership'));

    return c.json({ data: { success: true } });
  });

  router.post('/:tenantId/restore', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');

    await c.get('svc').tenants.restoreTenant(userId, tenantId, c.get('tenantMembership'));

    return c.json({ data: { success: true } });
  });

  router.post('/:tenantId/cancel-deletion', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');

    await c.get('svc').tenants.cancelDeletion(userId, tenantId, c.get('tenantMembership'));

    return c.json({ data: { success: true } });
  });

  // ─── Member Management ─────────────────────────────────────────────────

  router.get('/:tenantId/members', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    // Membership check inside the service (IDOR guard)
    const members = await c.get('svc').tenantMembers.getTenantMembers(userId, tenantId, c.get('tenantMembership'));

    return c.json({ data: members });
  });

  router.post('/:tenantId/members/invite', validateBody(InviteMemberSchema), async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const body = c.req.valid('json');
    const member = await c.get('svc').tenantMembers.inviteUser(userId, tenantId, body.email, body.role);

    return c.json({ data: member }, 201);
  });

  // Full member update — role, expiration date and the underlying
  // user's profile (name/email). All fields optional.
  router.patch('/:tenantId/members/:memberUserId', validateBody(UpdateMemberSchema), async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');
    const body = c.req.valid('json');
    const member = await c.get('svc').tenantMembers.updateMember(userId, tenantId, memberUserId, body);

    return c.json({ data: member });
  });

  router.delete('/:tenantId/members/:memberUserId', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.removeMember(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  // ── V2-7: full membership lifecycle. All member-scoped routes address the
  // target by userId (:memberUserId); services resolve the membership document.

  /** Revoke ACTIVE access (member keeps their membership record, status → ACCESS_REVOKED). */
  router.patch('/:tenantId/members/:memberUserId/revoke', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.revokeAccess(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  /** Restore a revoked membership (rejects PENDING invitations). */
  router.post('/:tenantId/members/:memberUserId/restore', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.restoreMembership(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  /** Reinvite (rotate token + resend email; membership stays ACCESS_REVOKED until accepted). */
  router.post('/:tenantId/members/:memberUserId/reinvite', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.reinviteUser(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  /** Resend — alias of reinvite for pending invitations (what the UI calls). */
  router.patch('/:tenantId/members/:memberUserId/resend', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.reinviteUser(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  /** Revoke a PENDING invitation without deleting the membership record. */
  router.post('/:tenantId/members/:memberUserId/invitation/revoke', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.revokeInvitation(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  /** Permanently remove the membership record. */
  router.delete('/:tenantId/members/:memberUserId/hard', async (c) => {
    const userId = c.get('userId');
    const tenantId = param(c, 'tenantId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').tenantMembers.hardDeleteMember(userId, tenantId, memberUserId);

    return c.json({ data: { success: true } });
  });

  // ─── User Deletion (admin only) ──────────────────────────────────────────

  router.delete('/users/:userId', async (c) => {
    const requesterId = c.get('userId');
    const userId = param(c, 'userId');

    await c.get('svc').tenants.deleteUser(requesterId, userId);

    return c.json({ data: { success: true } });
  });

  return router;
}
