import { Component, computed, effect, inject, input, signal, OnInit } from '@angular/core';
import { getTenantSlug } from '@app/shared/utils/route-utils';
import { Router, ActivatedRoute } from '@angular/router';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucidePencil, lucideX } from '@ng-icons/lucide';
import { firstValueFrom, of } from 'rxjs';
import { TaskClient } from '@services/task-client';
import { LabelClient } from '@services/label-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { ProjectRefStore, type SelectOption } from '@stores/project-ref-store';
import { priorityBadgeVariant, priorityLabelKey } from '@app/constants/priority';
import { TranslocoService } from '@jsverse/transloco';
import { TASK_PRIORITY_LEVELS, type TaskPriorityLevel } from '@task-board/shared';
import type { Task, UpdateTask } from '@task-board/shared';
import { canManageProject, canWrite } from '@app/shared/utils/role-utils';
import { HttpErrorResponse } from '@angular/common/http';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmAutocompleteImports } from '@spartan-ng/helm/autocomplete';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { rxResource } from '@angular/core/rxjs-interop';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { CommentThread } from '@features/comments/comment-thread/comment-thread';
import { TaskRelationships } from '@features/tasks/task-relationships/task-relationships';
import { MilkdownEditor } from '@app/shared/milkdown-editor/milkdown-editor';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';

/**
 * Single-view task page: title and description are Atlassian-style
 * click-to-edit inline fields; side-panel selects stay immediate-apply.
 * There is no separate edit mode / Edit button.
 */
@Component({
  selector: 'ui-task-detail',
  imports: [
    ConfirmDialog,
    HlmAlertImports,
    DatePipe,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmCardImports,
    HlmInputImports,
    HlmBadgeImports,
    HlmAvatarImports,
    HlmSelectImports,
    HlmAutocompleteImports,
    HlmDialogImports,
    CommentThread,
    TaskRelationships,
    MilkdownEditor,
  ],
  providers: [provideIcons({ lucidePencil, lucideCheck, lucideX })],
  templateUrl: './task-detail.html',
})
export class TaskDetail implements OnInit {
  /** Shared badge/label helpers (see constants/priority.ts) */
  protected readonly priorityBadgeVariant = priorityBadgeVariant;
  protected readonly priorityLevels = TASK_PRIORITY_LEVELS;
  private readonly i18n = inject(TranslocoService);

