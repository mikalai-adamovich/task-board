/**
 * Tests for the legacy tenant redirect guard.
 *
 * Legacy `/tenants/:ref` URLs (id or slug) must redirect to `/w/:slug`.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRouteSnapshot, provideRouter, RouterStateSnapshot, UrlTree } from '@angular/router';
import { tenantRedirectGuard } from './tenant-redirect.guard';
import { TenantStore } from '@stores/tenant-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { TenantWithRole } from '@app/types/frontend';

const NOW = '2025-01-01T00:00:00Z';
const mockTenants: TenantWithRole[] = [
  {
    id: 'tenant-1',
    name: 'Acme',
    slug: 'acme',
    description: null,
    status: 'ACTIVE',
    deletionScheduledAt: null,
    role: 'OWNER',
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function makeRoute(ref: string | null): ActivatedRouteSnapshot {
  return { paramMap: { get: (key: string) => (key === 'tenantId' ? ref : null) } } as ActivatedRouteSnapshot;
}

describe('tenantRedirectGuard', () => {
  const mockState = {} as RouterStateSnapshot;

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      ],
    });
  }

  it('should redirect a legacy tenant id to the slug URL', async () => {
    setup();

    const tenantStore = TestBed.inject(TenantStore);

    tenantStore.seedFromBootstrap(mockTenants);

    const result = await TestBed.runInInjectionContext(() => tenantRedirectGuard(makeRoute('tenant-1'), mockState));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/w/acme');
  });

  it('should also accept a legacy slug segment', async () => {
    setup();

    const tenantStore = TestBed.inject(TenantStore);

    tenantStore.seedFromBootstrap(mockTenants);

    const result = await TestBed.runInInjectionContext(() => tenantRedirectGuard(makeRoute('acme'), mockState));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/w/acme');
  });

  it('should fall back to / for an unknown tenant', async () => {
    setup();

    const tenantStore = TestBed.inject(TenantStore);

    tenantStore.seedFromBootstrap(mockTenants);

    const result = await TestBed.runInInjectionContext(() => tenantRedirectGuard(makeRoute('nope'), mockState));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/');
  });

  it('should fall back to / when the reference is missing', async () => {
    setup();

    const result = await TestBed.runInInjectionContext(() => tenantRedirectGuard(makeRoute(null), mockState));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/');
  });
});
