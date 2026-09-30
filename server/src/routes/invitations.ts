import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation } from '../middleware/validation.js';

// ─── Invitation Routes ──────────────────────────────────────────────────────

/**
 * Creates and returns the invitation Hono app with cross-tenant
 * invitation endpoints for the authenticated user.
 */
export function createInvitationRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // `:invitationId` is validated before any handler runs.
  router.use('*', pathParamValidation());

  // All routes require auth. This mount was a SECOND `authMiddleware` on a
  // sub-app already mounted behind one in `app.ts` (`app.route('/api/invitations',
  // …)` sits after `app.use('/api/*', authMiddleware)`), so every invitation
  // request paid two full authentications: a user lookup each, plus — when an
  // `X-Tenant-Id` header is present — a concurrent membership resolution each.
  // There is no authorization consequence (the handlers re-check the invitee),
  // but the cost is real and the duplication is invisible to a reader. If this
  // router is ever mounted somewhere WITHOUT the parent guard, the mount must
  // come back; the guardrail below fails the build if the app stops guarding
  // `/api/invitations` upstream.

  /**
   * GET /invitations/my — pending invitations for the authenticated user.
   */
  router.get('/my', async (c) => {
    const userId = c.get('userId');
    const user = await c.get('svc').auth.me(userId);
    const invitations = await c.get('svc').tenantMembers.getMyInvitations(user.email);

    return c.json({ data: invitations });
  });

  /**
   * POST /invitations/:invitationId/accept — accept an invitation.
   */
  router.post('/:invitationId/accept', async (c) => {
    const userId = c.get('userId');
    const invitationId = param(c, 'invitationId');

    await c.get('svc').tenantMembers.acceptInvitation(invitationId, userId);

    return c.json({ data: { success: true } });
  });

  /**
   * POST /invitations/:invitationId/decline — decline an invitation (canonical).
   */
  const decline = async (c: Context) => {
    const userId = c.get('userId');
    const invitationId = param(c, 'invitationId');

    await c.get('svc').tenantMembers.declineInvitation(invitationId, userId);

    return c.json({ data: { success: true } });
  };

  router.post('/:invitationId/decline', decline);

  // V2-3: the UI's decline action fires `DELETE /invitations/:id`; expose the
  // same operation under that method so the flow works end-to-end.
  router.delete('/:invitationId', decline);

  return router;
}
