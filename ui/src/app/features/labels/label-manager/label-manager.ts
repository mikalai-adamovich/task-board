import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucidePlus, lucidePencil, lucideTrash2, lucideCheck, lucideX, lucideTag } from '@ng-icons/lucide';
import { finalize, tap } from 'rxjs';
import { LabelClient } from '@services/label-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { canManageProject } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { form, FormField, FormRoot, schema, required } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import type { Label, CreateLabel } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';

interface CreateLabelForm {
  name: string;
}

@Component({
  selector: 'ui-label-manager',
  imports: [
    FieldControl,
    ConfirmDialog,
    HlmAlertImports,
    HlmEmptyImports,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmDialogImports,
    HlmSpinnerImports,
    HlmFieldImports,
    HlmInputImports,
    HlmBadgeImports,
    FormField,
    FormRoot,
  ],
  providers: [provideIcons({ lucidePlus, lucidePencil, lucideTrash2, lucideCheck, lucideX, lucideTag })],
  templateUrl: './label-manager.html',
})
export class LabelManager implements OnInit {
  private readonly notify = injectUndoToasts();
  private readonly labelClient = inject(LabelClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  protected readonly canManage = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** Bound via withComponentInputBinding() — now receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  private readonly labels = signal<Label[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly showCreateDialog = signal(false);
  private readonly showDeleteDialog = signal(false);
  private readonly deletingLabel = signal<Label | null>(null);
  private readonly editingId = signal<string | null>(null);
  private readonly editingName = signal('');
  private readonly saving = signal(false);
  private readonly createModel = signal<CreateLabelForm>({ name: '' });
  protected readonly createForm = form(
    this.createModel,
    schema<CreateLabelForm>((field) => {
      required(field.name, { message: 'validation.labelNameRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          this.error.set('');

          const data: CreateLabel = { name: this.createModel().name.trim() };

          this.labelClient.create(this.projectId(), data).subscribe({
            next: (label) => {
              this.labels.update((list) => [...list, label]);
              this.showCreateDialog.set(false);
              f().reset({ name: '' });
              this.notify.success('toasts.created');
            },
            error: (err) => {
              this.error.set(getErrorMessage(err));
            },
          });
        },
      },
    },
  );

  protected startEdit(label: Label): void {
    this.editingId.set(label.id);
    this.editingName.set(label.name);
  }

  private cancelEdit(): void {
    this.editingId.set(null);
    this.editingName.set('');
  }

  protected saveEdit(label: Label): void {
    const name = this.editingName().trim();

    if (!name || name === label.name) {
      this.cancelEdit();
      return;
    }

    this.saving.set(true);
    this.labelClient
      .update(label.id, { name })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.labels.update((list) => list.map((l) => (l.id === updated.id ? updated : l)));
          this.cancelEdit();
          this.notify.success('toasts.updated');
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }

  protected confirmDelete(label: Label): void {
    this.deletingLabel.set(label);
    this.showDeleteDialog.set(true);
  }

  protected deleteLabel(): void {
    const label = this.deletingLabel();

    if (!label) return;

    this.saving.set(true);
    this.labelClient
      .delete(label.id)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.labels.update((list) => list.filter((l) => l.id !== label.id));
          this.showDeleteDialog.set(false);
          this.deletingLabel.set(null);
          // Undo recreates the label with the same name — labels
          // carry no color in this app, so name is the full restorable state.
          this.notify.successWithUndo('toasts.deleted', () =>
            this.labelClient
              .create(this.projectId(), { name: label.name })
              .pipe(tap((created) => this.labels.update((list) => [...list, created]))),
          );
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }

  onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showCreateDialog.set(false);
    }
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteDialog.set(false);
      this.deletingLabel.set(null);
    }
  }

  ngOnInit(): void {
    this.loadLabels();
  }

  private loadLabels(): void {
    this.loading.set(true);
    this.error.set('');
    this.labelClient
      .list(this.projectId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (labels) => {
          this.labels.set(labels);
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }
}
