import { Component, DestroyRef, ElementRef, inject, input, computed, effect, signal, viewChild } from '@angular/core';
import { safeNumericParam } from '@app/shared/utils/numeric-param';
import { NavigationEnd, Router, ActivatedRoute, RouterLink } from '@angular/router';
import { filter, of } from 'rxjs';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { ProjectRefStore, type SelectOption } from '@stores/project-ref-store';
import { getTenantSlug } from '@app/shared/utils/route-utils';
import { AuthStore } from '@stores/auth-store';
import { canWrite } from '@app/shared/utils/role-utils';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUp, lucideArrowDown, lucideFilter } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { HlmCheckboxImports } from '@spartan-ng/helm/checkbox';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { TaskClient, type PaginatedResponse } from '@services/task-client';
import { Pagination } from '@app/shared/pagination/pagination';
import { AppliedFilterState } from '@features/filters/filter-panel/filter-panel';
import { TaskTableFilters } from './task-table-filters/task-table-filters';
import { TaskTableBulkBar, BULK_UNASSIGNED, BULK_NO_SPRINT } from './task-table-bulk-bar/task-table-bulk-bar';
import { TaskTableColumns } from './task-table-columns/task-table-columns';
import { TaskTableHeader } from './task-table-header/task-table-header';
import { isPinnedColumn, type TaskColumnDef } from './task-column-def';
import type {
  Task,
  TaskPriorityLevel,
  FilterCriteria,
  FilterSort,
  TaskTableColumnKey,
  BulkUpdateTasks,
} from '@task-board/shared';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import {
  TASK_TABLE_COLUMN_KEYS,
  TASK_TABLE_PINNED_COLUMNS,
  DEFAULT_TASK_TABLE_COLUMNS,
  TASK_SEARCH_MIN_LENGTH,
} from '@task-board/shared';
import {
  taskTypeBadgeVariant,
  priorityBadgeVariant,
  priorityLabelKey,
  PRIORITY_OPTIONS,
  priorityLevelParam,
} from '@app/constants/priority';
import {
  AUTO_PAGE_SIZE_SENTINEL,
  computeAutoPageSize,
  rowHeightForDensity,
} from '@app/shared/auto-table/auto-page-size';
import { useAutoRowMeasurement } from '@app/shared/auto-table/use-auto-row-measurement';
import { useTableDensity } from '@app/shared/auto-table/table-density';

const COLUMN_COUNT = 11;
/**
 * Empty list envelope — resource `defaultValue` and the fallback stream result
 * while the project context has not resolved yet (keeps the table renderable).
 */
const EMPTY_TASK_PAGE: PaginatedResponse<Task> = {
  data: [],
  pagination: { page: 1, limit: 0, total: 0, totalPages: 0 },
};
// Sentinels for the nullable bulk-select options — owned by TaskTableBulkBar
// (the select values), mapped to `null` here when building the request body.
// (BULK_UNASSIGNED / BULK_NO_SPRINT are imported at the top.)

/**
 * Whether a failed request is the CALLER's to report.
 *
 * The global `errorInterceptor` toasts every 5xx and every network failure, so a
 * component that also toasted those would show two toasts for one failure
 * (AGENTS.md §UI). A 4xx — forbidden, conflict, validation — is the case the
 * interceptor deliberately leaves to the caller. A value that is not an HTTP
 * response at all has no status and belongs to whoever caught it.
 *
 * The same rule is applied in `board-view.ts`; it is a property of the
 * interceptor contract, not of one component.
 */
function isCallerHandled(err: unknown): boolean {
  return err instanceof HttpErrorResponse && err.status >= 400 && err.status < 500;
}

/** Case-insensitive name → id resolution against a loaded option list */
function resolveNameToId(name: string, options: SelectOption[]): string {
  if (!name) return '';
  // Already an id?
  if (options.some((o) => o.id === name)) return name;

  const lower = name.toLowerCase();
  const match = options.find((o) => o.name.toLowerCase() === lower);

  return match?.id ?? '';
}

