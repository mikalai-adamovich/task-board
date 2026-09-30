import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT, Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormField, FormRoot, schema, required, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmAutocompleteImports } from '@spartan-ng/helm/autocomplete';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { TaskClient } from '@services/task-client';
import { LabelClient } from '@services/label-client';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore, type SelectOption } from '@stores/project-ref-store';
import { getTenantSlug } from '@app/shared/utils/route-utils';
import { MilkdownEditor } from '@app/shared/milkdown-editor/milkdown-editor';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import type { PendingChanges } from '@app/shared/pending-changes/pending-changes.guard';
import { DEFAULT_TASK_PRIORITY_LEVEL, type TaskPriorityLevel } from '@task-board/shared';
import { PRIORITY_OPTIONS } from '@app/constants/priority';
import type { CreateTask, Task } from '@task-board/shared';

interface CreateTaskFormModel {
  title: string;
  description: string;
  statusId: string;
  priorityLevel: TaskPriorityLevel;
  typeId: string;
  assigneeId: string;
  sprintId: string;
}

/**
 * Unified create-task page — same layout as task detail, rendered in
 * create mode at `…/tasks/new`. Replaces the board and task-table dialogs.
 *
 * P13b (Fix 4): implements {@link PendingChanges} — while the form is dirty
 * (or labels were picked), the `pendingChangesGuard` on the route asks for
 * confirmation before any in-app navigation, and a `beforeunload` listener
 * warns before a full page close/reload.
 */
