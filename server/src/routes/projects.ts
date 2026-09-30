import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  AddProjectMemberSchema,
  UpdateProjectMemberSchema,
} from '../schemas/project.js';
import type { CallerContext } from '../services/tenant-assert.js';

// ─── Project Routes ──────────────────────────────────────────────────────────

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It comes from the request context set by the auth / tenant-context
 * middleware — never from the path or the body — and the service treats it as
 * required (missing → 401, foreign tenant → 404, insufficient role → 403).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

/**
 * The "target user must hold an ACTIVE membership in the CALLER's
 * tenant" guard NO LONGER lives here.
 *
 * It used to be a route-level helper reading the whole tenant roster through
 * `TenantMemberService.getTenantMembers` (a `$lookup` aggregate), which meant any
 * direct call to `ProjectService.addMember` bypassed it entirely. It is now a
 * required dependency of the service (`ProjectService.tenantMemberRepo`) and runs
 * inside `addMember`, next to the project tenant-assert — so no call site can
 * skip it, and the cost drops to one indexed `{ tenantId, userId }` lookup.
 *
 * Observable behaviour is unchanged: a non-member / foreign `userId` is rejected
 * with 404 and NO `project_members` row is created; a duplicate is still 409; a
 * foreign project is still 404 and an insufficient role still 403.
 */
export function createProjectRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET / — List all projects in the active tenant.
   */
  router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const projects = await c.get('svc').projects.listProjects(tenantId);

    return c.json({ data: projects });
  });

  /**
   * POST / — Create a new project with seed data. Tenant admin+ only.
   */
  router.post('/', validateBody(CreateProjectSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const userRole = c.get('tenantRole');
    const body = c.req.valid('json');
    const project = await c.get('svc').projects.createProject(tenantId, userId, userRole, body);

    return c.json({ data: project }, 201);
  });

  /**
   * GET /by-key/:key — Get project by key within the active tenant.
   * The repository query is already tenant-scoped, so a foreign key is a 404.
   */
  router.get('/by-key/:key', async (c) => {
    const key = param(c, 'key');
    const tenantId = c.get('tenantId');
    const project = await c.get('svc').projects.getProjectByKey(tenantId, key);

    return c.json({ data: project });
  });

  /**
   * GET /:projectId — Get project details. Tenant-asserted in the service (404
   * for a project of another tenant).
   */
  router.get('/:projectId', async (c) => {
    const projectId = param(c, 'projectId');
    const project = await c.get('svc').projects.getProject(projectId, callerContext(c));

    return c.json({ data: project });
  });

  /**
   * PATCH /:projectId — Update project. Tenant admin+ only.
   * The acting user is forwarded so the PROJECT UPDATED audit event is
   * written (it used to be dropped because the route passed no `userId`).
   */
  router.patch('/:projectId', validateBody(UpdateProjectSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const body = c.req.valid('json');
    const project = await c.get('svc').projects.updateProject(projectId, body, callerContext(c));

    return c.json({ data: project });
  });

  /**
   * DELETE /:projectId — Initiate project deletion. Tenant admin+ only.
   * The acting user is forwarded so the PROJECT DELETED audit event is
   * written.
   */
  router.delete('/:projectId', async (c) => {
    const projectId = param(c, 'projectId');

    await c.get('svc').projects.deleteProject(projectId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  /**
   * POST /:projectId/archive — Archive project.
   */
  router.post('/:projectId/archive', async (c) => {
    const projectId = param(c, 'projectId');

    await c.get('svc').projects.archiveProject(projectId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  /**
   * POST /:projectId/restore — Restore project.
   */
  router.post('/:projectId/restore', async (c) => {
    const projectId = param(c, 'projectId');

    await c.get('svc').projects.restoreProject(projectId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  /**
   * POST /:projectId/cancel-deletion — Cancel project deletion.
   */
  router.post('/:projectId/cancel-deletion', async (c) => {
    const projectId = param(c, 'projectId');

    await c.get('svc').projects.cancelDeletion(projectId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  // ─── Project Member Management ───────────────────────────────────────────

  /**
   * GET /:projectId/members — any tenant member of the project's tenant; the
   * project itself is tenant-asserted in the service (404 when foreign).
   */
  router.get('/:projectId/members', async (c) => {
    const projectId = param(c, 'projectId');
    const members = await c.get('svc').projects.getProjectMembers(projectId, callerContext(c));

    return c.json({ data: members });
  });

  /**
   * POST /:projectId/members — add a member. Tenant admin+ only.
   * `body.userId` must resolve to an ACTIVE membership in the caller's
   * tenant, otherwise 404 and no membership row is created — enforced INSIDE
   * `ProjectService.addMember` (see the note above), not here.
   */
  router.post('/:projectId/members', validateBody(AddProjectMemberSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const body = c.req.valid('json');
    const member = await c.get('svc').projects.addMember(projectId, body, callerContext(c));

    return c.json({ data: member }, 201);
  });

  router.patch('/:projectId/members/:memberUserId', validateBody(UpdateProjectMemberSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const memberUserId = param(c, 'memberUserId');
    const body = c.req.valid('json');
    const member = await c.get('svc').projects.updateMemberRole(projectId, memberUserId, body.role, callerContext(c));

    return c.json({ data: member });
  });

  router.delete('/:projectId/members/:memberUserId', async (c) => {
    const projectId = param(c, 'projectId');
    const memberUserId = param(c, 'memberUserId');

    await c.get('svc').projects.removeMember(projectId, memberUserId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