@Component({
  selector: 'ui-task-table',
  imports: [
    DatePipe,
    TranslocoPipe,
    // The key cell is a real link, so the directive has to be in scope.
    RouterLink,
    NgIcon,
    HlmButtonImports,
    HlmInputImports,
    HlmBadgeImports,
    HlmSelectImports,
    HlmCardImports,
    HlmTableImports,
    HlmPopoverImports,
    HlmCheckboxImports,
    HlmTooltipImports,
    HlmDatePickerImports,
    Pagination,
    TaskTableFilters,
    TaskTableBulkBar,
    TaskTableColumns,
    TaskTableHeader,
  ],
  providers: [
    provideIcons({
      lucideArrowUp,
      lucideArrowDown,
      lucideFilter,
    }),
  ],
  templateUrl: './task-table.html',
})
export class TaskTable {
  private readonly taskClient = inject(TaskClient);
  /** Round-4 F1: translates the date-mode select values for its trigger display */
  private readonly transloco = inject(TranslocoService);
  /** Bulk-update success/failure feedback */
  private readonly notify = injectToasts();
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
  // ─── Route & query params (bound automatically by withComponentInputBinding) ──
  readonly projectKey = input.required<string>();
  /** Raw URL values — human-readable names or ids */
  readonly search = input('');
  readonly page = input(1, { transform: safeNumericParam });
  readonly limit = input(this.preferencesStore.pageSize(), { transform: safeNumericParam });
  readonly priorityLevel = input<TaskPriorityLevel | null>(null, { transform: priorityLevelParam });
  readonly status = input('');
  readonly type = input('');
  readonly assignee = input('');
  readonly reporter = input('');
  readonly sprint = input('');
  readonly label = input('');
  // Date-range filter params (set via column-header popovers) — captured by saved views
  readonly createdFrom = input('');
  readonly createdTo = input('');
  readonly updatedFrom = input('');
  readonly updatedTo = input('');
  /** `${field}:${direction}` */
  readonly sort = input('');
  // ─── Derived state ─────────────────────────────────────────────────────────
  /** Resolved project UUID from the store (available after guard loads project) */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /**
   * True when the persisted preference is the Auto sentinel — the effective page size
   * is then derived from the measured table-wrapper height instead of a fixed number.
   */
  private readonly isAutoMode = computed(() => this.preferencesStore.pageSize() === AUTO_PAGE_SIZE_SENTINEL);
  /**
   * Device-local table density. Compact mode shrinks vertical cell
   * padding via a class on the `<table>`; the Auto math below reacts through the
   * density-aware fallback row height.
   */
  private readonly density = useTableDensity();
  protected readonly isCompact = this.density.compact;
  protected readonly toggleDensity = this.density.toggle;
  /** Density-aware fallback row height used by the Auto page-size math */
  private readonly rowHeightPx = computed(() => rowHeightForDensity(this.density.compact()));
  /**
   * Height available for table ROWS, measured from the table wrapper via a
   * shared ResizeObserver (wrapper height minus its header row). No window/chrome
   * constants — the table bottom aligns with the page bottom at any viewport height.
   * The row height comes from the invisible probe row in the template (same cell
   * structure as a data row), so the FIRST fetch already uses an accurate Auto
   * page size.
   */
  private readonly measurement = useAutoRowMeasurement();
  private readonly availableRowsHeight = this.measurement.availableRowsHeight;
  /**
   * Effective row height for the Auto math: the probe-row height when available,
   * otherwise the density-aware constant.
   */
  private readonly effectiveRowHeightPx = computed(() => this.measurement.measuredRowHeight() || this.rowHeightPx());
  private readonly tableWrapRef = viewChild<ElementRef<HTMLDivElement>>('tableWrap');
  /**
   * Effective numeric page size used for fetching/rendering. In Auto mode this is
   * recomputed from the measured wrapper height; otherwise it is the URL `limit`
   * or the stored preference.
   */
  private readonly pageSize = computed(() =>
    this.isAutoMode()
      ? computeAutoPageSize(this.availableRowsHeight(), this.effectiveRowHeightPx())
      : this.limit() || this.preferencesStore.pageSize(),
  );
  /** Safe page number — falls back to 1 when the query param is absent */
  private readonly safePage = computed(() => this.page() || 1);
  /** V2-10: the New Task control is hidden from VIEWER-role users */
  private readonly canCreateTasks = computed(() =>
    canWrite(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  private readonly sortField = computed(() => (this.sort() ?? '').split(':')[0] ?? '');
  private readonly sortDirection = computed<'asc' | 'desc'>(() =>
    (this.sort() ?? '').split(':')[1] === 'asc' ? 'asc' : 'desc',
  );
  // Reference data (reactive — empty until loaded)
  private readonly statusOptions = computed(() => this.refStore.options(this.projectId(), 'statuses'));
  private readonly typeOptions = computed(() => this.refStore.options(this.projectId(), 'types'));
  private readonly sprintOptions = computed(() => this.refStore.options(this.projectId(), 'sprints'));
  private readonly labelOptions = computed(() => this.refStore.options(this.projectId(), 'labels'));
  private readonly memberOptions = computed(() => this.refStore.options(this.projectId(), 'members'));
  protected readonly statusMap = computed(() => this.refStore.nameMap(this.projectId(), 'statuses'));
  protected readonly typeMap = computed(() => this.refStore.nameMap(this.projectId(), 'types'));
  private readonly sprintMap = computed(() => this.refStore.nameMap(this.projectId(), 'sprints'));
  private readonly labelMap = computed(() => this.refStore.nameMap(this.projectId(), 'labels'));
  protected readonly typeKeyMap = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {};

    for (const option of this.typeOptions()) {
      if (option.key) map[option.id] = option.key;
    }
    return map;
  });
  /**
   * URL name/id → resolved id. Pure computeds: when reference data finishes
   * loading they recompute automatically — no polling needed.
   */
  private readonly filterStatus = computed(() => resolveNameToId(this.status(), this.statusOptions()));
  private readonly filterType = computed(() => resolveNameToId(this.type(), this.typeOptions()));
  private readonly filterAssignee = computed(() => resolveNameToId(this.assignee(), this.memberOptions()));
  private readonly filterReporter = computed(() => resolveNameToId(this.reporter(), this.memberOptions()));
  private readonly filterSprint = computed(() => resolveNameToId(this.sprint(), this.sprintOptions()));
  private readonly filterLabel = computed(() => resolveNameToId(this.label(), this.labelOptions()));
  /** Shared badge-variant/label helpers (see constants/priority.ts) */
  protected readonly taskTypeBadgeVariant = taskTypeBadgeVariant;
  protected readonly priorityBadgeVariant = priorityBadgeVariant;