@Component({
  selector: 'ui-task-create',
  imports: [
    FieldControl,
    TranslocoPipe,
    FormField,
    FormRoot,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmCardImports,
    HlmFieldImports,
    HlmInputImports,
    HlmBadgeImports,
    HlmSelectImports,
    HlmAutocompleteImports,
    HlmAlertImports,
    MilkdownEditor,
  ],
  templateUrl: './create-task.html',
})
export class TaskCreate implements PendingChanges {
  private readonly notify = injectToasts();
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly taskClient = inject(TaskClient);
  private readonly labelClient = inject(LabelClient);
  private readonly projectStore = inject(ProjectStore);
  private readonly refStore = inject(ProjectRefStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  /** Resolved project UUID (projectGuard hydrates the store before activation) */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  // ─── Reference data via the shared per-project store ───────────────────────
  private readonly statusOptions = computed(() => this.refStore.options(this.projectId(), 'statuses'));
  private readonly typeOptions = computed(() => this.refStore.options(this.projectId(), 'types'));
  private readonly sprintOptions = computed(() => this.refStore.options(this.projectId(), 'sprints'));
  private readonly labelOptions = computed(() => this.refStore.options(this.projectId(), 'labels'));
  private readonly memberOptions = computed(() => this.refStore.options(this.projectId(), 'members'));
  /** itemToString helpers for hlm-select to display human-readable labels */
  protected readonly statusItemToString = (id: string) => this.statusOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly typeItemToString = (id: string) => this.typeOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly assigneeItemToString = (id: string) => this.memberOptions().find((o) => o.id === id)?.name ?? id;
  protected readonly sprintItemToString = (id: string) => this.sprintOptions().find((o) => o.id === id)?.name ?? id;
  // ─── Form ──────────────────────────────────────────────────────────────────
  /**
   * One-shot latch for the status/type defaults applied in the constructor.
   * A plain field, not a signal: the defaults effect must not re-trigger on it.
   */
  private defaultsApplied = false;
  private readonly model = signal<CreateTaskFormModel>({
    title: '',
    description: '',
    statusId: '',
    priorityLevel: DEFAULT_TASK_PRIORITY_LEVEL,
    typeId: '',
    assigneeId: '',
    sprintId: '',
  });
  private readonly error = signal('');
  private readonly createForm = form(
    this.model,
    schema<CreateTaskFormModel>((field) => {
      required(field.title, { message: 'validation.titleRequired' });
      // V4-3: mirror the server's 255-char title limit client-side
      maxLength(field.title, 255, { message: 'validation.titleMaxLength' });
      required(field.typeId, { message: 'validation.typeRequired' });
      required(field.statusId, { message: 'validation.statusRequired' });
      required(field.priorityLevel, { message: 'validation.priorityRequired' });
    }),
    {
      submission: {
        action: async () => {
          this.error.set('');

          const m = this.model();
          const pid = this.projectId();
          const title = m.title.trim();

          if (!title || !pid || !m.typeId || !m.statusId) return;

          try {
            const labelIds = await this.resolveLabelIds();
            const payload: CreateTask = {
              title,
              typeId: m.typeId,
              statusId: m.statusId,
              priorityLevel: m.priorityLevel,
            };
            const description = m.description.trim();

            if (description) payload.description = description;
            if (m.assigneeId) payload.assigneeId = m.assigneeId;
            if (m.sprintId) payload.sprintId = m.sprintId;
            if (labelIds.length > 0) payload.labelIds = labelIds;

            const task = await firstValueFrom(this.taskClient.create(pid, payload));

            // P13b (Fix 4): clear dirty state BEFORE navigating so the
            // pending-changes guard lets the navigation through.
            this.createForm().reset();
            this.selectedLabels.set([]);

            this.notify.success('toasts.created');
            this.goToCreatedTask(task);
          } catch (err) {
            this.error.set(getErrorMessage(err));
          }
        },
      },
    },
  );
  // ─── Labels (case-insensitive autocomplete) ────────────────────────
  /** Free-text search buffer for the label autocomplete */
  private readonly labelSearch = signal('');
  /** Selected labels; `id === ''` marks a label that will be created on submit */
  private readonly selectedLabels = signal<SelectOption[]>([]);
  /** Existing labels matching the search, excluding already-selected ones */
  protected readonly filteredLabelOptions = computed(() => {
    const search = this.labelSearch().toLowerCase();
    const selected = new Set(this.selectedLabels().map((l) => l.id));

    return this.labelOptions().filter((o) => !selected.has(o.id) && o.name.toLowerCase().includes(search));
  });
  /** A new label can be created when the search is non-empty and matches no existing label case-insensitively */
  protected readonly canCreateLabel = computed(() => {
    const name = this.labelSearch().trim().toLowerCase();

    if (!name) return false;

    return !this.labelOptions().some((o) => o.name.toLowerCase() === name);
  });
  /** Synthetic option representing "create a new label with the typed name" */
  protected readonly newLabelOption = computed<SelectOption>(() => ({ id: '', name: this.labelSearch().trim() }));
  protected readonly labelItemToString = (option: SelectOption) => option?.name ?? '';

  /**
   * P13b (Fix 4): the form is "pending" once the user modified any field
   * (Signal Forms aggregate `dirty` over all descendant fields) or picked any
   * labels — both would be silently lost on navigation.
   */
  public hasPendingChanges(): boolean {
    // FieldTree is callable → root FieldState; `dirty` aggregates descendants.
    return this.createForm().dirty() || this.selectedLabels().length > 0;
  }

  constructor() {
    effect(() => {
      this.refStore.ensure(this.projectId(), ['statuses', 'types', 'sprints', 'labels', 'members']);
    });

    // P13b (Fix 4): while the form has pending changes, warn on full page
    // close/reload (standard browser dialog). The listener is added/removed
    // reactively and always detached on destroy.
    effect(() => {
      const win = this.document.defaultView;

      if (!win) return;

      if (this.hasPendingChanges()) win.addEventListener('beforeunload', TaskCreate.warnOnUnload);
      else win.removeEventListener('beforeunload', TaskCreate.warnOnUnload);
    });

    this.destroyRef.onDestroy(() => {
      this.document.defaultView?.removeEventListener('beforeunload', TaskCreate.warnOnUnload);
    });

    // V4-5 / R3-P1: preselect by ID — `project.defaultStatusId` when present among
    // the loaded statuses, otherwise the first status by position. No name matching.
    // The two defaults below are applied EXACTLY ONCE, by a single effect
    // that reads only the reference data and NEVER reads the form model. The
    // previous pair of effects read the very model they wrote, so they re-ran on
    // every keystroke and re-filled the field as soon as the user cleared it:
    // the form fought the user. The `defaultsApplied` latch turns this into an
    // initialisation step, so a later refetch (invalidate and re-ensure) can no
    // longer overwrite a value the user already chose.
    effect(() => {
      const statuses = this.statusOptions();
      const types = this.typeOptions();

      if (this.defaultsApplied || statuses.length === 0 || types.length === 0) return;

      const defaultStatusId = this.projectStore.activeProject()?.defaultStatusId;
      const preselect =
        defaultStatusId && statuses.some((s) => s.id === defaultStatusId) ? defaultStatusId : statuses[0]?.id;
      const firstTypeId = types[0]?.id;

      if (!preselect || !firstTypeId) return;

      this.defaultsApplied = true;
      this.model.update((m) => ({ ...m, statusId: preselect, typeId: firstTypeId }));
    });
  }

  /** Handle Milkdown editor content change */
  protected onDescriptionChange(markdown: string): void {
    this.model.update((m) => ({ ...m, description: markdown }));
  }

  /** Priority selector options — derived from the shared TASK_PRIORITY_CONFIG. */
  protected readonly PRIORITY_OPTIONS = PRIORITY_OPTIONS;

  // `onPriorityLevelChange` is gone. The priority `<hlm-select>` is
  // now bound with `[formField]`, so the `BrnSelect` control-value accessor
  // delivers the item's own `value` — a `TaskPriorityLevel` number, because
  // `PRIORITY_OPTIONS` is typed `value: TaskPriorityLevel`. The old handler
  // existed only to re-coerce a `$any($event)` string; nothing coerces now.

  protected onFieldChange<K extends keyof CreateTaskFormModel>(field: K, value: CreateTaskFormModel[K]): void {
    this.model.update((m) => ({ ...m, [field]: value }));
  }

  /** Add a picked label (existing or to-be-created) unless already selected */
  protected onLabelPicked(option: SelectOption): void {
    if (!option?.name) return;

    const name = option.name.toLowerCase();
    const alreadySelected =
      this.selectedLabels().some((l) => (option.id ? l.id === option.id : l.name.toLowerCase() === name)) ||
      this.labelOptions().some(
        (o) => o.name.toLowerCase() === name && this.selectedLabels().some((l) => l.id === o.id),
      );

    if (alreadySelected) {
      this.labelSearch.set('');
      return;
    }

    this.selectedLabels.update((labels) =>
      option.id ? [...labels, option] : [...labels, { id: '', name: option.name }],
    );
    this.labelSearch.set('');
  }

  protected removeLabel(label: SelectOption): void {
    this.selectedLabels.update((labels) => labels.filter((l) => l !== label));
  }

  protected cancel(): void {
    this.location.back();
  }

  /**
   * Resolve selected labels to ids. Existing ids pass through; pending names are
   * resolved case-insensitively against project labels first and only
   * created when no match exists.
   */
  private async resolveLabelIds(): Promise<string[]> {
    const pid = this.projectId();
    const ids: string[] = [];
    let createdNew = false;

    for (const label of this.selectedLabels()) {
      if (label.id) {
        ids.push(label.id);
        continue;
      }

      const existing = this.labelOptions().find((o) => o.name.toLowerCase() === label.name.toLowerCase());

      if (existing) {
        ids.push(existing.id);
        continue;
      }

      const created = await firstValueFrom(this.labelClient.create(pid, { name: label.name }));

      ids.push(created.id);
      createdNew = true;
    }

    if (createdNew) this.refStore.invalidate(pid, 'labels');

    return [...new Set(ids)];
  }

  /** Navigate to the canonical URL of the freshly created task */
  private goToCreatedTask(task: Task): void {
    const key =
      this.projectStore.activeProject()?.key ?? this.route.snapshot.paramMap.get('projectKey') ?? task.projectId;

    this.router.navigate(['/w', getTenantSlug(this.route), 'projects', key, 'tasks', `${key}-${task.number}`]);
  }

  /** P13b (Fix 4): static handler so add/removeEventListener refer to ONE fn. */
  private static warnOnUnload(event: BeforeUnloadEvent): void {
    // Standard browser dialog; returnValue is the legacy trigger.
    event.preventDefault();
    event.returnValue = '';
  }
}
