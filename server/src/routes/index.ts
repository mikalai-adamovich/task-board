import { Hono } from 'hono';
import type { AppEnv } from '../types/context.js';
import { TenantRole } from '@task-board/shared';
import { requireRole } from '../middleware/rbac.js';
import { createAuthRoutes } from './auth.js';
import { createTenantRoutes } from './tenants.js';
import { createProjectRoutes } from './projects.js';
import { createBoardRoutes } from './boards.js';
import { createTaskRoutes } from './tasks.js';
import { createSprintRoutes } from './sprints.js';
import { createStatusRoutes } from './statuses.js';
import { createTaskTypeRoutes } from './task-types.js';
import { createLabelRoutes } from './labels.js';
import { createCommentRoutes } from './comments.js';
import { createTaskRelationshipRoutes } from './task-relationships.js';
import { createFilterRoutes } from './filters.js';
import { createAuditRoutes } from './audit.js';

// ─── Route Registry ───────────────────────────────────────────────────────────

/**
 * Central registry of all feature route modules.
 *
 * Auth routes have no tenant context or RBAC middleware.
 * Tenant routes require auth but handle RBAC internally per-route.
 * All other routes use RBAC middleware per their specific requirements.
 */
export const routeRegistry = {
  /** Auth routes — no tenant context, no RBAC */
  auth: createAuthRoutes(),

  /**
   * Tenant routes — requires auth, handles RBAC internally.
   */
  tenants: createTenantRoutes(),

  /**
   * Project routes — requires any tenant member role.
   * Per-action authorization is enforced inside the project service:
   * reads are allowed for all roles; writes/mutations require tenant admin+
   * No router-level `create_project` gate).
   */
  projects: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createProjectRoutes());
    return router;
  })(),

  /** Board routes — requires any tenant member role; handles admin checks internally */
  boards: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createBoardRoutes());
    return router;
  })(),

  /** Task routes — requires any tenant member role; handles admin checks internally */
  tasks: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createTaskRoutes());
    return router;
  })(),

  /** Sprint routes — requires any tenant member role; handles admin checks internally */
  sprints: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createSprintRoutes());
    return router;
  })(),

  /** Status routes — requires any tenant member role */
  statuses: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createStatusRoutes());
    return router;
  })(),

  /** TaskType routes — requires any tenant member role */
  taskTypes: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createTaskTypeRoutes());
    return router;
  })(),

  /** Label routes — requires any tenant member role */
  labels: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createLabelRoutes());
    return router;
  })(),

  /** Comment routes — requires any tenant member role */
  comments: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createCommentRoutes());
    return router;
  })(),

  /** Task relationship routes — requires any tenant member role */
  taskRelationships: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createTaskRelationshipRoutes());
    return router;
  })(),

  /** Filter routes — requires any tenant member role */
  filters: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createFilterRoutes());
    return router;
  })(),

  /** Audit routes — requires any tenant member role */
  audit: (() => {
    const router = new Hono<AppEnv>();

    router.use('/*', requireRole(TenantRole.OWNER, TenantRole.ADMIN, TenantRole.MEMBER));
    router.route('/', createAuditRoutes());
    return router;
  })(),
} as const;
