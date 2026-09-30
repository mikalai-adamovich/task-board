import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  TenantRole,
  TENANT_DESCRIPTION_MAX_LENGTH,
  TENANT_NAME_MAX_LENGTH,
  generateSlugFromName,
  isValidTenantSlug,
} from '@task-board/shared';
import { form, FormField, FormRoot, schema, required, maxLength, validate } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { BillingClient, CheckoutContext, FREE_PLAN_ID } from '@services/billing-client';
import { TenantClient } from '@services/tenant-client';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';

/** Steps of the first-tenant onboarding journey: details → plan → checkout → confirmation. */
type OnboardingStep = 'details' | 'plan' | 'checkout' | 'confirmation';

interface WorkspaceModel {
  name: string;
  description: string;
  slug: string;
}

/** Debounce for the live slug availability check. */
const SLUG_CHECK_DEBOUNCE_MS = 300;

@Component({
  imports: [
    FieldControl,
    HlmAlertImports,
    TranslocoPipe,
    FormField,
    FormRoot,
    HlmCardImports,
    HlmFieldImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmButtonImports,
    HlmSpinnerImports,
    NgIcon,
  ],
  providers: [provideIcons({ lucideCheck })],
  selector: 'ui-create-workspace',
  templateUrl: './create-workspace.html',
})
export class CreateWorkspace {
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  private readonly billing = inject(BillingClient);
  private readonly tenantClient = inject(TenantClient);
  private readonly error = signal('');
  private readonly step = signal<OnboardingStep>('details');
  private readonly confirming = signal(false);
  private readonly creating = signal(false);
  /** Live availability state of the slug field (debounced server check). */
  private readonly slugAvailability = signal<'idle' | 'checking' | 'available' | 'taken'>('idle');
  /** Set once the user edits the slug by hand — stops auto-generation from the name. */
  private readonly slugManuallyEdited = signal(false);
  private readonly model = signal<WorkspaceModel>({ name: '', description: '', slug: '' });
  protected readonly workspaceForm = form(
    this.model,
    schema<WorkspaceModel>((field) => {
      required(field.name, { message: 'validation.workspaceNameRequired' });
      // The server's bounds, not hand-typed twins of them. The create
      // form used to hard-code 100 while the rename form and the server both
      // used TENANT_NAME_MAX_LENGTH, so one field had two limits in one session.
      maxLength(field.name, TENANT_NAME_MAX_LENGTH, { message: 'validation.nameMax' });
      maxLength(field.description, TENANT_DESCRIPTION_MAX_LENGTH, { message: 'validation.descriptionMax' });
      validate(field.slug, ({ value }) => {
        const slug = value();

        if (!slug) {
          return { kind: 'required', message: 'createWorkspace.slug.required' };
        }
        if (!isValidTenantSlug(slug)) {
          return { kind: 'pattern', message: 'createWorkspace.slug.invalid' };
        }

        return undefined;
      });
    }),
    {
      submission: {
        action: async () => {
          this.error.set('');

          const availability = this.slugAvailability();

          if (availability === 'checking') {
            this.error.set('createWorkspace.slug.checking');
            return;
          }
          if (availability === 'taken') {
            this.error.set('createWorkspace.slug.taken');
            return;
          }

          this.step.set('plan');
        },
      },
    },
  );

  constructor() {
    // Auto-generate the slug from the workspace name until the user edits it manually.
    effect(() => {
      const name = this.model().name;

      if (this.slugManuallyEdited()) {
        return;
      }

      const generated = generateSlugFromName(name);

      if (generated !== this.model().slug) {
        this.model.update((m) => ({ ...m, slug: generated }));
      }
    });

    // Debounced live availability check against GET /api/tenants/slug-available.
    let lastCheckedSlug = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let slugCheckSubscription: Subscription | null = null;

    effect(() => {
      const slug = this.model().slug;

      if (!isValidTenantSlug(slug)) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.slugAvailability.set('idle');
        lastCheckedSlug = '';
        return;
      }

      // Skip duplicate checks when unrelated model fields change but the slug stays the same.
      // The pending timer is intentionally kept running — clearing it here (e.g. via effect
      // cleanup) would cancel the only scheduled check and leave the state stuck on 'checking'.
      if (slug === lastCheckedSlug) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      lastCheckedSlug = slug;

      this.slugAvailability.set('checking');

      timer = setTimeout(() => {
        timer = null;
        slugCheckSubscription = this.tenantClient.isSlugAvailable(slug).subscribe({
          next: (available) => {
            // Ignore stale responses for a slug that has since changed.
            if (this.model().slug === slug) {
              this.slugAvailability.set(available ? 'available' : 'taken');
            }
          },
          error: () => {
            if (this.model().slug === slug) {
              this.slugAvailability.set('idle');
            }
          },
        });
      }, SLUG_CHECK_DEBOUNCE_MS);
    });

    // The debounce timer outlives the component unless it is cancelled: leaving
    // the page inside the 300 ms window fired `isSlugAvailable(slug)` for a
    // destroyed component and wrote its state. The in-flight SUBSCRIPTION is
    // cancelled too, so a response that lands mid-teardown cannot write either.
    this.destroyRef.onDestroy(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCheckedSlug = '';
      slugCheckSubscription?.unsubscribe();
      slugCheckSubscription = null;
    });
  }

  /** Called when the user types into the slug field — stops auto-generation. */
  protected markSlugEdited(): void {
    this.slugManuallyEdited.set(true);
  }

  protected goBack(): void {
    this.error.set('');

    if (this.step() === 'plan') {
      this.step.set('details');
    } else if (this.step() === 'checkout') {
      this.step.set('plan');
    }
  }

  protected goToCheckout(): void {
    this.error.set('');
    this.step.set('checkout');
  }

  /**
   * Complete the mock checkout at the billing boundary, show the confirmation
   * step, then create the tenant and navigate to its home.
   */
  protected confirmCheckout(): void {
    if (this.confirming()) {
      return;
    }

    this.error.set('');
    this.confirming.set(true);

    const context: CheckoutContext = { workspaceName: this.model().name, slug: this.model().slug };

    this.billing.completeMockCheckout(FREE_PLAN_ID, context).subscribe({
      next: () => {
        this.confirming.set(false);
        this.step.set('confirmation');
        void this.createTenantAndNavigate();
      },
      error: (err) => {
        this.confirming.set(false);
        this.error.set(getErrorMessage(err, 'createWorkspace.failed'));
      },
    });
  }

  private async createTenantAndNavigate(): Promise<void> {
    this.creating.set(true);

    try {
      const tenant = await this.tenantStore.createTenant({
        name: this.model().name,
        slug: this.model().slug || undefined,
        description: this.model().description || undefined,
      });

      this.authStore.setTenantContext(tenant.id, TenantRole.OWNER);

      await this.router.navigateByUrl('/');
    } catch (err) {
      this.error.set(getErrorMessage(err, 'createWorkspace.failed'));
      // Surface SLUG_TAKEN races etc. back on the checkout step so the user can adjust.
      this.step.set('checkout');
    } finally {
      this.creating.set(false);
    }
  }
}
