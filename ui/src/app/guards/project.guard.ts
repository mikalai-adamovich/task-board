import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';

/**
 * Functional route guard that ensures the user has access to a project.
 *
 * The tenant is resolved by slug from the `/w/:tenantSlug` URL prefix;
 * the project is resolved by its human-readable key.
 *
 * The navigation decision NEVER depends on the members list:
 * - Tenant OWNER/ADMIN bypass project membership checks (the effective
 *   PROJECT_ADMIN role is derived reactively by ProjectStore).
 * - Tenant MEMBERs are allowed through — the API enforces 403 when the user
 *   has no project membership. The membership role is derived reactively by
 *   ProjectStore once the background members request completes.
 *
 * This keeps the deep-link critical path at one sequential request
 * (`/projects/by-key/:key`); members load in the background.
 */
export const projectGuard: CanActivateFn = async (route) => {
  const tenantStore = inject(TenantStore);
  const authStore = inject(AuthStore);
  const projectStore = inject(ProjectStore);
  const router = inject(Router);
  const tenantSlug = route.paramMap.get('tenantSlug');
  const projectKey = route.paramMap.get('projectKey');

  if (!tenantSlug || !projectKey) {
    return router.parseUrl('/');
  }

  const activeTenant = tenantStore.activeTenant();

  if (!activeTenant || activeTenant.slug !== tenantSlug) {
    return router.parseUrl('/');
  }

  // Load the project context by key within the active tenant. Members are
  // kicked off in the background by loadProjectByKey() — not awaited here.
  try {
    await projectStore.loadProjectByKey(activeTenant.id, projectKey);
  } catch {
    // Project not found or inaccessible — clear and redirect
    projectStore.clearProject();
    return router.parseUrl('/');
  }

  // No valid tenant role — redirect
  if (!authStore.tenantRole()) {
    projectStore.clearProject();
    return router.parseUrl('/');
  }

  return true;
};
