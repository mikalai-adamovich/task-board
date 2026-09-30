import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucidePlus, lucidePencil, lucideTrash2, lucideCheck, lucideX, lucideGripVertical } from '@ng-icons/lucide';
import { finalize, tap } from 'rxjs';
import { TaskTypeClient } from '@services/task-type-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
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
import type { TaskType, CreateTaskType } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface CreateTaskTypeForm {
  key: string;
  name: string;
  icon: string;
}

@Component({
  selector: 'ui-task-type-manager',
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
  templateUrl: './task-type-manager.html',
})
export class TaskTypeManager implements OnInit {
  private readonly notify = injectUndoToasts();
  private readonly taskTypeClient = inject(TaskTypeClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  protected readonly canManage = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** Bound via withComponentInputBinding() — now receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  private readonly taskTypes = signal<TaskType[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly showCreateDialog = signal(false);
  private readonly showDeleteDialog = signal(false);
  private readonly deletingType = signal<TaskType | null>(null);
  private readonly replacementTypeId = signal('');
  private readonly editingId = signal<string | null>(null);
  private readonly editingName = signal('');
  private readonly editingIcon = signal('');
  private readonly saving = signal(false);
  private readonly createModel = signal<CreateTaskTypeForm>({ key: '', name: '', icon: '' });
  protected readonly createForm = form(
    this.createModel,
    schema<CreateTaskTypeForm>((field) => {
      required(field.key, { message: 'validation.taskTypeKeyRequired' });
      required(field.name, { message: 'validation.taskTypeNameRequired' });
      required(field.icon, { message: 'validation.taskTypeIconRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          this.error.set('');

          const maxPosition = this.taskTypes().reduce((max, t) => Math.max(max, t.position), -1);
          const model = this.createModel();
          const data: CreateTaskType = {
            key: model.key.toUpperCase(),
            name: model.name,
            icon: model.icon,
            position: maxPosition + 1,
          };

          this.taskTypeClient.create(this.projectId(), data).subscribe({
            next: (taskType) => {
              this.taskTypes.update((list) => [...list, taskType]);
              this.showCreateDialog.set(false);
              f().reset({ key: '', name: '', icon: '' });
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
  protected readonly otherTaskTypes = computed(() => {
    const deletingId = this.deletingType()?.id;

    return this.taskTypes().filter((t) => t.id !== deletingId);
  });

  protected startEdit(taskType: TaskType): void {
    this.editingId.set(taskType.id);
    this.editingName.set(taskType.name);
    this.editingIcon.set(taskType.icon ?? '');
  }

  private cancelEdit(): void {
    this.editingId.set(null);
    this.editingName.set('');
    this.editingIcon.set('');
  }

  protected saveEdit(taskType: TaskType): void {
    const name = this.editingName().trim();
    const icon = this.editingIcon().trim();

    if ((!name || name === taskType.name) && (!icon || icon === taskType.icon)) {
      this.cancelEdit();
      return;
    }

    const updateData: { name?: string; icon?: string } = {};

    if (name && name !== taskType.name) updateData.name = name;
    if (icon && icon !== taskType.icon) updateData.icon = icon;

    this.saving.set(true);
    this.taskTypeClient
      .update(taskType.id, updateData)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.taskTypes.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
          this.cancelEdit();
          this.notify.success('toasts.updated');
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }

  protected moveUp(taskType: TaskType): void {
    const sorted = [...this.taskTypes()].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((t) => t.id === taskType.id);

    if (idx <= 0) return;

    const target = sorted[idx - 1];

    if (!target) return;

    this.swapPositions(taskType, target);
  }

  protected moveDown(taskType: TaskType): void {
    const sorted = [...this.taskTypes()].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((t) => t.id === taskType.id);

    if (idx < 0 || idx >= sorted.length - 1) return;

    const target = sorted[idx + 1];

    if (!target) return;

    this.swapPositions(taskType, target);
  }

  private swapPositions(a: TaskType, b: TaskType): void {
    this.saving.set(true);

    // Single bulk reorder — no risk of inconsistent positions on partial failure
    this.taskTypeClient
      .reorder(this.projectId(), [
        { id: a.id, position: b.position },
        { id: b.id, position: a.position },
      ])
      .subscribe({
        next: (updated) => {
          const updatedById = new Map(updated.map((t) => [t.id, t]));

          this.taskTypes.update((list) => list.map((t) => updatedById.get(t.id) ?? t));
          this.saving.set(false);
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected confirmDelete(taskType: TaskType): void {
    this.deletingType.set(taskType);
    this.replacementTypeId.set('');
    this.showDeleteDialog.set(true);
  }

  protected deleteTaskType(): void {
    const taskType = this.deletingType();

    if (!taskType) return;

    this.saving.set(true);

    const replacementId = this.replacementTypeId() || undefined;

    this.taskTypeClient
      .delete(taskType.id, replacementId)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.taskTypes.update((list) => list.filter((t) => t.id !== taskType.id));
          this.showDeleteDialog.set(false);
          this.deletingType.set(null);
          // Undo recreates the type with the same immutable key,
          // name and icon. Position caveat: the original position may already be
          // taken — recreated at the end of the list.
          this.notify.successWithUndo('toasts.deleted', () => {
            const maxPosition = this.taskTypes().reduce((max, t) => Math.max(max, t.position), -1);

            return this.taskTypeClient
              .create(this.projectId(), {
                key: taskType.key,
                name: taskType.name,
                icon: taskType.icon ?? undefined,
                position: maxPosition + 1,
              })
              .pipe(tap((created) => this.taskTypes.update((list) => [...list, created])));
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
      this.deletingType.set(null);
    }
  }

  ngOnInit(): void {
    this.loadTaskTypes();
  }

  private loadTaskTypes(): void {
    this.loading.set(true);
    this.error.set('');
    this.taskTypeClient
      .list(this.projectId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (types) => {
          this.taskTypes.set(types.sort((a, b) => a.position - b.position));
        },
        error: (err) => {
          this.error.set(getErrorMessage(err));
        },
      });
  }
}
