import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucidePlus, lucidePencil, lucideTrash2, lucideCheck, lucideX, lucideGripVertical } from '@ng-icons/lucide';
import { finalize, tap } from 'rxjs';
import { StatusClient } from '@services/status-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { canManageProject } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { form, FormField, FormRoot, schema, required } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import type { Status, CreateStatus } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface CreateStatusForm {
  name: string;
}

@Component({
  selector: 'ui-status-manager',
  imports: [
    FieldControl,
    HlmAlertImports,
    HlmEmptyImports,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmDialogImports,
    HlmSpinnerImports,
    HlmFieldImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmCardImports,
    HlmBadgeImports,
    FormField,
    FormRoot,
  ],
  providers: [provideIcons({ lucidePlus, lucidePencil, lucideTrash2, lucideCheck, lucideX, lucideGripVertical })],
  templateUrl: './status-manager.html',
})
export class StatusManager implements OnInit {
  private readonly notify = injectUndoToasts();
  private readonly statusClient = inject(StatusClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  /** Status mutations must invalidate the shared reference-data cache */
  private readonly refStore = inject(ProjectRefStore);
  protected readonly canManage = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** Bound via withComponentInputBinding() — now receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  private readonly statuses = signal<Status[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly showCreateDialog = signal(false);
  private readonly showDeleteDialog = signal(false);
  private readonly deletingStatus = signal<Status | null>(null);
  private readonly replacementStatusId = signal('');
  private readonly editingId = signal<string | null>(null);
  private readonly editingName = signal('');
  private readonly saving = signal(false);
  private readonly createModel = signal<CreateStatusForm>({ name: '' });
  protected readonly createForm = form(
    this.createModel,
    schema<CreateStatusForm>((field) => {
      required(field.name, { message: 'validation.statusNameRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          this.error.set('');

          const maxPosition = this.statuses().reduce((max, s) => Math.max(max, s.position), -1);
          const data: CreateStatus = { name: this.createModel().name, position: maxPosition + 1 };

          this.statusClient.create(this.projectId(), data).subscribe({
            next: (status) => {
              this.statuses.update((list) => [...list, status]);
              this.refStore.invalidate(this.projectId(), 'statuses');
              this.showCreateDialog.set(false);
              f().reset({ name: '' });
              this.error.set(''); // V2-8: state changed — dismiss stale alerts
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
  protected readonly otherStatuses = computed(() => {
    const deletingId = this.deletingStatus()?.id;

    return this.statuses().filter((s) => s.id !== deletingId);
  });

  protected startEdit(status: Status): void {
    this.editingId.set(status.id);
    this.editingName.set(status.name);
  }

  private cancelEdit(): void {
    this.editingId.set(null);
    this.editingName.set('');
  }

  protected saveEdit(status: Status): void {
    const name = this.editingName().trim();

    if (!name || name === status.name) {
      this.cancelEdit();
      return;
    }

    this.saving.set(true);
    this.statusClient
      .update(status.id, { name })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.statuses.update((list) => list.map((s) => (s.id === updated.id ? updated : s)));
          this.refStore.invalidate(this.projectId(), 'statuses');
          this.cancelEdit();
          this.error.set(''); // V2-8: state changed — dismiss stale alerts
          this.notify.success('toasts.updated');
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }

  protected moveUp(status: Status): void {
    const sorted = [...this.statuses()].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === status.id);

    if (idx <= 0) return;

    const target = sorted[idx - 1];

    if (!target) return;

    this.swapPositions(status, target);
  }

  protected moveDown(status: Status): void {
    const sorted = [...this.statuses()].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === status.id);

    if (idx < 0 || idx >= sorted.length - 1) return;

    const target = sorted[idx + 1];

    if (!target) return;

    this.swapPositions(status, target);
  }

  private swapPositions(a: Status, b: Status): void {
    this.saving.set(true);

    // Single bulk reorder — no risk of inconsistent positions on partial failure
    this.statusClient
      .reorder(this.projectId(), [
        { id: a.id, position: b.position },
        { id: b.id, position: a.position },
      ])
      .subscribe({
        next: (updated) => {
          const updatedById = new Map(updated.map((s) => [s.id, s]));

          this.statuses.update((list) => list.map((s) => updatedById.get(s.id) ?? s));
          this.refStore.invalidate(this.projectId(), 'statuses');
          this.saving.set(false);
          this.error.set(''); // V2-8: state changed — dismiss stale alerts
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected confirmDelete(status: Status): void {
    this.deletingStatus.set(status);
    this.replacementStatusId.set('');
    this.showDeleteDialog.set(true);
  }

  protected deleteStatus(): void {
    const status = this.deletingStatus();

    if (!status) return;

    this.saving.set(true);
    // V2-8: dismiss any stale inline alert before a new attempt — it described
    // the previous failure and must not survive a state change.
    this.error.set('');

    const replacementId = this.replacementStatusId() || undefined;

    this.statusClient
      .delete(status.id, replacementId)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.statuses.update((list) => list.filter((s) => s.id !== status.id));
          this.refStore.invalidate(this.projectId(), 'statuses');
          this.showDeleteDialog.set(false);
          this.deletingStatus.set(null);
          this.error.set('');
          // Undo caveat — the original position may already be
          // taken by other statuses after deletion, so the status is recreated
          // at the END of the list instead of restoring its exact position.
          this.notify.successWithUndo('toasts.deleted', () => {
            const maxPosition = this.statuses().reduce((max, s) => Math.max(max, s.position), -1);

            return this.statusClient.create(this.projectId(), { name: status.name, position: maxPosition + 1 }).pipe(
              tap((created) => {
                this.statuses.update((list) => [...list, created]);
                this.refStore.invalidate(this.projectId(), 'statuses');
              }),
            );
          });
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }

  protected onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showCreateDialog.set(false);
    }
  }

  protected onDeleteDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showDeleteDialog.set(false);
      this.deletingStatus.set(null);
    }
  }

  ngOnInit(): void {
    this.loadStatuses();
  }

  private loadStatuses(): void {
    this.loading.set(true);
    this.error.set('');
    this.statusClient
      .list(this.projectId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (statuses) => {
          this.statuses.set(statuses.sort((a, b) => a.position - b.position));
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }
}
