import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLock, lucideSave } from '@ng-icons/lucide';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { form, FormField, FormRoot, schema, required, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { canManageProject } from '@app/shared/utils/role-utils';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

interface GeneralFormModel {
  name: string;
  description: string;
}

/**
 * Project settings — General page (spec S15, DEC-035).
 * Edits name/description. The key is immutable server-side; the field
 * is rendered locked with an explanatory hint.
 */
@Component({
  selector: 'ui-project-settings-general',
  imports: [
    FieldControl,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmFieldImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmCardImports,
    HlmAlertImports,
    FormField,
    FormRoot,
  ],
  providers: [provideIcons({ lucideLock, lucideSave })],
  templateUrl: './project-settings-general.html',
})
export class ProjectSettingsGeneral {
  private readonly notify = injectToasts();
  private readonly projectClient = inject(ProjectClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  /** Bound via withComponentInputBinding() — receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /**
   * Whether the current user can manage project settings (PROJECT_ADMIN+).
   * Tenant OWNER/ADMIN bypass project role checks.
   */
  protected readonly isAdmin = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  private readonly actionError = signal('');
  protected readonly error = computed(() => this.actionError());
  /** Seed the form from the project context loaded by projectGuard */
  private readonly initialProject = this.projectStore.activeProject();
  private readonly model = signal<GeneralFormModel>({
    name: this.initialProject?.name ?? '',
    description: this.initialProject?.description ?? '',
  });
  protected readonly generalForm = form(
    this.model,
    schema<GeneralFormModel>((field) => {
      required(field.name, { message: 'validation.nameRequired' });
      maxLength(field.description, 120, { message: 'validation.descriptionMax' });
    }),
    {
      submission: {
        action: async () => {
          this.actionError.set('');

          const m = this.model();

          return new Promise<void>((resolve) => {
            this.projectClient.update(this.projectId(), { name: m.name, description: m.description }).subscribe({
              next: (updated) => {
                this.projectStore.activeProject.update((p) => (p ? { ...p, ...updated } : p));

                // Keep the shared tenant project-list cache in sync
                const merged = this.projectStore.activeProject();

                if (merged) this.projectStore.upsertProject(merged);
                this.notify.success('toasts.updated');
                resolve();
              },
              error: (err) => {
                this.actionError.set(getErrorMessage(err));
                resolve();
              },
            });
          });
        },
      },
    },
  );
}