  /** Translated priority label; unknown values render verbatim. */
  private priorityLabel(priorityLevel: TaskPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.i18n.translate(key) : String(priorityLevel);
  }
  private readonly notify = injectToasts();
  private readonly taskClient = inject(TaskClient);
  private readonly labelClient = inject(LabelClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly preferencesStore = inject(PreferencesStore);
  /** DatePipe token derived from the user's date/time format preference */
  protected readonly dateTimeFmt = this.preferencesStore.dateTimePipeFormat;
  /** Active language passed as the DatePipe locale for localized month names */
  protected readonly lang = this.preferencesStore.language;
  private readonly refStore = inject(ProjectRefStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /**
   * Canonical task URL segment (KEY-NUMBER, e.g. `ABC-123`) bound via
   * withComponentInputBinding() — the server resolves it to the task.
   */
  readonly taskNumber = input.required<string>();
  // No request until the URL segment is meaningful — a blank `taskNumber`
  // (e.g. navigating to `…/tasks/` before the segment is bound) would hit
  // `GET /tasks/` and poison the resource with the SPA-fallback HTML.
  private readonly taskResource = rxResource<Task | null, { taskNumber: string }>({
    params: () => ({ taskNumber: this.taskNumber() }),
    stream: ({ params }) => (params.taskNumber ? this.taskClient.getById(params.taskNumber) : of(null)),
    defaultValue: null,
  });
  private readonly task = computed(() => (this.taskResource.hasValue() ? this.taskResource.value() : null));
  private readonly projectId = computed(() => this.task()?.projectId ?? '');
  // ─── Inline edit state (Atlassian inline-edit pattern) ──────────────────────
  private readonly editingTitle = signal(false);
  private readonly titleDraft = signal('');
  private readonly editingDescription = signal(false);
  private readonly descriptionDraft = signal('');
  private readonly error = signal('');
  private readonly currentUserId = signal('');
  private readonly showDeleteConfirm = signal(false);
  private readonly showConflictDialog = signal(false);
  private readonly conflictMessage = signal('');
  private readonly taskToDelete = signal<Task | null>(null);
  // ─── Reference data via the shared per-project store ───────────────────────
  private readonly statusOptions = computed(() => this.refStore.options(this.projectId(), 'statuses'));
  private readonly typeOptions = computed(() => this.refStore.options(this.projectId(), 'types'));
  private readonly sprintOptions = computed(() => this.refStore.options(this.projectId(), 'sprints'));
  private readonly labelOptions = computed(() => this.refStore.options(this.projectId(), 'labels'));
  private readonly memberOptions = computed(() => this.refStore.options(this.projectId(), 'members'));
  /** Resolved entity names for display */
  protected readonly statusName = computed(() => {
    const t = this.task();

    return t ? this.refStore.nameOf(this.projectId(), 'statuses', t.statusId) : '';
  });
  protected readonly typeName = computed(() => {
    const t = this.task();

    return t ? this.refStore.nameOf(this.projectId(), 'types', t.typeId) : '';
  });
  protected readonly sprintName = computed(() => {
    const t = this.task();

    return t?.sprintId ? this.refStore.nameOf(this.projectId(), 'sprints', t.sprintId) : '';
  });
  /** Current labels of the task resolved to id/name options */
  protected readonly selectedLabels = computed<SelectOption[]>(() => {
    const t = this.task();

    if (!t) return [];

    return t.labelIds.map((id) => ({ id, name: this.refStore.nameOf(this.projectId(), 'labels', id) }));
  });
  /** itemToString helpers for hlm-select to display human-readable labels */
  protected readonly statusItemToString = (id: string) => this.statusOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly typeItemToString = (id: string) => this.typeOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly assigneeItemToString = (id: string) => this.memberOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly sprintItemToString = (id: string) => this.sprintOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly priorityItemToString = (value: TaskPriorityLevel) => this.priorityLabel(value);
  // ─── Labels: case-insensitive autocomplete + create-new ─────
  /** Free-text search buffer for the label autocomplete */
  private readonly labelSearch = signal('');
  /** Existing labels matching the search, excluding already-applied ones */
  protected readonly filteredLabelOptions = computed(() => {
    const search = this.labelSearch().toLowerCase();
    const applied = new Set(this.task()?.labelIds ?? []);

    return this.labelOptions().filter((o) => !applied.has(o.id) && o.name.toLowerCase().includes(search));
  });
  /** A new label can be created when the search is non-empty and matches no existing label case-insensitively */
  protected readonly canCreateLabel = computed(() => {
    const name = this.labelSearch().trim().toLowerCase();

    if (!name) return false;

    return !this.labelOptions().some((o) => o.name.toLowerCase() === name);
  });
  /** Synthetic option representing "create a new label with the typed name" */
  protected readonly newLabelOption = computed<SelectOption>(() => ({ id: '', name: this.labelSearch().trim() }));

  constructor() {
    // Load per-project reference data once (deduped by the store)
    effect(() => {
      this.refStore.ensure(this.projectId(), ['statuses', 'types', 'sprints', 'labels', 'members']);
    });
  }

  ngOnInit(): void {
    const user = this.authStore.currentUser();

    if (user) {
      this.currentUserId.set(user.id);
    }
  }

  protected taskLabel(): string {
    const t = this.task();

    if (!t) return '';

    const key = this.projectStore.activeProject()?.key;

    return key ? `${key}-${t.number}` : `#${t.number}`;
  }

  protected canDelete(): boolean {
    return canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole());
  }

  /** Whether the current user may edit task fields (Editor+ or tenant ADMIN+) */
  private canEdit(): boolean {
    return canWrite(this.projectStore.projectRole(), this.authStore.tenantRole());
  }

  /** Whether the current user can edit comments (same permission as field editing) */
  protected canEditComments(): boolean {
    return this.canEdit();
  }

  // ─── Inline title edit ──────────────────────────────────────────────────────

  protected startTitleEdit(): void {
    const t = this.task();

    if (!t || !this.canEdit()) return;

    this.titleDraft.set(t.title);
    this.editingTitle.set(true);
  }

  protected confirmTitleEdit(): void {
    if (!this.editingTitle()) return;

    const t = this.task();
    const title = this.titleDraft().trim();

    if (!t || !title) return;

    this.editingTitle.set(false);
    this.titleDraft.set('');

    if (title === t.title) return;

    this.updateField('title', title);
  }

  protected cancelTitleEdit(): void {
    this.editingTitle.set(false);
    this.titleDraft.set('');
  }

  // ─── Inline description edit (keepEditViewOpenOnBlur semantics) ─────────────

  protected startDescriptionEdit(): void {
    const t = this.task();

    if (!t || !this.canEdit()) return;

    this.descriptionDraft.set(t.description ?? '');
    this.editingDescription.set(true);
  }

  protected confirmDescriptionEdit(): void {
    if (!this.editingDescription()) return;

    const t = this.task();
    const description = this.descriptionDraft().trim();

    if (!t) return;

    this.editingDescription.set(false);
    this.descriptionDraft.set('');

    if (description === (t.description ?? '')) return;

    this.updateField('description', description);
  }

  protected cancelDescriptionEdit(): void {
    this.editingDescription.set(false);
    this.descriptionDraft.set('');
  }

  // ─── Labels ─────────────────────────────────────────────────────────────────

  /** Add a picked label (existing or to-be-created); PATCHes labelIds immediately */
  protected async onLabelPicked(option: SelectOption): Promise<void> {
    const t = this.task();

    if (!t || !option?.name) return;

    this.labelSearch.set('');

    let id = option.id;

    if (!id) {
      const name = option.name.trim().toLowerCase();
      // Case-insensitive reuse of an existing project label
      const existing = this.labelOptions().find((o) => o.name.toLowerCase() === name);

      if (existing) {
        id = existing.id;
      } else {
        try {
          const created = await firstValueFrom(this.labelClient.create(t.projectId, { name: option.name.trim() }));

          id = created.id;
          this.refStore.invalidate(t.projectId, 'labels');
        } catch (err) {
          this.notify.error(getErrorMessage(err));

          return;
        }
      }
    }

    if (t.labelIds.includes(id)) return;

    this.updateField('labelIds', [...t.labelIds, id]);
  }

  protected removeLabel(labelId: string): void {
    const t = this.task();

    if (!t) return;

    this.updateField(
      'labelIds',
      t.labelIds.filter((id) => id !== labelId),
    );
  }

  // ─── Generic single-field update (Jira-style immediate apply) ───────────────

  /** Typed single-field update — `field` is constrained to the
   * updatable `UpdateTask` keys. Template selects may emit null/undefined while
   * settling; the value is forwarded verbatim (server validates the body). */
  /** Select values arrive as strings — coerce to the numeric priority level. */
  protected updatePriorityLevel(value: unknown): void {
    this.updateField('priorityLevel', Number(value) as UpdateTask['priorityLevel']);
  }

  private updateField<K extends keyof UpdateTask>(field: K, value: UpdateTask[K] | null | undefined): void {
    const t = this.task();

    if (!t) return;

    const update = { version: t.version, [field]: value } as UpdateTask;

    this.taskClient.update(t.id, update).subscribe({
      next: (updated) => this.taskResource.value.set(updated),
      error: (err) => this.handleUpdateError(err),
    });
  }

  private handleUpdateError(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 409) {
      this.conflictMessage.set(
        (err as HttpErrorResponse & { userMessage?: string }).userMessage ?? 'taskDetail.conflictHint',
      );
      this.showConflictDialog.set(true);
    } else {
      this.error.set(getErrorMessage(err));
    }
  }

  protected confirmDeleteTask(task: Task): void {
    this.taskToDelete.set(task);
    this.showDeleteConfirm.set(true);
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteConfirm.set(false);
      this.taskToDelete.set(null);
    }
  }

  onConflictDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showConflictDialog.set(false);
    }
  }

  /** Reload task from server to resolve conflict */
  protected reloadAfterConflict(): void {
    this.showConflictDialog.set(false);
    this.taskResource.reload();
  }

  protected deleteTask(): void {
    const task = this.taskToDelete();

    if (!task) return;

    this.taskClient.delete(task.id).subscribe({
      next: () => {
        // Navigate using project key from store
        const projectKey = this.projectStore.activeProject()?.key ?? task.projectId;

        this.router.navigate(['/w', getTenantSlug(this.route), 'projects', projectKey]);
      },
    });
  }
}
