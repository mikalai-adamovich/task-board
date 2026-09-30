import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import {
  lucideSettings,
  lucideTrash2,
  lucideSave,
  lucideArchive,
  lucideRotateCcw,
  lucideXCircle,
} from '@ng-icons/lucide';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { TenantRole, TenantStatus, TENANT_DESCRIPTION_MAX_LENGTH, TENANT_NAME_MAX_LENGTH } from '@task-board/shared';
import { statusBadgeVariant } from '@app/constants/priority';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { form, FormField, FormRoot, schema, required, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { hasMinTenantRole } from '@app/shared/utils/role-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

@Component({
  selector: 'ui-tenant-settings',
  imports: [
    FieldControl,
    HlmAlertImports,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmCardImports,
    HlmFieldImports,
    HlmInputImports,
    HlmSpinnerImports,
    HlmDialogImports,
    HlmBadgeImports,
    FormField,
    FormRoot,
  ],
  providers: [
    provideIcons({
      lucideSettings,
      lucideTrash2,
      lucideSave,
      lucideArchive,
      lucideRotateCcw,
      lucideXCircle,
    }),
  ],
  templateUrl: './tenant-settings.html',
})
export class TenantSettings implements OnInit {
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  private readonly notify = injectToasts();
  private readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly showDeleteDialog = signal(false);
  private readonly deleteConfirmName = signal('');
  protected readonly TenantStatus = TenantStatus;
  /** Current tenant name, used for delete confirmation comparison */
  protected readonly currentTenantName = computed(() => this.tenantStore.activeTenant()?.name ?? '');
  protected readonly currentStatus = computed(() => this.tenantStore.activeTenant()?.status ?? TenantStatus.ACTIVE);
  private readonly tenantId = computed(() => this.tenantStore.activeTenant()?.id ?? null);
  protected readonly canEdit = computed(() => hasMinTenantRole(this.authStore.tenantRole(), TenantRole.ADMIN));
  private readonly model = signal<{ name: string; description: string }>({ name: '', description: '' });
  protected readonly settingsForm = form(
    this.model,
    schema<{ name: string; description: string }>((field) => {
      required(field.name, { message: 'validation.nameRequired' });
      // The server's bound, not a hand-typed twin of it.
      maxLength(field.name, TENANT_NAME_MAX_LENGTH, { message: 'validation.nameMax' });
      maxLength(field.description, TENANT_DESCRIPTION_MAX_LENGTH, { message: 'validation.descriptionMax' });
    }),
    {
      submission: {
        action: async () => {
          this.error.set('');

          const id = this.tenantId();

          if (!id) return;

          try {
            await this.tenantStore.updateTenant(id, {
              name: this.model().name,
              description: this.model().description,
            });
            this.router.navigate(['/']);
          } catch (err) {
            this.error.set(getErrorMessage(err));
          }
        },
      },
    },
  );

  protected onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showDeleteDialog.set(false);
      this.deleteConfirmName.set('');
    }
  }

  ngOnInit(): void {
    const tenant = this.tenantStore.activeTenant();

    if (tenant) {
      this.model.set({ name: tenant.name, description: tenant.description ?? '' });
      this.loading.set(false);
    } else {
      this.loading.set(false);
    }
  }

  protected archiveTenant(): void {
    const id = this.tenantId();

    if (!id) return;

    this.tenantStore.archiveTenant(id).then(
      () => {
        this.notify.success('toasts.updated');
        this.router.navigate(['/']);
      },
      (err) => this.error.set(getErrorMessage(err)),
    );
  }

  protected restoreTenant(): void {
    const id = this.tenantId();

    if (!id) return;

    this.tenantStore.restoreTenant(id).then(
      () => this.notify.success('toasts.updated'),
      (err) => this.error.set(getErrorMessage(err)),
    );
  }

  protected deleteTenant(): void {
    const tenant = this.tenantStore.activeTenant();

    if (!tenant || this.deleteConfirmName() !== tenant.name) return;

    this.tenantStore.deleteTenant(tenant.id).then(
      () => {
        this.router.navigate(['/']);
      },
      (err) => {
        this.error.set(getErrorMessage(err));
      },
    );
  }

  protected cancelDeletion(): void {
    const id = this.tenantId();

    if (!id) return;

    this.tenantStore.cancelDeletion(id).catch((err) => {
      this.error.set(getErrorMessage(err));
    });
  }
}
