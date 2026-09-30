import { createMiddleware } from 'hono/factory';
import { ForbiddenError } from './error-handler.js';
import type { AppEnv } from '../types/context.js';
import { TenantRole } from '@task-board/shared';
import type { TenantRole as TenantRoleType } from '@task-board/shared';
import { rbacService } from '../services/rbac.service.js';
import type { PermissionAction } from '../services/rbac.service.js';

// ─── RBAC Middleware Factory ──────────────────────────────────────────────────

/**
 * Factory function that creates a Hono middleware enforcing role-based access
 * using the v5 permission matrix.
 *
 * @param action - The permission action to check
 * @param projectLevel - If true, also checks projectRole from context
 * @returns Hono middleware that checks the user's role against the permission matrix
 *
 * Tenant Owner/Admin bypass project-level restrictions.
 *
 * @example
 * ```ts
 * // Only tenant-level admins can manage tenants
 * app.post('/tenants', requirePermission('manage_tenant'), handler);
 *
 * // Project-level action requiring project membership
 * app.post('/tasks', requirePermission('create_task', true), handler);
 * ```
 */
export function requirePermission(action: PermissionAction, projectLevel = false) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Defense-in-depth: authMiddleware runs first on all protected routes
    // and sets `userId`; assert it so a misconfigured route chain can never
    // authorize an unauthenticated request based on a stale/injected role.
    if (!c.get('userId')) {
      throw new ForbiddenError('Authentication required');
    }

    const tenantRole = c.get('tenantRole') as TenantRoleType | undefined;

    if (!tenantRole) {
      throw new ForbiddenError('No role assigned in this tenant');
    }

    const projectRole = projectLevel ? ((c.get('projectRole') as string | undefined) ?? null) : null;

    if (!rbacService.can(tenantRole, projectRole, action)) {
      throw new ForbiddenError(`Insufficient permissions for action: ${action}`);
    }

    await next();
  });
}

/**
 * Legacy role-based middleware factory for simple tenant role checks.
 *
 * @param roles - One or more tenant roles that are allowed to access the route
 * @returns Hono middleware that checks the user's tenant role
 *
 * @example
 * ```ts
 * // Only owners and admins can manage tenants
 * app.post('/tenants', requireRole('OWNER', 'ADMIN'), handler);
 * ```
 */
export function requireRole(...roles: TenantRoleType[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const tenantRole = c.get('tenantRole') as TenantRoleType | undefined;

    if (!tenantRole) {
      throw new ForbiddenError('No role assigned in this tenant');
    }

    // Tenant owners bypass all restrictions
    if (tenantRole === TenantRole.OWNER) {
      await next();
      return;
    }

    // Check if the user's role is in the allowed list
    if (!roles.includes(tenantRole)) {
      throw new ForbiddenError(`Insufficient permissions. Required: ${roles.join(' or ')}, got: ${tenantRole}`);
    }

    await next();
  });
}
