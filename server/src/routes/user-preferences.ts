import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { UpdateUserGlobalSettingsSchema, UpdateUserProjectBoardPreferenceSchema } from '../schemas/user-preferences.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * The caller context is derived from the request context, never from the
 * path or the body.
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

// ─── User Preferences Routes ─────────────────────────────────────────────────

/**
 * User-level preferences — mounted OUTSIDE the tenant-scoped sub-app: they are
 * per-user settings that need no tenant context (a user may open the app before
 * selecting a workspace).
 */
export function createUserPreferencesRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /**
   * GET /preferences — Get current user's global preferences (zoom, theme, language).
   */
  router.get('/preferences', async (c) => {
    const userId = c.get('userId');
    const prefs = await c.get('svc').preferences.getGlobalSettings(userId);

    return c.json({ data: prefs });
  });

  /**
   * PUT /preferences — Update current user's global preferences.
   */
  router.put('/preferences', validateBody(UpdateUserGlobalSettingsSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const prefs = await c.get('svc').preferences.updateGlobalSettings(userId, body);

    return c.json({ data: prefs });
  });

  return router;
}

/**
 * Project-scoped preferences.
 *
 * These two routes used to be mounted on the auth-only sub-app, i.e. OUTSIDE
 * `tenantContextMiddleware`: they ran with no tenant context at all, so
 * `:projectId` could address a project of any tenant. The blast radius was
 * limited (the routes only ever touch the CALLER's own preference row) but the
 * id was unvalidated, so they are now mounted inside the tenant-scoped sub-app
 * and assert project ownership (404 for a foreign project) before reading or
 * writing anything.
 */
export function createProjectPreferencesRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // `:projectId` is validated before any handler runs.
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/preferences — Get user's project preferences.
   */
  router.get('/projects/:projectId/preferences', async (c) => {
    const projectId = param(c, 'projectId');
    const userId = c.get('userId');

    await c.get('svc').projects.getProject(projectId, callerContext(c));

    const prefs = await c.get('svc').preferences.getPreferences(userId, projectId);

    return c.json({ data: prefs });
  });

  /**
   * PATCH /projects/:projectId/preferences — Update user's project preferences.
   */
  router.patch('/projects/:projectId/preferences', validateBody(UpdateUserProjectBoardPreferenceSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const userId = c.get('userId');
    const body = c.req.valid('json');

    // This is a project-scoped WRITE, so it goes through the shared write
    // seam rather than the read-only `getProject` — a project scheduled for
    // deletion is read-only here too.
    await c.get('svc').projects.assertProjectWritable(projectId, callerContext(c));

    const prefs = await c.get('svc').preferences.updatePreferences(userId, projectId, body);

    return c.json({ data: prefs });
  });

  return router;
}