  /** Translated priority label; unknown values render verbatim. */
  private priorityLabel(priorityLevel: TaskPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.transloco.translate(key) : String(priorityLevel);
  }
  // ─── Data ──────────────────────────────────────────────────────────────────
  /**
   * Auto mode: the fetch waits until the table STRUCTURE is rendered and
   * measured — the header columns and the probe row depend on async per-project
   * preferences, so before they resolve the measured row height is 0 and any
   * page-size math would be wrong (wrong limit + a refinement request).
   */
  private readonly autoReady = computed(() => !this.isAutoMode() || this.measurement.measuredRowHeight() > 0);
  /**
   * Task list fetch — `rxResource` over `TaskClient.list` with reactive params
   * derived from the URL-bound query signals. Switching filters/page/sort
   * cancels the in-flight request automatically (no race), errors surface as a
   * toast (see the error effect below), and all reads are `hasValue()`-guarded
   * with a `defaultValue` so the table stays renderable while loading.
   */
  private readonly tasksResource = rxResource({
    params: () => ({
      pid: this.projectId(),
      query: this.taskQuery(),
      reloadTick: this.reloadTick(),
      ready: this.autoReady(),
    }),
    stream: ({ params }) => {
      // Auto mode: skip the fetch until the table structure (header + probe row)
      // has rendered and been measured — otherwise the page-size math runs on
      // placeholder geometry and produces a wrong limit.
      if (!params.pid || !params.ready) {
        return of(EMPTY_TASK_PAGE);
      }

      return this.taskClient.list(params.pid, params.query);
    },
    defaultValue: EMPTY_TASK_PAGE,
  });
  private readonly tasks = computed(() => (this.tasksResource.hasValue() ? this.tasksResource.value().data : []));
  /**
   * Last non-empty pagination totals. During a refetch the resource resets to the
   * empty default (total 0), which would collapse the pagination to a single page
   * and flicker — the last known values keep it stable until fresh data arrives.
   */
  private readonly lastKnownPagination = signal({ total: 0, totalPages: 1 });
  protected readonly total = computed(() => {
    if (!this.tasksResource.isLoading()) {
      return this.tasksResource.hasValue() ? this.tasksResource.value().pagination.total : 0;
    }

    return this.lastKnownPagination().total;
  });
  protected readonly totalPages = computed(() => {
    if (!this.tasksResource.isLoading()) {
      return this.tasksResource.hasValue() ? this.tasksResource.value().pagination.totalPages : 0;
    }

    return this.lastKnownPagination().totalPages;
  });
  // ─── Multi-select + bulk actions ────────────────────────────────────────────
  /** Page-scoped selection set — cleared whenever the table data reloads */
  private readonly selectedIds = signal<Set<string>>(new Set());
  private readonly selectedCount = computed(() => this.selectedIds().size);
  protected readonly allSelected = computed(
    () => this.tasks().length > 0 && this.tasks().every((task) => this.selectedIds().has(task.id)),
  );
  /** Bulk-bar field buffers (empty string = untouched) */
  private readonly bulkStatus = signal('');
  private readonly bulkAssignee = signal('');
  private readonly bulkSprint = signal('');
  private readonly applyingBulk = signal(false);
  /** Mirrors the server's exactly-one-field contract client-side */
  private readonly canApplyBulk = computed(
    () => [this.bulkStatus(), this.bulkAssignee(), this.bulkSprint()].filter((v) => v !== '').length === 1,
  );
  /**
   * colspan for empty/spacer rows — visible columns plus the selection
   * checkbox column when it is rendered.
   */
  protected readonly renderedColumnCount = computed(() => this.visibleColumnCount() + (this.canCreateTasks() ? 1 : 0));
  // ─── Column definitions for @for header rendering ──────────────────────────
  // V4-8 (reopened): under `table-fixed` the fixed px widths of the non-title
  // columns must stay well below typical container widths — otherwise the Title
  // column collapses to 0px and the adjacent Type header overlaps (and swallows
  // clicks on) the Title sort button. Fixed sums are trimmed AND the Title column
  // gets an explicit percentage width so it always keeps a proportional share.
  private readonly taskColumns: TaskColumnDef[] = [
    {
      field: 'number',
      columnKey: 'key',
      labelKey: 'taskTable.key',
      filterType: 'none',
      width: 'w-23',
      getFilterValue: () => '',
    },
    {
      field: 'title',
      columnKey: 'title',
      labelKey: 'taskTable.titleCol',
      filterType: 'text',
      // V4-8 (reopened): `w-auto` alone collapses to 0px when the fixed widths of
      // the other columns consume the container. An explicit percentage width keeps
      // a proportional share under `table-fixed` at every viewport.
      width: 'w-[30%] min-w-50',
      popoverWidth: 'w-56',
      getFilterValue: () => this.searchInput(),
      setFilterValue: (v) => this.onSearchInput(v),
      placeholder: 'taskTable.searchPlaceholder',
    },
    {
      field: 'typeId',
      columnKey: 'type',
      labelKey: 'taskTable.type',
      filterType: 'select',
      width: 'w-23',
      getFilterValue: () => this.filterType(),
      setFilterValue: (v) => this.onColumnFilterChange('type', v),
      getOptions: () => this.typeOptions(),
      allLabelKey: 'taskTable.allTypes',
      itemToString: (id: string) => this.refStore.nameOf(this.projectId(), 'types', id),
    },
    {
      field: 'statusId',
      columnKey: 'status',
      labelKey: 'taskTable.status',
      filterType: 'select',
      width: 'w-33',
      getFilterValue: () => this.filterStatus(),
      setFilterValue: (v) => this.onColumnFilterChange('status', v),
      getOptions: () => this.statusOptions(),
      allLabelKey: 'taskTable.allStatuses',
      itemToString: (id: string) => this.refStore.nameOf(this.projectId(), 'statuses', id),
    },
    {
      field: 'priority',
      columnKey: 'priority',
      labelKey: 'taskTable.priority',
      filterType: 'select',
      width: 'w-25',
      getFilterValue: () => (this.priorityLevel() === null ? '' : String(this.priorityLevel())),
      setFilterValue: (v) => this.onColumnFilterChange('priorityLevel', v === '' ? '' : String(v)),
      allLabelKey: 'taskTable.allPriorities',
      staticOptions: [...PRIORITY_OPTIONS],
    },
    {
      field: 'assigneeId',
      columnKey: 'assignee',
      labelKey: 'taskTable.assignee',
      filterType: 'select',
      width: 'w-33',
      getFilterValue: () => this.filterAssignee(),
      setFilterValue: (v) => this.onColumnFilterChange('assignee', v),
      getOptions: () => this.memberOptions(),
      allLabelKey: 'taskTable.allAssignees',
      itemToString: (id: string) => this.refStore.nameOf(this.projectId(), 'members', id),
    },
    {
      field: 'reporterId',
      columnKey: 'reporter',
      labelKey: 'taskTable.reporter',
      filterType: 'select',
      width: 'w-33',
      getFilterValue: () => this.filterReporter(),
      setFilterValue: (v) => this.onColumnFilterChange('reporter', v),
      getOptions: () => this.memberOptions(),
      allLabelKey: 'taskTable.allReporters',
      itemToString: (id: string) => this.refStore.nameOf(this.projectId(), 'members', id),
    },
    {
      field: 'sprintId',
      columnKey: 'sprint',
      labelKey: 'taskTable.sprint',
      filterType: 'select',
      width: 'w-28',
      getFilterValue: () => this.filterSprint(),
      setFilterValue: (v) => this.onColumnFilterChange('sprint', v),
      getOptions: () => this.sprintOptions(),
      allLabelKey: 'taskTable.allSprints',
      itemToString: (id: string) => this.refStore.nameOf(this.projectId(), 'sprints', id),
    },
    {
      field: 'labelIds',
      columnKey: 'labels',
      labelKey: 'taskTable.labels',
      filterType: 'none',
      width: 'w-35',
      getFilterValue: () => '',
    },
    {
      field: 'createdAt',
      columnKey: 'created',
      labelKey: 'taskTable.created',
      // Date-range filter (on/before/after/between) via header popover
      filterType: 'date',
      width: 'w-25',
      // Round-4 F3: rightmost column — open the popover leftward (no viewport clipping)
      align: 'end',
      getFilterValue: () => '',
      getDateFrom: () => this.createdFrom(),
      getDateTo: () => this.createdTo(),
      setDateRange: (from, to) => this.patchParams({ createdFrom: from || null, createdTo: to || null }),
    },
    {
      field: 'updatedAt',
      columnKey: 'updated',
      labelKey: 'taskTable.updated',
      filterType: 'date',
      width: 'w-25',
      // Round-4 F3: rightmost column — open the popover leftward (no viewport clipping)
      align: 'end',
      getFilterValue: () => '',
      getDateFrom: () => this.updatedFrom(),
      getDateTo: () => this.updatedTo(),
      setDateRange: (from, to) => this.patchParams({ updatedFrom: from || null, updatedTo: to || null }),
    },
  ];
  protected readonly COLUMN_COUNT = COLUMN_COUNT;
  // ─── Column visibility ─────────────────────────────────────────────────────
  /**
   * Local override applied immediately on toggle; the debounced persist goes to
   * PreferencesStore afterwards. Null = fall through to the persisted preference.
   */
  private readonly localColumns = signal<TaskTableColumnKey[] | null>(null);
  /**
   * Effective visible column keys. Pinned columns (`key`, `title`) are always
   * included regardless of what was persisted; null preference = default set.
   */
  private readonly visibleColumnKeys = computed<ReadonlySet<TaskTableColumnKey>>(() => {
    const pid = this.projectId();
    const stored = pid ? this.preferencesStore.getTaskTableColumns(pid) : null;
    const keys = this.localColumns() ?? stored ?? DEFAULT_TASK_TABLE_COLUMNS;

    return new Set<TaskTableColumnKey>([...TASK_TABLE_PINNED_COLUMNS, ...keys]);
  });
  /** Column definitions filtered by the visible set — drives header rendering. */
  private readonly visibleTaskColumns = computed(() =>
    this.taskColumns.filter((col) => this.visibleColumnKeys().has(col.columnKey)),
  );
  /** Visible fields — guards body-cell rendering so hidden cells leave the DOM. */
  protected readonly visibleFields = computed(() => new Set(this.visibleTaskColumns().map((col) => col.field)));
  /** colspan for empty/spacer rows — follows the visible column count */
  private readonly visibleColumnCount = computed(() => this.visibleTaskColumns().length);
  /**
   * The column-chooser popover, cursor-anchored chooser and header
   * context menu live in the TaskTableColumns UI child. The visibility state
   * and persistence stay here (the table header/body render from it); the
   * accessors below delegate to the child for the chooser/context-menu state
   * the specs and handlers interact with.
   */
  private readonly columnsUi = viewChild.required(TaskTableColumns);
  /** Debounced persistence of column toggles (~400 ms) */
  private static readonly COLUMN_PERSIST_DEBOUNCE_MS = 400;
  private columnPersistHandle: ReturnType<typeof setTimeout> | null = null;
  // ─── Dialogs ───────────────────────────────────────────────────────────────
  private readonly showFilterDialog = signal(false);
  protected readonly currentFilters = computed<FilterCriteria>(() => {
    const filters: FilterCriteria = {};

    if (this.filterStatus()) filters.statusIds = [this.filterStatus()];
    if (this.priorityLevel() !== null) filters.priorityLevel = [this.priorityLevel() as TaskPriorityLevel];
    if (this.filterType()) filters.typeIds = [this.filterType()];
    if (this.filterAssignee()) filters.assigneeIds = [this.filterAssignee()];
    if (this.search()) filters.search = this.search();
    // Date ranges participate in save/active-detection of saved views
    if (this.createdFrom()) filters.createdFrom = this.createdFrom();
    if (this.createdTo()) filters.createdTo = this.createdTo();
    if (this.updatedFrom()) filters.updatedFrom = this.updatedFrom();
    if (this.updatedTo()) filters.updatedTo = this.updatedTo();

    return filters;
  });
  protected readonly currentSort = computed<FilterSort>(() => ({
    field: this.sortField() || 'createdAt',
    direction: this.sortDirection(),
  }));
  /**
   * A free-text search shorter than `TASK_SEARCH_MIN_LENGTH` is never sent.
   *
   * The API rejects it (400 VALIDATION_ERROR) because a 1-character term matches
   * virtually every task in the project and the server-side `$or` of five regexes
   * has to evaluate it against every one of them. Committing such a value to the
   * URL would therefore trade a 400 for a wasted request, so the buffer keeps the
   * keystrokes (the input still shows what the user typed) and only a value at or
   * above the minimum is written to the URL. An EMPTY value is always committed —
   * that is how the search is cleared.
   */
  private readonly committedSearch = computed(() => {
    const value = (this.search() ?? '').trim();

    return value.length === 0 || value.length >= TASK_SEARCH_MIN_LENGTH ? this.search() : undefined;
  });
  /** Query sent to the API — recomputed whenever any URL param changes */
  private readonly taskQuery = computed(() => ({
    search: this.committedSearch() || undefined,
    statusId: this.filterStatus() || undefined,
    priorityLevel: this.priorityLevel() ?? undefined,
    typeId: this.filterType() || undefined,
    assigneeId: this.filterAssignee() || undefined,
    reporterId: this.filterReporter() || undefined,
    sprintId: this.filterSprint() || undefined,
    labelId: this.filterLabel() || undefined,
    // Inclusive ISO date-range filters (server applies $gte/$lte)
    createdFrom: this.createdFrom() || undefined,
    createdTo: this.createdTo() || undefined,
    updatedFrom: this.updatedFrom() || undefined,
    updatedTo: this.updatedTo() || undefined,
    sort: this.sortField() ? `${this.sortField()}:${this.sortDirection()}` : undefined,
    page: this.safePage(),
    limit: this.pageSize(),
    // The table never renders the description — drop it from the payload
    excludeDescription: true,
  }));
  /**
   * P8-12: identity of the current query scope — everything that changes WHICH
   * tasks are listed (project, filters, page, sort) but NOT the page size.
   * The page-scoped selection clears when this changes; limit-only refetches
   * (e.g. the Auto page-size re-measure) keep it.
   */
  private readonly taskScopeKey = computed(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit: _limit, ...scope } = this.taskQuery();

