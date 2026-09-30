import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucidePencil, lucideTrash2 } from '@ng-icons/lucide';
import { rxResource } from '@angular/core/rxjs-interop';
import { of, tap } from 'rxjs';
import { form, FormField, FormRoot, required, schema } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { FilterClient } from '@services/filter-client';
import { ProjectRefStore } from '@stores/project-ref-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import type { Filter, FilterCriteria, FilterSort, CreateFilter, TaskPriorityLevel } from '@task-board/shared';
import { PRIORITY_OPTIONS } from '@app/constants/priority';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';

export interface AppliedFilterState {
  filters: FilterCriteria;
  sort: FilterSort;
}

/** Single-value criteria keys editable through the panel's select fields */
type SingleFilterKey = 'statusIds' | 'typeIds' | 'assigneeIds' | 'reporterIds' | 'sprintIds' | 'labelIds';

/** Signal-Forms model for the save / rename name inputs */
interface ViewNameForm {
  name: string;
}

/**
 * Order-insensitive structural comparison used for active-view detection:
 * two views match the current state when their criteria and sort are deeply
 * equal regardless of key insertion order.
 */
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((k) => `${k}:${stableValue(record[k])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

@Component({
  selector: 'ui-filter-panel',
  imports: [
    FieldControl,
    ConfirmDialog,
    HlmAlertImports,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmCardImports,
    HlmInputImports,
    HlmDialogImports,
    HlmFieldImports,
    HlmNativeSelectImports,
    FormField,
    FormRoot,
  ],
  providers: [provideIcons({ lucideCheck, lucidePencil, lucideTrash2 })],
  templateUrl: './filter-panel.html',
})
export class FilterPanel {
  private readonly notify = injectUndoToasts();
  private readonly filterClient = inject(FilterClient);
  /** Per-project reference data for the filter-field option lists */
  private readonly refStore = inject(ProjectRefStore);
  /** Project ID to load filters for */
  readonly projectId = input.required<string>();
  /** Current filter criteria — passed in from the parent so we can save the current state */
  readonly currentFilters = input<FilterCriteria>({});
  /** Current sort — passed in from the parent */
  readonly currentSort = input<FilterSort>({ field: 'createdAt', direction: 'desc' });
  /** Emits when a saved filter is loaded — parent should apply both criteria and sort */
  readonly filterApplied = output<AppliedFilterState>();
  /** Whether the current filter/sort state has any active values */
  protected readonly hasActiveState = computed(() => {
    const f = this.currentFilters();
    const s = this.currentSort();
    const hasFilters = !!(
      f.search ||
      f.statusIds?.length ||
      f.priorityLevel?.length ||
      f.typeIds?.length ||
      f.assigneeIds?.length ||
      f.reporterIds?.length ||
      f.sprintIds?.length ||
      f.labelIds?.length ||
      // Date-range criteria captured from the URL count as active state too
      f.createdFrom ||
      f.createdTo ||
      f.updatedFrom ||
      f.updatedTo
    );
    const hasSort = !!(s.field && s.field !== 'createdAt') || (s.field === 'createdAt' && s.direction !== 'desc');

    return hasFilters || hasSort;
  });
  /**
   * Saved views — loaded reactively per project. The URL query params remain
   * the single source of truth for applied filters; views only write params.
   * V9-5: skip the request until the project id resolves — an empty id hits
   * `/projects//filters`, whose SPA-fallback HTML response (200) previously
   * poisoned the resource with a JSON-parse error.
   */
  private readonly viewsResource = rxResource({
    params: () => ({ projectId: this.projectId() }),
    stream: ({ params }) => (params.projectId ? this.filterClient.list(params.projectId) : of([] as Filter[])),
    defaultValue: [] as Filter[],
  });
  private readonly filters = computed(() => (this.viewsResource.hasValue() ? this.viewsResource.value() : []));
  protected readonly loading = computed(() => this.viewsResource.isLoading());
  /** V9-5: rxResource.error() returns `undefined` (not null) on success — coerce to boolean */
  protected readonly loadError = computed(() => Boolean(this.viewsResource.error()));
  // ─── V4-10: editable filter fields ──────────────────────────────────────────
  /** Reference-data option lists (reactive — empty until ProjectRefStore loads) */
  protected readonly statusOptions = computed(() => this.refStore.options(this.projectId(), 'statuses'));
  protected readonly typeOptions = computed(() => this.refStore.options(this.projectId(), 'types'));
  protected readonly memberOptions = computed(() => this.refStore.options(this.projectId(), 'members'));
  protected readonly sprintOptions = computed(() => this.refStore.options(this.projectId(), 'sprints'));
  protected readonly labelOptions = computed(() => this.refStore.options(this.projectId(), 'labels'));
  protected readonly priorityOptions = PRIORITY_OPTIONS;
  /**
   * Working copy of the criteria edited by the panel's fields. Re-seeded from
   * `currentFilters` whenever the parent's state GENUINELY changes (a different
   * set of criteria, e.g. after apply/clear or loading another saved view).
   */
  private readonly draft = signal<FilterCriteria>({});
  /**
   * Structural fingerprint of the criteria the draft was last seeded from
   * (see `stableValue`). A plain field, NOT a signal — the seeding effect must
   * not re-trigger on its own write.
   */
  private seededFrom: string | null = null;

  constructor() {
    effect(() => this.refStore.ensure(this.projectId(), ['statuses', 'types', 'sprints', 'labels', 'members']));
    // Re-seed the draft when the parent's current filters genuinely change.
    // A background refresh (refetch, router re-emission, parent re-render)
    // hands us a NEW object with the SAME content; seeding from it would wipe
    // whatever the user is currently typing. Comparing the structural
    // fingerprint keeps in-progress edits and only re-seeds on a real change.
    effect(() => {
      const incoming = stableValue(this.currentFilters());

      if (this.seededFrom === incoming) return;

      this.seededFrom = incoming;
      this.draft.set({ ...this.currentFilters() });
    });
  }

  /** First id of a single-value criteria key (for select bindings) */
  protected firstOf(key: SingleFilterKey): string {
    return this.draft()[key]?.[0] ?? '';
  }

  /** Set (or clear, with `''`) a single-value criteria key */
  protected setSingle(key: SingleFilterKey, id: string): void {
    this.draft.update((f) => ({ ...f, [key]: id ? [id] : undefined }));
  }

  protected onDraftSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();

    this.draft.update((f) => ({ ...f, search: value || undefined }));
  }

  /** Native select binds string values — expose the draft level as a string. */
  protected draftPriorityLevelValue(): string {
    const level = this.draft().priorityLevel?.[0];

    return level === undefined ? '' : String(level);
  }

  protected onDraftPriority(value: string | number): void {
    const level = value === '' || value === null ? undefined : (Number(value) as TaskPriorityLevel);

    this.draft.update((f) => ({ ...f, priorityLevel: level !== undefined ? [level] : undefined }));
  }

  /** Emit the edited criteria — the parent maps them onto its URL params */
  private applyDraft(): void {
    this.filterApplied.emit({ filters: this.draft(), sort: this.currentSort() });
  }

  /** Reset every field and emit the cleared state */
  protected clearDraft(): void {
    this.draft.set({});
    this.applyDraft();
  }
  // ─── Saved views: save / rename / delete / active detection ────────────────
  private readonly saving = signal(false);
  private readonly showSaveForm = signal(false);
  private readonly saveModel = signal<ViewNameForm>({ name: '' });
  private readonly saveForm = form(
    this.saveModel,
    schema<ViewNameForm>((field) => {
      required(field.name, { message: 'filters.nameRequired' });
    }),
  );
  /** View currently being renamed (drives the rename dialog) */
  private readonly renameTarget = signal<Filter | null>(null);
  private readonly renaming = signal(false);
  private readonly renameModel = signal<ViewNameForm>({ name: '' });
  private readonly renameForm = form(
    this.renameModel,
    schema<ViewNameForm>((field) => {
      required(field.name, { message: 'filters.nameRequired' });
    }),
  );
  // Delete confirmation
  private readonly showDeleteConfirm = signal(false);
  private readonly filterToDelete = signal<Filter | null>(null);
  /**
   * The view whose stored criteria+sort exactly match the current URL-derived
   * state (order-insensitive deep compare). Powers the active checkmark.
   */
  protected readonly activeViewId = computed(() => {
    const current = stableValue({ filters: this.currentFilters(), sort: this.currentSort() });

    return this.filters().find((v) => stableValue({ filters: v.filters, sort: v.sort }) === current)?.id ?? null;
  });

  protected submitSave(): void {
    if (this.saveForm().invalid() || this.saving()) return;

    const name = this.saveModel().name.trim();

    if (!name) return;

    const payload: CreateFilter = {
      name,
      filters: this.currentFilters(),
      sort: this.currentSort(),
    };

    this.saving.set(true);
    this.filterClient.create(this.projectId(), payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.saveForm().reset();
        this.showSaveForm.set(false);
        this.viewsResource.reload();
        this.notify.success('toasts.created');
      },
      error: (err) => {
        this.saving.set(false);
        this.notify.error(getErrorMessage(err, 'filters.createError'));
      },
    });
  }

  protected applyFilter(view: Filter): void {
    this.filterApplied.emit({ filters: view.filters, sort: view.sort });
  }

  protected startRename(view: Filter): void {
    this.renameTarget.set(view);
    this.renameForm().reset({ name: view.name });
  }

  private closeRename(): void {
    this.renameTarget.set(null);
  }

  protected confirmRename(): void {
    const target = this.renameTarget();
    const name = this.renameModel().name.trim();

    if (!target || this.renameForm().invalid() || this.renaming() || !name || name === target.name) return;

    this.renaming.set(true);
    this.filterClient.update(target.id, { name }).subscribe({
      next: () => {
        this.renaming.set(false);
        this.closeRename();
        this.viewsResource.reload();
        this.notify.success('toasts.saved');
      },
      error: (err) => {
        this.renaming.set(false);
        this.notify.error(getErrorMessage(err, 'filters.renameError'));
      },
    });
  }

  protected confirmDelete(view: Filter): void {
    this.filterToDelete.set(view);
    this.showDeleteConfirm.set(true);
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteConfirm.set(false);
      this.filterToDelete.set(null);
    }
  }

  protected deleteFilter(): void {
    const view = this.filterToDelete();

    if (!view) return;

    this.filterClient.delete(view.id).subscribe({
      next: () => {
        this.showDeleteConfirm.set(false);
        this.filterToDelete.set(null);
        this.viewsResource.reload();
        // Undo recreates the saved view with the same name,
        // criteria and sort. The new view gets a new id and belongs to the
        // current user — acceptable for a personal saved view.
        this.notify.successWithUndo('toasts.deleted', () =>
          this.filterClient
            .create(this.projectId(), { name: view.name, filters: view.filters, sort: view.sort })
            .pipe(tap(() => this.viewsResource.reload())),
        );
      },
      error: (err) => {
        this.notify.error(getErrorMessage(err, 'filters.deleteError'));
      },
    });
  }
}
