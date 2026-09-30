/**
 * Tests for the CreateWorkspace onboarding wizard.
 *
 * Covers:
 * - Signal form field validation (name, slug)
 * - Slug auto-generation from the workspace name (+ manual-edit override)
 * - Debounced live slug availability check
 * - Step flow: details → plan → checkout → confirmation
 * - Billing boundary is completed before the tenant is created
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { CreateWorkspace } from './create-workspace';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { BillingClient, CheckoutContext, FREE_PLAN_ID } from '@services/billing-client';
import { API_BASE_URL } from '@app/api-url.token';
import type { TenantWithRole } from '@app/types/frontend';
import { TENANT_NAME_MAX_LENGTH } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';
const mockTenant: TenantWithRole = {
  id: 't1',
  name: 'NewCo',
  slug: 'newco',
  description: null,
  status: 'ACTIVE',
  deletionScheduledAt: null,
  role: 'OWNER',
  createdAt: NOW,
  updatedAt: NOW,
};

/** Wait for the slug availability debounce (300ms) plus a tick. */
async function waitForSlugDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe('CreateWorkspace', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ReturnType<typeof TestBed.createComponent<CreateWorkspace>>;
  let httpMock: HttpTestingController;
  let tenantStoreMock: {
    createTenant: ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } & Record<string, any>;
  let authStoreMock: {
    setTenantContext: ReturnType<typeof vi.fn>;
  };
  let billingMock: {
    completeMockCheckout: ReturnType<typeof vi.fn>;
  };
  let routerMock: { navigateByUrl: ReturnType<typeof vi.fn> };

  async function setup() {
    tenantStoreMock = {
      createTenant: vi.fn().mockResolvedValue(mockTenant),
    };
    authStoreMock = {
      setTenantContext: vi.fn(),
    };
    billingMock = {
      completeMockCheckout: vi.fn((planId: string, context: CheckoutContext) => {
        void context;

        return of({ status: 'active' as const, plan: planId });
      }),
    };
    routerMock = {
      navigateByUrl: vi.fn().mockResolvedValue(true),
    };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { en: { common: { charCount: '{{count}}/{{max}}' } } },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: TenantStore, useValue: tenantStoreMock },
        { provide: AuthStore, useValue: authStoreMock },
        { provide: BillingClient, useValue: billingMock },
        { provide: Router, useValue: routerMock },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CreateWorkspace);
    component = fixture.componentInstance;
    await settle(fixture);
  }

  /** Fill the name, wait out the debounce, and answer the availability check. */
  async function fillNameAndCheckSlug(name: string, available: boolean): Promise<void> {
    component.model.update((m: { name: string }) => ({ ...m, name }));
    await settle(fixture);
    await waitForSlugDebounce();

    const req = httpMock.expectOne((r) => r.url.includes('/tenants/slug-available'));

    expect(req.request.method).toBe('GET');
    req.flush({ data: { available } });
    await settle(fixture);
  }

  /** Dispatch a submit event on the details-step form (runs the submission action). */
  async function submitDetailsForm(): Promise<void> {
    const formEl = fixture.nativeElement.querySelector('form');

    formEl.dispatchEvent(new Event('submit'));
    await Promise.resolve();
    await settle(fixture);
  }

  // ── name field validation ──────────────────────────────────────────────

  describe('name field', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.workspaceForm.name().invalid()).toBe(true);
    });

    it('should be valid for non-empty value', () => {
      component.model.update((m: { name: string; description: string }) => ({ ...m, name: 'NewCo' }));
      expect(component.workspaceForm.name().valid()).toBe(true);
    });

    it('should be invalid when exceeding the shared name bound', () => {
      component.model.update((m: { name: string; description: string }) => ({
        ...m,
        name: 'a'.repeat(TENANT_NAME_MAX_LENGTH + 1),
      }));
      expect(component.workspaceForm.name().invalid()).toBe(true);
    });

    it('should be valid at the shared name bound', () => {
      component.model.update((m: { name: string; description: string }) => ({
        ...m,
        name: 'a'.repeat(TENANT_NAME_MAX_LENGTH),
      }));
      expect(component.workspaceForm.name().valid()).toBe(true);
    });

    // The create form used to hard-code 100 while the server and the rename
    // form used TENANT_NAME_MAX_LENGTH (200): one field, two limits, one
    // session. A 150-character name is legal everywhere except here.
    it('should accept a 150-character name, the same bound the server and the rename form use', () => {
      component.model.update((m: { name: string; description: string }) => ({ ...m, name: 'a'.repeat(150) }));
      expect(component.workspaceForm.name().valid()).toBe(true);
    });
  });

  // ── description field (120-char limit, Round 5 P2) ─────────────────────

  describe('description field', () => {
    beforeEach(() => setup());

    it('should be invalid when exceeding 120 characters', () => {
      component.model.update((m: { name: string; description: string }) => ({
        ...m,
        name: 'NewCo',
        description: 'a'.repeat(121),
      }));

      expect(component.workspaceForm.description().invalid()).toBe(true);
    });

    it('should be valid at 120 characters', () => {
      component.model.update((m: { name: string; description: string }) => ({
        ...m,
        name: 'NewCo',
        description: 'a'.repeat(120),
      }));

      expect(component.workspaceForm.description().valid()).toBe(true);
    });

    it('should render the character counter under the field', async () => {
      component.model.update((m: { name: string; description: string }) => ({
        ...m,
        name: 'NewCo',
        description: 'abc',
      }));
      await settle(fixture);

      const counter = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="desc-char-count"]');

      expect(counter?.textContent?.trim()).toBe('3/120');
    });
  });

  // ── slug generation & validation ───────────────────────────────────────

  describe('slug field', () => {
    beforeEach(() => setup());

    it('should auto-generate the slug from the workspace name', async () => {
      component.model.update((m: { name: string }) => ({ ...m, name: 'My Workspace!' }));
      await settle(fixture);
      await waitForSlugDebounce();

      expect(component.model().slug).toBe('my-workspace');
      httpMock.expectOne((r) => r.url.includes('/tenants/slug-available')).flush({ data: { available: true } });
    });

    it('should stop auto-generating once the user edits the slug manually', async () => {
      component.markSlugEdited();
      component.model.update((m: { name: string; slug: string }) => ({ ...m, slug: 'custom-slug' }));
      await settle(fixture);
      await waitForSlugDebounce();

      component.model.update((m: { name: string }) => ({ ...m, name: 'Another Name' }));
      await settle(fixture);
      await waitForSlugDebounce();

      expect(component.model().slug).toBe('custom-slug');
      httpMock.expectOne((r) => r.url.includes('/tenants/slug-available')).flush({ data: { available: true } });
    });

    it('should be invalid for a slug violating the slug rules', async () => {
      component.markSlugEdited();
      component.model.update((m: { name: string; slug: string }) => ({ ...m, slug: 'Bad Slug!' }));
      await settle(fixture);

      expect(component.workspaceForm.slug().invalid()).toBe(true);
      expect(component.workspaceForm.slug().errors()[0].kind).toBe('pattern');
    });

    it('should reflect an unavailable slug from the live check', async () => {
      await fillNameAndCheckSlug('Taken Co', false);

      expect(component.slugAvailability()).toBe('taken');
    });

    it('should reflect an available slug from the live check', async () => {
      await fillNameAndCheckSlug('Free Co', true);

      expect(component.slugAvailability()).toBe('available');
    });
  });

  // ── step flow ──────────────────────────────────────────────────────────

  describe('step flow', () => {
    beforeEach(() => setup());

    it('should start on the details step', () => {
      expect(component.step()).toBe('details');
    });

    it('should block advancing while the slug is taken', async () => {
      await fillNameAndCheckSlug('Taken Co', false);
      await submitDetailsForm();

      expect(component.step()).toBe('details');
    });

    it('should advance details → plan → checkout and keep state', async () => {
      await fillNameAndCheckSlug('NewCo', true);
      await submitDetailsForm();

      expect(component.step()).toBe('plan');

      component.goToCheckout();
      expect(component.step()).toBe('checkout');

      // State preserved across steps
      expect(component.model().name).toBe('NewCo');
      expect(component.model().slug).toBe('newco');
    });

    it('should support going back between steps without losing state', async () => {
      await fillNameAndCheckSlug('NewCo', true);
      await submitDetailsForm();
      component.goToCheckout();

      component.goBack();
      expect(component.step()).toBe('plan');

      component.goBack();
      expect(component.step()).toBe('details');
      expect(component.model().name).toBe('NewCo');
    });

    it('should complete the mock checkout before creating the tenant, then navigate', async () => {
      await fillNameAndCheckSlug('NewCo', true);
      await submitDetailsForm();
      component.goToCheckout();

      component.confirmCheckout();
      // Billing mock resolves synchronously; allow promise chain to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle(fixture);

      expect(billingMock.completeMockCheckout).toHaveBeenCalledWith(FREE_PLAN_ID, {
        workspaceName: 'NewCo',
        slug: 'newco',
      });
      expect(tenantStoreMock.createTenant).toHaveBeenCalledWith({
        name: 'NewCo',
        slug: 'newco',
        description: undefined,
      });
      expect(billingMock.completeMockCheckout.mock.invocationCallOrder[0]).toBeLessThan(
        tenantStoreMock.createTenant.mock.invocationCallOrder[0] ?? Number.NaN,
      );
      expect(authStoreMock.setTenantContext).toHaveBeenCalledWith(mockTenant.id, 'OWNER');
      expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/');
      expect(component.step()).toBe('confirmation');
    });

    it('should stay on checkout when tenant creation fails so the user can retry', async () => {
      tenantStoreMock.createTenant.mockRejectedValueOnce(new Error('boom'));

      await fillNameAndCheckSlug('NewCo', true);
      await submitDetailsForm();
      component.goToCheckout();

      component.confirmCheckout();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle(fixture);

      expect(component.step()).toBe('checkout');
      expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
    });
  });

  // ── The debounce timer does not outlive the component ────────────────────
  describe('teardown', () => {
    beforeEach(() => setup());

    it('should issue no availability request when destroyed inside the debounce window', async () => {
      // A valid slug arms the 300 ms debounce timer…
      component.markSlugEdited();
      component.model.update((m: { name: string }) => ({ ...m, slug: 'acme' }));
      await settle(fixture);

      // …the user navigates away before it fires…
      fixture.destroy();

      // …and the timer must never reach the client.
      await waitForSlugDebounce();

      httpMock.expectNone((r) => r.url.includes('/tenants/slug-available'));
    });

    it('should tear down an in-flight availability request on destroy', async () => {
      component.markSlugEdited();
      component.model.update((m: { name: string }) => ({ ...m, slug: 'acme' }));
      await settle(fixture);
      await waitForSlugDebounce();

      const req = httpMock.expectOne((r) => r.url.includes('/tenants/slug-available'));

      fixture.destroy();

      // The subscription died with the component, so the response can neither
      // arrive nor be written to a destroyed component's state.
      expect(req.cancelled).toBe(true);
      expect(component.slugAvailability()).toBe('checking');
    });
  });
});
