/**
 * Tests for the root Dashboard entry component.
 *
 * Covers:
 * - dashboardState computed signal (visitor / new-user / pending-invitations / redirecting)
 * - Redirect to the last/first accessible tenant home `/w/:tenantSlug`
 * - Auth flow (fetchCurrentUser when token but no user)
 * - onInvitationHandled reload
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { Dashboard } from './dashboard';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { TenantClient } from '@services/tenant-client';
import { API_BASE_URL } from '@app/api-url.token';
import type { User } from '@task-board/shared';
import type { MyInvitation, TenantWithRole } from '@app/types/frontend';

const NOW = '2025-01-01T00:00:00Z';
const mockTenants: TenantWithRole[] = [
  {
    id: 't1',
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

describe('Dashboard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let authStoreMock: {
    isAuthenticated: ReturnType<typeof vi.fn>;
    currentUser: ReturnType<typeof vi.fn>;
    token: ReturnType<typeof vi.fn>;
    fetchCurrentUser: ReturnType<typeof vi.fn>;
    bootstrap: ReturnType<typeof vi.fn>;
  };
  let tenantStoreMock: {
    tenants: ReturnType<typeof vi.fn>;
    activeTenant: ReturnType<typeof vi.fn>;
    loadTenants: ReturnType<typeof vi.fn>;
    tenantsLoaded: ReturnType<typeof vi.fn>;
    seedFromBootstrap: ReturnType<typeof vi.fn>;
  };
  let tenantClientMock: { getMyInvitations: ReturnType<typeof vi.fn> };
  let routerNavigateSpy: ReturnType<typeof vi.fn>;

  async function setup(
    opts: {
      authenticated?: boolean;
      hasUser?: boolean;
      token?: string | null;
      tenants?: TenantWithRole[];
      invitations?: MyInvitation[];
      fetchCurrentUserMock?: () => Promise<User>;
    } = {},
  ) {
    const {
      authenticated = true,
      hasUser = true,
      token = 'test-token',
      tenants = mockTenants,
      invitations = [],
      fetchCurrentUserMock,
    } = opts;
    const seedTenants = (seeded: TenantWithRole[]): void => {
      tenantStoreMock.tenants.mockReturnValue(seeded);
      tenantStoreMock.activeTenant.mockReturnValue(seeded[0] ?? null);
      tenantStoreMock.tenantsLoaded.mockReturnValue(true);
    };

    tenantStoreMock = {
      tenants: vi.fn().mockReturnValue(tenants),
      activeTenant: vi.fn().mockReturnValue(tenants[0] ?? null),
      loadTenants: vi.fn().mockImplementation(async () => {
        seedTenants(tenants);

        return tenants;
      }),
      // Pre-bootstrap state: the list has not been initialized yet
      tenantsLoaded: vi.fn().mockReturnValue(false),
      seedFromBootstrap: vi.fn().mockImplementation(seedTenants),
    };
    authStoreMock = {
      isAuthenticated: vi.fn().mockReturnValue(authenticated),
      currentUser: vi.fn().mockReturnValue(hasUser ? ({ id: 'u1' } as User) : null),
      token: vi.fn().mockReturnValue(token),
      fetchCurrentUser: fetchCurrentUserMock
        ? vi.fn().mockImplementation(fetchCurrentUserMock)
        : vi.fn().mockResolvedValue({ id: 'u1' } as User),
      // Mimics the real AuthStore.bootstrap: one request seeds both stores
      bootstrap: vi.fn().mockImplementation(async () => {
        authStoreMock.currentUser.mockReturnValue({ id: 'u1' } as User);
        seedTenants(tenants);
      }),
    };
    tenantClientMock = {
      getMyInvitations: vi.fn().mockReturnValue(of(invitations)),
    };
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: AuthStore, useValue: authStoreMock },
        { provide: TenantStore, useValue: tenantStoreMock },
        { provide: TenantClient, useValue: tenantClientMock },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    // Spy on navigation instead of replacing the Router (RouterLink needs the real one)
    routerNavigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Dashboard);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  it('should bootstrap (user + tenants in one request) and redirect to the tenant home', async () => {
    await setup();

    // Wait for async tenant loading + navigation
    await new Promise((r) => setTimeout(r, 0));

    expect(authStoreMock.bootstrap).toHaveBeenCalled();
    // No separate /tenants call after bootstrap
    expect(tenantStoreMock.loadTenants).not.toHaveBeenCalled();
    expect(routerNavigateSpy).toHaveBeenCalledWith(['/w', 'acme'], { replaceUrl: true });
    expect(component.dashboardState()).toBe('redirecting');
  });

  it('should show the welcome view for an authenticated user without tenants', async () => {
    await setup({ tenants: [] });

    await new Promise((r) => setTimeout(r, 0));

    expect(component.dashboardState()).toBe('new-user');
    expect(routerNavigateSpy).not.toHaveBeenCalled();
  });

  it('should show the invitation view when there are only pending invitations', async () => {
    await setup({ tenants: [], invitations: [{ id: 'inv1' } as MyInvitation] });

    await new Promise((r) => setTimeout(r, 0));

    expect(component.dashboardState()).toBe('pending-invitations');
  });

  it('should show the landing page for a visitor', async () => {
    await setup({ authenticated: false, hasUser: false, token: null });

    expect(component.dashboardState()).toBe('visitor');
    expect(component.loading()).toBe(false);
  });

  describe('onInvitationHandled', () => {
    it('should reload tenants and navigate once a tenant is available', async () => {
      await setup({ tenants: [] });

      await new Promise((r) => setTimeout(r, 0));

      // An invitation acceptance produced a tenant
      tenantStoreMock.loadTenants.mockResolvedValue(mockTenants);
      tenantStoreMock.activeTenant.mockReturnValue(mockTenants[0]);
      tenantStoreMock.tenants.mockReturnValue(mockTenants);

      await component.onInvitationHandled();

      expect(routerNavigateSpy).toHaveBeenCalledWith(['/w', 'acme'], { replaceUrl: true });
    });
  });
});