    return JSON.stringify({ pid: this.projectId(), scope });
  });
  /** Free-text search is debounced (~300 ms) so typing doesn't fire a request per keystroke */
  private static readonly SEARCH_DEBOUNCE_MS = 300;
  private searchDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  /** Local buffer for the search box — committed to the URL only after the debounce */
  private readonly searchInput = signal('');
  /**
   * V1-3: bumped when a router navigation completes while this table is alive
   * (e.g. browser-back from `tasks/new`). Included in the `tasksResource`
   * params so returning to the table always re-runs the query — the list can
   * never go stale. DOCUMENTED EXCEPTION: a pure `rxResource` would not refetch
   * here because identical URL params produce identical `params`; this minimal
   * trigger is kept deliberately for the navigation-back refresh.
   */
  private readonly reloadTick = signal(0);
  /**
   * P8-12: scope key of the last seen query (see the selection effect).
   * Null until the first pass — the initial load must not "clear"
   * an already-empty selection.
   */
  private lastScopeKey: string | null = null;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Load reference data whenever the project context becomes available
    effect(() => {
      this.refStore.ensure(this.projectId(), ['statuses', 'types', 'sprints', 'labels', 'members']);
    });

    // Remember the last non-empty pagination totals so the pagination stays
    // stable while a refetch is in flight (see lastKnownPagination).
    effect(() => {
      if (this.tasksResource.isLoading() || !this.tasksResource.hasValue()) return;

      const { total, totalPages } = this.tasksResource.value().pagination;

      if (total > 0) this.lastKnownPagination.set({ total, totalPages });
    });

    // Load the per-project preferences (incl. taskTableColumns) for this table
    effect(() => {
      const pid = this.projectId();

      if (pid) this.preferencesStore.loadProjectPreferences(pid);
    });

    // Q10/P8-12: selection is page-scoped — cleared when the query scope
    // (filters/page/sort/project) changes, but NOT on limit-only refetches.
    // Clicking a row checkbox renders the bulk bar, which shrinks the table
    // wrapper; in Auto page-size mode the ResizeObserver then recomputes the
    // size and refetches — that refetch must not wipe the fresh selection.
    // Also handles the invalid-page redirect once a response is available.
    effect(() => {
      if (!this.tasksResource.hasValue()) return;

      const res = this.tasksResource.value();
      const scopeKey = this.taskScopeKey();

      if (this.lastScopeKey !== null && scopeKey !== this.lastScopeKey) {
        this.selectedIds.set(new Set());
      }
      this.lastScopeKey = scopeKey;

      // Handle invalid page — move to nearest valid page
      if (res.pagination.totalPages > 0 && this.page() > res.pagination.totalPages) {
        this.patchParams({ page: res.pagination.totalPages });
      }
    });

    // Convention: a failed list load surfaces as a toast — never console-only.
    // The global errorInterceptor already toasts 5xx and network failures, so
    // this effect covers only the 4xx the global layer leaves to the caller.
    effect(() => {
      const err = this.tasksResource.error();

      if (err && isCallerHandled(err)) this.notify.error(getErrorMessage(err));
    });

    // Keep the buffered search text in sync with external URL changes (back/forward, chip removal).
    // V4-7: `?? ''` — withComponentInputBinding yields `undefined` for an absent
    // `?search=` param; letting undefined into the buffer made the input render
    // the literal string "undefined" (V1-2/V3-8 regression).
    effect(() => this.searchInput.set(this.search() ?? ''));

    // V1-3: refresh on route activation. The first NavigationEnd belongs to this
    // mount (the fetch effect already ran); every later one means we came back.
    let firstNavigation = true;

    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (firstNavigation) {
          firstNavigation = false;
          return;
        }
        // V1-3: re-run the tasksResource query when navigation back completes
        this.reloadTick.update((tick) => tick + 1);
      });

    // Measure the table wrapper via the shared ResizeObserver instead of
    // deriving the Auto page size from window.innerHeight. The fetch effect depends
    // on `pageSize`, so a refetch only happens when the row count actually changes.
    effect(() => {
      this.measurement.observe(this.tableWrapRef()?.nativeElement, 'thead');
    });

    this.destroyRef.onDestroy(() => {
      if (this.searchDebounceHandle !== null) clearTimeout(this.searchDebounceHandle);
      if (this.columnPersistHandle !== null) clearTimeout(this.columnPersistHandle);
    });
  }

  // ─── Column visibility ─────────────────────────────────────────────────────

  /**
   * Toggle a column's visibility. Applies immediately via `localColumns`; the
   * persistence call is debounced so rapid toggles coalesce into one request.
   */
  protected toggleColumn(columnKey: TaskTableColumnKey, visible: boolean): void {
    if (isPinnedColumn(columnKey)) return;

    const current = this.visibleColumnKeys();
    const nextKeys = TASK_TABLE_COLUMN_KEYS.filter((key) =>
      visible ? current.has(key) || key === columnKey : current.has(key) && key !== columnKey,
    );

    this.localColumns.set([...nextKeys]);
    this.scheduleColumnPersist(nextKeys);
  }

  /**
   * Bulk show/hide of ALL non-pinned columns at once.
   * Pinned Key/Title always stay; persistence goes through the same debounced
   * path as single toggles so rapid changes coalesce into one request.
   */
  protected toggleAllColumns(visible: boolean): void {
    const nextKeys: TaskTableColumnKey[] = visible ? [...TASK_TABLE_COLUMN_KEYS] : [...TASK_TABLE_PINNED_COLUMNS];

    this.localColumns.set([...nextKeys]);
    this.scheduleColumnPersist(nextKeys);
  }

  /** Debounced persistence of the visible-column set (~400 ms) */
  private scheduleColumnPersist(nextKeys: readonly TaskTableColumnKey[]): void {
    if (this.columnPersistHandle !== null) clearTimeout(this.columnPersistHandle);

    const pid = this.projectId();

    if (!pid) return;

    this.columnPersistHandle = setTimeout(() => {
      this.columnPersistHandle = null;
      this.preferencesStore.setTaskTableColumns(pid, [...nextKeys]);
    }, TaskTable.COLUMN_PERSIST_DEBOUNCE_MS);
  }

  /** Select-all state over the toggleable (non-pinned) columns */
  private readonly toggleableColumns = computed(() => this.taskColumns.filter((col) => !isPinnedColumn(col.columnKey)));
  protected readonly allColumnsSelected = computed(() =>
    this.toggleableColumns().every((col) => this.visibleColumnKeys().has(col.columnKey)),
  );
  protected readonly someColumnsSelected = computed(() => {
    const selected = this.toggleableColumns().filter((col) => this.visibleColumnKeys().has(col.columnKey)).length;

    return selected > 0 && selected < this.toggleableColumns().length;
  });

  // ─── Delegations to the TaskTableColumns UI child ──────────────────────────
  // The chooser/context-menu interaction state lives in the child; these thin
  // accessors keep the composition-root template and handlers stable.

  /** Right-click on a column header → open the context menu at the cursor */
  protected onHeaderContextMenu(event: MouseEvent, col: TaskColumnDef): void {
    this.columnsUi().onHeaderContextMenu(event, col);
  }

  protected get showColumnChooser() {
    return this.columnsUi().showColumnChooser;
  }

  protected get showContextColumnChooser() {
    return this.columnsUi().showContextColumnChooser;
  }

  protected get contextColumn() {
    return this.columnsUi().contextColumn;
  }

  protected canHideContextColumn(): boolean {
    return this.columnsUi().canHideContextColumn();
  }

  protected hideContextColumn(): void {
    this.columnsUi().hideContextColumn();
  }

  protected openChooserFromContextMenu(): void {
    this.columnsUi().openChooserFromContextMenu();
  }

  protected onChooserStateChange(state: 'open' | 'closed'): void {
    this.columnsUi().onChooserStateChange(state);
  }

  protected onContextChooserStateChange(state: 'open' | 'closed'): void {
    this.columnsUi().onContextChooserStateChange(state);
  }

  protected closeColumnChooser(): void {
    this.columnsUi().closeColumnChooser();
  }

  protected swallowNextClick(): void {
    this.columnsUi().swallowNextClick();
  }

  // ─── URL sync ──────────────────────────────────────────────────────────────

  /** Merge params into the URL; null removes a param. Inputs update reactively. */
  private patchParams(params: Record<string, string | number | null>): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Convert an id to its human-readable name for URL storage */
  private idToName(kind: Parameters<ProjectRefStore['nameOf']>[1], id: string): string | null {
    return id ? this.refStore.nameOf(this.projectId(), kind, id) : null;
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  protected onSearch(event: Event): void {
    this.onSearchInput((event.target as HTMLInputElement).value);
  }

  /**
   * Buffer keystrokes and commit the search param after ~300 ms of inactivity.
   *
   * A 1-character value (below `TASK_SEARCH_MIN_LENGTH`) is NOT committed —
   * the API would reject it and the underlying query is a full-project scan. The
   * input still shows the typed character, so the box is not frozen mid-word;
   * as soon as the term reaches the minimum the normal debounced commit happens.
   */
  private onSearchInput(value: string): void {
    this.searchInput.set(value);

    if (this.searchDebounceHandle !== null) clearTimeout(this.searchDebounceHandle);

    const trimmed = value.trim();

    if (trimmed.length > 0 && trimmed.length < TASK_SEARCH_MIN_LENGTH) {
      // Below the server's minimum — drop the pending commit and leave the URL
      // (and therefore the request) untouched.
      this.searchDebounceHandle = null;

      return;
    }

    this.searchDebounceHandle = setTimeout(() => {
      this.searchDebounceHandle = null;
      this.patchParams({ search: value || null, page: null });
    }, TaskTable.SEARCH_DEBOUNCE_MS);
  }

  /** Remove a single active filter via its chip's × button */
  protected removeFilter(param: string): void {
    if (param === 'search') {
      if (this.searchDebounceHandle !== null) {
        clearTimeout(this.searchDebounceHandle);
        this.searchDebounceHandle = null;
      }
      this.searchInput.set('');
    }
    // Date chips clear BOTH bounds of their range
    if (param === 'createdFrom' || param === 'createdTo') {
      const createdCol = this.taskColumns.find((c) => c.columnKey === 'created');

      if (createdCol) this.clearDateModeOverride(createdCol);
      this.patchParams({ createdFrom: null, createdTo: null });
      return;
    }
    if (param === 'updatedFrom' || param === 'updatedTo') {
      const updatedCol = this.taskColumns.find((c) => c.columnKey === 'updated');

      if (updatedCol) this.clearDateModeOverride(updatedCol);
      this.patchParams({ updatedFrom: null, updatedTo: null });
      return;
    }
    this.onColumnFilterChange(param, '');
  }

  /** One-click reset of every active filter (filtered-empty state CTA) */
  protected clearFilters(): void {
    if (this.searchDebounceHandle !== null) {
      clearTimeout(this.searchDebounceHandle);
      this.searchDebounceHandle = null;
    }
    this.searchInput.set('');
    // Round-4 F2: drop any explicit UI-mode overrides — derived mode takes over again
    this.dateModeOverrides.set({});
    this.patchParams({
      search: null,
      priority: null,
      status: null,
      type: null,
      assignee: null,
      reporter: null,
      sprint: null,
      label: null,
      createdFrom: null,
      createdTo: null,
      updatedFrom: null,
      updatedTo: null,
      page: null,
    });
  }

  /** True when any filter param is active — distinguishes filtered-empty from true-empty */
  protected readonly hasActiveFilters = computed(
    () =>
      !!this.search() ||
      this.priorityLevel() !== null ||
      !!this.status() ||
      !!this.type() ||
      !!this.assignee() ||
      !!this.reporter() ||
      !!this.sprint() ||
      !!this.label() ||
      !!this.createdFrom() ||
      !!this.createdTo() ||
      !!this.updatedFrom() ||
      !!this.updatedTo(),
  );
  /** Active filters as removable chips rendered above the table */
  protected readonly activeFilterChips = computed<{ param: string; labelKey: string; value: string }[]>(() => {
    const chips: { param: string; labelKey: string; value: string }[] = [];
    const pid = this.projectId();

    if (this.search()) {
      chips.push({ param: 'search', labelKey: 'taskTable.filterSearch', value: this.search() });
    }
    if (this.priorityLevel() !== null) {
      // Translated display label instead of the raw level value
      chips.push({
        param: 'priorityLevel',
        labelKey: 'taskTable.filterPriority',
        value: this.priorityLabel(this.priorityLevel() as TaskPriorityLevel),
      });
    }
    if (this.filterStatus()) {
      chips.push({
        param: 'status',
        labelKey: 'taskTable.filterStatus',
        value: this.refStore.nameOf(pid, 'statuses', this.filterStatus()),
      });
    }
    if (this.filterType()) {
      chips.push({
        param: 'type',
        labelKey: 'taskTable.filterType',
        value: this.refStore.nameOf(pid, 'types', this.filterType()),
      });
    }
    if (this.filterAssignee()) {
      chips.push({
        param: 'assignee',
        labelKey: 'taskTable.filterAssignee',
        value: this.refStore.nameOf(pid, 'members', this.filterAssignee()),
      });
    }
    if (this.filterReporter()) {
      chips.push({
        param: 'reporter',
        labelKey: 'taskTable.filterReporter',
        value: this.refStore.nameOf(pid, 'members', this.filterReporter()),
      });
    }
    if (this.filterSprint()) {
      chips.push({
        param: 'sprint',
        labelKey: 'taskTable.filterSprint',
        value: this.refStore.nameOf(pid, 'sprints', this.filterSprint()),
      });
    }
    if (this.filterLabel()) {
      chips.push({
        param: 'label',
        labelKey: 'taskTable.filterLabel',
        value: this.refStore.nameOf(pid, 'labels', this.filterLabel()),
      });
    }

    // Date-range chips — one chip per bounded column
    const dateChip = (param: 'createdFrom' | 'updatedFrom', from: string, to: string, labelKey: string): void => {
      if (!from && !to) return;

      let value: string;

      if (from && to) {
        value = from === to ? from : `${from} … ${to}`;
      } else {
        value = from || `≤ ${to}`;
      }

      chips.push({ param, labelKey, value });
    };

    dateChip('createdFrom', this.createdFrom(), this.createdTo(), 'taskTable.filterCreated');
    dateChip('updatedFrom', this.updatedFrom(), this.updatedTo(), 'taskTable.filterUpdated');

    return chips;
  });

  /** Toggle sort direction for a column. 3-state cycle: asc → desc → none. */
  protected toggleSort(field: string): void {
    let nextSort: string | null;

    if (this.sortField() === field && this.sortDirection() === 'asc') {
      nextSort = `${field}:desc`;
    } else if (this.sortField() === field) {
      nextSort = null; // was desc → clear sort entirely
    } else {
      nextSort = `${field}:asc`;
    }
    this.patchParams({ sort: nextSort, page: null });
  }

  /** Handle column filter changes from popover dropdowns/inputs */
  private onColumnFilterChange(filterName: string, value: string): void {
    this.patchParams({ [filterName]: value || null, page: null });
  }

  protected onPageChange(newPage: number): void {
    this.patchParams({ page: newPage > 1 ? newPage : null });
  }

  /**
   * Numeric page-size selection: persist and write to the URL.
   * Auto selection (`onAutoPageSize`) intentionally OMITS `limit` from the URL and
   * resolves the size client-side, so the URL stays stable across screen sizes.
   */
  protected onPageSizeChange(newSize: number): void {
    // V1-3: never persist or write a non-finite size (`?limit=NaN`) to the URL
    if (!Number.isFinite(newSize) || newSize <= 0) return;

    this.preferencesStore.setPageSize(newSize);
    this.patchParams({ limit: newSize, page: null });
  }

  /** Auto page-size selection: persist the sentinel and drop `limit` from the URL. */
  protected onAutoPageSize(): void {
    this.preferencesStore.setPageSize(AUTO_PAGE_SIZE_SENTINEL);
    this.patchParams({ limit: null, page: null });
  }

  // ─── Cell tooltips (fixed layout ellipsis) ─────────────────────────────────

  /** `KEY-123` display key used in the Key cell and its title tooltip */
  protected taskKey(task: Task): string {
    return `${this.projectKey() ? `${this.projectKey()}-` : '#'}${task.number}`;
  }

  protected sprintName(task: Task): string {
    return task.sprintId ? (this.sprintMap()[task.sprintId] ?? task.sprintId) : '';
  }

  /** Comma-joined label names for the Labels cell tooltip */
  protected labelNames(task: Task): string {
    return (task.labelIds ?? []).map((id) => this.labelMap()[id] ?? id).join(', ');
  }

  /**
   * The single source of the task URL, shared by the row's pointer click and the
   * key cell's real `routerLink` so the two can never disagree.
   */
  private taskLinkCommands(task: Task): string[] {
    const tenantSlug = getTenantSlug(this.route);
    // The table only renders under projects/:projectKey — prefer the route param
    // so the link is correct even before ProjectStore is hydrated.
    const projectKey =
      this.route.snapshot.paramMap.get('projectKey') ?? this.projectStore.activeProject()?.key ?? task.projectId;

    // Canonical task URL uses the project key + task number
    return ['/w', tenantSlug, 'projects', projectKey, 'tasks', `${projectKey}-${task.number}`];
  }

  protected goToTask(task: Task): void {
    this.router.navigate(this.taskLinkCommands(task));
  }

  /** Middle-click (auxclick, button 1) opens the task in a new tab */
  protected openTaskInNewTab(event: MouseEvent, task: Task): void {
    if (event.button !== 1) return;

    event.preventDefault();

    const tenantSlug = getTenantSlug(this.route);
    const projectKey =
      this.route.snapshot.paramMap.get('projectKey') ?? this.projectStore.activeProject()?.key ?? task.projectId;
    const url = this.router.serializeUrl(
      this.router.createUrlTree(['/w', tenantSlug, 'projects', projectKey, 'tasks', `${projectKey}-${task.number}`]),
    );

    window.open(url, '_blank');
  }

  // ─── Date-range filter helpers ─────────────────────────────────────────────

  private static toIsoDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

    return `${y}-${m}-${d}`;
  }

  protected isoToDate(value: string): Date | undefined {
    if (!value) return undefined;

    const [y, m, d] = value.split('-').map(Number);

    if (y === undefined || m === undefined || d === undefined) return undefined;

    return new Date(y, m - 1, d);
  }

  /**
   * Trigger label formatter for the date-filter pickers — the
   * selected date renders with the user's date format + active locale via
   * DatePipe (no weekday), instead of the picker's raw default. Passed as
   * `formatDate` to the `hlm-date-picker` instances in the template.
   */
  protected readonly dateFilterTriggerFormat = (date: Date): string => {
    const locale = this.preferencesStore.language();

    return new DatePipe(locale).transform(date, this.preferencesStore.datePipeFormat(), undefined, locale) ?? '';
  };
  /**
   * Round-4 F2: per-column UI-mode override. Picking e.g. 'between' before any
   * dates exist must NOT invent bounds — the override keeps the UI in the chosen
   * mode until real bounds determine it again (or the filter is removed/cleared).
   */
  private readonly dateModeOverrides = signal<Partial<Record<string, string>>>({});

  private setDateModeOverride(col: TaskColumnDef, mode: string): void {
    this.dateModeOverrides.update((overrides) => ({ ...overrides, [col.columnKey]: mode }));
  }

  private clearDateModeOverride(col: TaskColumnDef): void {
    this.dateModeOverrides.update((overrides) => {
      if (!(col.columnKey in overrides)) return overrides;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [col.columnKey]: _removed, ...rest } = overrides;

      return rest;
    });
  }

  /** Derive the popover's mode select value from the current from/to bounds */
  private dateMode(col: TaskColumnDef): 'none' | 'on' | 'before' | 'after' | 'between' {
    // Round-4 F2: an explicit user choice wins over the derived mode
    const override = this.dateModeOverrides()[col.columnKey];

    if (
      override === 'none' ||
      override === 'on' ||
      override === 'before' ||
      override === 'after' ||
      override === 'between'
    ) {
      return override;
    }

    const from = col.getDateFrom?.() ?? '';
    const to = col.getDateTo?.() ?? '';

    if (!from && !to) return 'none';
    if (from && to) return from === to ? 'on' : 'between';

    return to ? 'before' : 'after';
  }

  /**
   * Round-4 F1: translated trigger label for the date-mode select (values are raw
   * mode strings — without this the trigger shows 'none'/'between'/… verbatim).
   */
  protected readonly dateModeToString = (mode: string): string =>
    this.transloco.translate(`taskTable.dateMode.${mode}`);

  /**
   * Round-4 F2: switching modes NEVER invents dates (the old `today` fallback wrote
   * createdFrom=createdTo=<today> the moment 'between' was picked). Only EXISTING
   * bounds are rearranged; the UI-mode override keeps the chosen mode visible.
   */
  protected onDateModeChange(col: TaskColumnDef, mode: string): void {
    const from = col.getDateFrom?.() ?? '';
    const to = col.getDateTo?.() ?? '';

    switch (mode) {
      case 'none':
        this.clearDateModeOverride(col);
        col.setDateRange?.('', '');
        break;

      case 'on': {
        this.setDateModeOverride(col, mode);

        const d = from || to;

        col.setDateRange?.(d, d);
        break;
      }

      case 'before':
        this.setDateModeOverride(col, mode);
        col.setDateRange?.('', to || from);
        break;

      case 'after':
        this.setDateModeOverride(col, mode);
        col.setDateRange?.(from || to, '');
        break;

      case 'between': {
        this.setDateModeOverride(col, mode);

        if (from) {
          col.setDateRange?.(from, '');
        } else if (to) {
          col.setDateRange?.('', to);
        } else {
          col.setDateRange?.('', '');
        }
        break;
      }
    }
  }

  protected onDateFromChange(col: TaskColumnDef, value: Date | null): void {
    col.setDateRange?.(value ? TaskTable.toIsoDate(value) : '', col.getDateTo?.() ?? '');
  }

  protected onDateToChange(col: TaskColumnDef, value: Date | null): void {
    col.setDateRange?.(col.getDateFrom?.() ?? '', value ? TaskTable.toIsoDate(value) : '');
  }

  /** Single-bound modes ('on'/'before'/'after') share one picker */
  protected onSingleDateChange(col: TaskColumnDef, value: Date | null): void {
    const iso = value ? TaskTable.toIsoDate(value) : '';

    if (this.dateMode(col) === 'before') {
      col.setDateRange?.('', iso);
    } else {
      col.setDateRange?.(iso, this.dateMode(col) === 'on' ? iso : '');
    }
  }

  // ─── Multi-select + bulk actions ───────────────────────────────────────────

  /** Toggle a single row's checkbox */
  protected toggleRowSelection(taskId: string, checked: boolean): void {
    const next = new Set(this.selectedIds());

    if (checked) {
      next.add(taskId);
    } else {
      next.delete(taskId);
    }
    this.selectedIds.set(next);
  }

  /** Header select-all — page-scoped (only the tasks currently loaded) */
  protected toggleSelectAll(checked: boolean): void {
    this.selectedIds.set(checked ? new Set(this.tasks().map((task) => task.id)) : new Set());
  }

  private clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /** V9-4: resolve the selected status id to its label for the bulk trigger */
  protected readonly statusItemToString = (id: string) => this.refStore.nameOf(this.projectId(), 'statuses', id);

  /** Setting one bulk field clears the others (exactly-one contract) */
  protected onBulkStatusChange(value: string): void {
    this.bulkStatus.set(value);

    if (value) {
      this.bulkAssignee.set('');
      this.bulkSprint.set('');
    }
  }

  protected onBulkAssigneeChange(value: string): void {
    this.bulkAssignee.set(value);

    if (value) {
      this.bulkStatus.set('');
      this.bulkSprint.set('');
    }
  }

  protected onBulkSprintChange(value: string): void {
    this.bulkSprint.set(value);

    if (value) {
      this.bulkStatus.set('');
      this.bulkAssignee.set('');
    }
  }

  private resetBulkFields(): void {
    this.bulkStatus.set('');
    this.bulkAssignee.set('');
    this.bulkSprint.set('');
  }

  /** Apply the single chosen field to every selected task */
  protected applyBulkUpdate(): void {
    if (!this.canApplyBulk() || this.applyingBulk() || this.selectedCount() === 0) return;

    const data: BulkUpdateTasks['data'] = {};

    if (this.bulkStatus()) {
      data.statusId = this.bulkStatus();
    } else if (this.bulkAssignee()) {
      data.assigneeId = this.bulkAssignee() === BULK_UNASSIGNED ? null : this.bulkAssignee();
    } else if (this.bulkSprint()) {
      data.sprintId = this.bulkSprint() === BULK_NO_SPRINT ? null : this.bulkSprint();
    }

    this.applyingBulk.set(true);
    this.taskClient.bulkUpdate(this.projectId(), { taskIds: [...this.selectedIds()], data }).subscribe({
      next: (res) => {
        this.applyingBulk.set(false);

        if (res.failed && res.failed.length > 0) {
          this.notify.error('taskTable.bulk.partial', { count: res.updated, failed: res.failed.length });
        } else {
          this.notify.success('taskTable.bulk.success', { count: res.updated });
        }
        this.clearSelection();
        this.resetBulkFields();
        // Re-fetch the current page so updated rows are reflected
        this.tasksResource.reload();
      },
      error: (err) => {
        this.applyingBulk.set(false);
        this.notify.error(getErrorMessage(err));
      },
    });
  }

  // ─── Filter Panel Dialog ──────────────────────────────────────────────────

  protected onFilterApplied(state: AppliedFilterState): void {
    this.showFilterDialog.set(false);

    const criteria = state.filters;
    const params: Record<string, string | number | null> = {
      search: criteria.search ?? null,
      priorityLevel: criteria.priorityLevel?.[0] ?? null,
      status: this.idToName('statuses', criteria.statusIds?.[0] ?? ''),
      type: this.idToName('types', criteria.typeIds?.[0] ?? ''),
      assignee: this.idToName('members', criteria.assigneeIds?.[0] ?? ''),
      reporter: this.idToName('members', criteria.reporterIds?.[0] ?? ''),
      sprint: this.idToName('sprints', criteria.sprintIds?.[0] ?? ''),
      label: this.idToName('labels', criteria.labelIds?.[0] ?? ''),
      // Re-apply saved date ranges like any other criterion
      createdFrom: criteria.createdFrom ?? null,
      createdTo: criteria.createdTo ?? null,
      updatedFrom: criteria.updatedFrom ?? null,
      updatedTo: criteria.updatedTo ?? null,
      page: null,
    };

    // Apply sort from saved filter
    if (state.sort?.field) {
      params['sort'] = `${state.sort.field}:${state.sort.direction}`;
    }

    this.patchParams(params);
  }

  /** Navigate to the unified create-task page (U1 — replaces the table dialog) */
  goToNewTask(): void {
    const tenantSlug = getTenantSlug(this.route);
    const projectKey = this.route.snapshot.paramMap.get('projectKey') ?? this.projectStore.activeProject()?.key ?? '';

    this.router.navigate(['/w', tenantSlug, 'projects', projectKey, 'tasks', 'new']);
  }
}
