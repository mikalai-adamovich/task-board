import { ActivatedRoute } from '@angular/router';

/**
 * Find the `tenantSlug` path parameter by walking **up** the route tree.
 *
 * Path params are NOT inherited downwards by default (`paramsInheritanceStrategy:
 * 'emptyOnly'`), so each ancestor segment must be checked individually — walking
 * to the root and reading its paramMap would return nothing.
 *
 * All tenant-scoped routes live under `/w/:tenantSlug`.
 */
export function getTenantSlug(route: ActivatedRoute): string {
  let current: ActivatedRoute | null = route;

  while (current) {
    const tenantSlug = current.snapshot.paramMap.get('tenantSlug');

    if (tenantSlug) return tenantSlug;

    current = current.parent;
  }

  return '';
}
