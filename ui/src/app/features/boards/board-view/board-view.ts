import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { getTenantSlug } from '@app/shared/utils/route-utils';
import { Router, ActivatedRoute } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { provideIcons } from '@ng-icons/core';
import { lucidePlus, lucideX } from '@ng-icons/lucide';
import { CdkDragDrop, CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { rxResource } from '@angular/core/rxjs-interop';
import { of, tap } from 'rxjs';
import { BoardClient } from '@services/board-client';
import { TaskClient, toBoardTask, type BoardPageQuery } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { canWrite } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { NgIcon } from '@ng-icons/core';
import type { BoardColumn, BoardConfig, BoardTask, BoardColumnPage } from '@task-board/shared';
import { decodeBoardCursor } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { priorityLabelKey, priorityLevelParam } from '@app/constants/priority';
import type { TaskPriorityLevel } from '@task-board/shared';
import type { TaskPriorityLevel as SharedPriorityLevel } from '@task-board/shared';
import { TaskCard } from '../task-card/task-card';
import { BoardSentinel } from '@app/shared/board-sentinel/board-sentinel';
import { PRIORITY_OPTIONS } from '@app/constants/priority';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';

/**
 * Paginated state of one board column (fixed `BOARD_PAGE_SIZE` cards per
 * server page). `hasMore`/`nextCursor` are server state — a DnD move never
 * mutates them, it only reconciles the local `tasks` array.
 */
export interface BoardColumnState {
  tasks: BoardTask[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

/**
 * Whether a failed request is the CALLER's to report.
 *
 * The global `errorInterceptor` toasts every 5xx and every network failure, so a
 * component that also toasted those would show two toasts for one failure
 * (AGENTS.md §UI). A 4xx — forbidden, conflict, validation — is the case the
 * interceptor deliberately leaves to the caller. A value that is not an HTTP
 * response at all has no status and belongs to whoever caught it.
 *
 * The same rule is applied in `task-table.ts`; it is a property of the
 * interceptor contract, not of one component.
 */
function isCallerHandled(err: unknown): boolean {
  return err instanceof HttpErrorResponse && err.status >= 400 && err.status < 500;
}

@Component({
  selector: 'ui-board-view',
  imports: [
    HlmAlertImports,
    TranslocoPipe,
    TaskCard,
    BoardSentinel,
    NgIcon,
    CdkDrag,
    CdkDropList,
    HlmButtonImports,
    HlmBadgeImports,
    HlmDialogImports,
    HlmSpinnerImports,
    HlmSelectImports,
    HlmTooltipImports,
  ],
  providers: [provideIcons({ lucidePlus, lucideX })],
  templateUrl: './board-view.html',
})
export class BoardView {
  private readonly notify = injectToasts();
  private readonly boardClient = inject(BoardClient);
  private readonly taskClient = inject(TaskClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly refStore = inject(ProjectRefStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly projectKey = input<string>('');
  /** Optional sprint filter from query params (`?sprintId=…`) */
  readonly sprintId = input<string | null>(null);
  /**
   * Optional assignee filter from query params (`?assignee=…`).
   * Values: `me` (symbolic — resolved to the AuthStore user id at query time),
   * `unassigned` (client-side post-filter), or a concrete member user id.
   */
  readonly assignee = input<string | null>(null);
  /** Optional priority filter from query params (`?priorityLevel=…`) */
  readonly priorityLevel = input<TaskPriorityLevel | null>(null, { transform: priorityLevelParam });
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /** Board page header shows the project name — the board itself has no name (single-board model). */
  protected readonly projectName = computed(() => this.projectStore.activeProject()?.name ?? '');
  private readonly i18n = inject(TranslocoService);
  /** Tasks live under the active project */
  private readonly effectiveProjectId = this.projectId;
  // ─── Reads (rxResource — auto refetch/cancel when params change) ──────────
  private readonly boardResource = rxResource<BoardConfig | null, { projectId: string }>({
    params: () => ({ projectId: this.projectId() }),
    stream: ({ params }) => (params.projectId ? this.boardClient.getForProject(params.projectId) : of(null)),
    defaultValue: null,
  });
  private readonly board = computed(() => (this.boardResource.hasValue() ? this.boardResource.value() : null));
  /**
   * Per-column paginated card state, keyed by board column id. Replaced
   * wholesale on initial load / filter change, appended to by load-more,
   * reconciled in place by drag-and-drop (never refetched after a move).
   */
  private readonly columnStates = signal<Record<string, BoardColumnState>>({});
  /**
   * Board generation — bumped for every initial-pages request. Stale
   * pagination responses (filter changed mid-flight) are dropped instead of
   * overwriting the fresh board state.
   */
  private pagesGeneration = 0;
  /** Task ids with an in-flight DnD mutation — a second drag waits. */
  private readonly pendingMutations = new Set<string>();
  /** Columns whose sentinels fired — flushed as ONE request (micro-batch). */
  private readonly pendingColumns = new Set<string>();
  private loadMoreTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Initial column pages. Refetches automatically when the project, the board
   * config or any filter changes (stale streams are cancelled by rxResource
   * and additionally guarded by `pagesGeneration`).
   */
  private readonly pagesResource = rxResource({
    params: () => ({
      pid: this.effectiveProjectId(),
      board: this.board(),
      sprintId: this.sprintId(),
      assignee: this.assignee(),
      priorityLevel: this.priorityLevel(),
    }),
    stream: ({ params }) => {
      const board = params.board;

      if (!params.pid || !board) return of(null);

      const generation = ++this.pagesGeneration;

      return this.taskClient.listBoardPages(params.pid, this.buildPageQuery({})).pipe(
        tap((page) => {
          if (generation === this.pagesGeneration) this.setInitialStates(board, page);
        }),
      );
    },
    defaultValue: null,
  });
  /**
   * Display cards per column — the stored (server-filtered) pages with
   * the `unassigned` pseudo-filter applied client-side. Computed once per
   * change instead of filter-per-column on every CD cycle.
   */
  protected readonly displayedTasksByColumnId = computed(() => {
    const map = new Map<string, BoardTask[]>();
    const states = this.columnStates();
    const unassignedOnly = this.assignee() === 'unassigned';

    for (const column of this.board()?.columns ?? []) {
      const tasks = states[column.id]?.tasks ?? [];

      map.set(column.id, unassignedOnly ? tasks.filter((task) => !task.assigneeId) : tasks);
    }

    return map;
  });
  /** Project members — powers the assignee filter options (shared ref store) */
  private readonly memberOptions = computed(() => this.refStore.options(this.effectiveProjectId(), 'members'));
  /** Display label of the active assignee filter (chip + select trigger) */
  private readonly selectedAssigneeLabel = computed(() => {
    const value = this.assignee();

    if (!value) return '';

    switch (value) {
      case 'me':
        return this.i18n.translate('boardView.currentUser');

      case 'unassigned':
        return this.i18n.translate('boardView.unassigned');

      default:
        return this.memberOptions().find((o) => o.id === value)?.name ?? value;
    }
  });

  /** Translated priority label; unknown values render verbatim. */
  private priorityLabel(priorityLevel: SharedPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.i18n.translate(key) : String(priorityLevel);
  }
  /** Display label of the active priority filter (chip + select trigger) */
  protected readonly selectedPriorityLabel = computed(() =>
    this.priorityLevel() !== null ? this.priorityLabel(this.priorityLevel() as SharedPriorityLevel) : '',
  );
  /**
   * Sprints of the board's project — powers the sprint selector.
   * Shared ProjectRefStore cache — no per-page duplicate request.
   */
  private readonly sprints = computed(() => this.refStore.sprintEntities(this.effectiveProjectId()));
  /** Display name of the currently scoped sprint (falls back to the raw id) */
  protected readonly selectedSprintName = computed(() => {
    const id = this.sprintId();

    if (!id) return '';

    return this.sprints().find((s) => s.id === id)?.name ?? id;
  });
  /** Global spinner covers the board config and the initial column pages (not load-more). */
  protected readonly loading = computed(() => this.boardResource.isLoading() || this.pagesResource.isLoading());
  protected readonly error = computed(() => {
    const err = this.boardResource.error();

    return err ? getErrorMessage(err) : '';
  });
  // Reference data (statuses, task types for the card's bottom row) via the shared store
  private readonly statusMap = computed(() => this.refStore.nameMap(this.effectiveProjectId(), 'statuses'));
  /** typeId → issue-type display name (board card bottom-left) */
  protected readonly typeMap = computed(() => this.refStore.nameMap(this.effectiveProjectId(), 'types'));

  constructor() {
    effect(() => {
      const pid = this.effectiveProjectId();

      if (!pid) return;

      // Track the entity lists so an invalidate() (sprint/status mutations)
      // re-runs this effect and refetches through ensure().
      this.refStore.sprintEntities(pid);
      this.refStore.statusEntities(pid);
      this.refStore.ensure(pid, ['statuses', 'sprints', 'members', 'types']);
    });
    this.destroyRef.onDestroy(() => {
      if (this.loadMoreTimer !== null) {
        clearTimeout(this.loadMoreTimer);
        this.loadMoreTimer = null;
      }
    });
  }

  protected readonly canCreateTask = computed(() =>
    canWrite(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** itemToString helper for hlm-select to display human-readable status labels */
  protected readonly statusItemToString = (id: string) => this.statusMap()[id] ?? id;
  protected readonly priorityOptions = PRIORITY_OPTIONS;
  /** itemToString helper for the sprint selector — name + status badge text */
  protected readonly sprintItemToString = (id: string) => {
    const sprint = this.sprints().find((s) => s.id === id);

    return sprint ? `${sprint.name} (${sprint.status})` : id;
  };
  /** itemToString helper for the assignee filter — symbolic values resolve to labels */
  protected readonly assigneeItemToString = (value: string): string => {
    if (!value) return '';

    return value === this.assignee()
      ? (this.selectedAssigneeLabel() ?? '')
      : (this.memberOptions().find((o) => o.id === value)?.name ?? value);
  };
  /** itemToString helper for the priority filter */
  protected readonly priorityItemToString = (value: TaskPriorityLevel | ''): string =>
    value === '' ? '' : this.priorityLabel(value);

  /**
   * Write one board filter to the URL query params (replaceUrl, merged with
   * the other filters). Empty value clears it; the pages resource refetches.
   */
  private setFilterParam(name: 'sprintId' | 'assignee' | 'priorityLevel', value: string): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [name]: value || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Sprint selector change → write `?sprintId=` to the URL (replaceUrl).
   * Empty value clears the scope; the pages resource refetches automatically.
   */
  protected onSprintSelect(value: string): void {
    this.setFilterParam('sprintId', value);
  }

  /** Assignee filter change → write `?assignee=` (`me` stays symbolic in the URL) */
  protected onAssigneeSelect(value: string): void {
    this.setFilterParam('assignee', value);
  }

  /** Priority filter change → write `?priority=` */
  protected onPrioritySelect(value: string | number): void {
    const level = value === '' || value === null ? null : Number(value);

    this.setFilterParam('priorityLevel', level === null ? '' : String(level));
  }
  private readonly showStatusSelect = signal(false);
  private readonly pendingDrop = signal<{ task: BoardTask; targetColumn: BoardColumn } | null>(null);
  /**
   * a11y: the keyboard "move to column" picker (`v` on a focused card). CDK
   * drag-and-drop is pointer-only, so without this a keyboard / screen-reader
   * user could not change a card's column at all. The pick reuses the SAME
   * mutation path as a drop (`moveTaskToStatus`, incl. the multi-status prompt).
   */
  private readonly showMoveToColumn = signal(false);
  private readonly pendingMove = signal<BoardTask | null>(null);
  /** Target columns for the pending move — every column except the card's current one. */
  protected readonly moveTargets = computed(() => {
    const task = this.pendingMove();
    const board = this.board();

    if (!task || !board) return [];

    const current = this.columnOwnerByStatusId().get(task.statusId)?.id;

    return board.columns.filter((column) => column.id !== current);
  });
  /**
   * Display name per column id — computed once per change instead of
   * re-running per column on every CD cycle.
   */
  protected readonly columnNames = computed(() => {
    const map = new Map<string, string>();
    const statusNames = this.statusMap();

    for (const col of this.board()?.columns ?? []) {
      const names = col.statusIds.map((id) => statusNames[id]).filter(Boolean);

      map.set(col.id, names.length > 0 ? names.join(' / ') : `Column ${col.position + 1}`);
    }

    return map;
  });
  /**
   * V4-12: statusId → the single column that owns it. Board documents may contain
   * overlapping statusIds across columns (e.g. an "In Progress / Reopened" column
   * next to a pure "In Progress" column); assigning each status to exactly one
   * owner column guarantees every task renders in exactly ONE column — its actual
   * status. Ownership prefers the MOST SPECIFIC column (fewest statusIds), then
   * the lowest position — so an IN_PROGRESS task lands in the dedicated
   * "In Progress" column, while REOPENED stays in the combined column.
   */
  private readonly columnOwnerByStatusId = computed(() => {
    const owner = new Map<string, BoardColumn>();
    const b = this.board();

    if (!b) return owner;

    for (const col of [...b.columns].sort(
      (a, z) => a.statusIds.length - z.statusIds.length || a.position - z.position,
    )) {
      for (const statusId of col.statusIds) {
        if (!owner.has(statusId)) owner.set(statusId, col);
      }
    }

    return owner;
  });

  /**
   * Loaded-count label for a column header. Pagination means the column holds
   * a prefix, not a total — a trailing `+` marks that more cards exist
   * server-side (`hasMore`). Never a server total (no `countDocuments` on the
   * board path by contract).
   */
  protected columnCountLabel(columnId: string): string {
    const state = this.columnStates()[columnId];

    if (!state) return '0';

    return state.hasMore ? `${state.tasks.length}+` : `${state.tasks.length}`;
  }

  /** Sentinel is live only while a next page exists and none is loading. */
  protected sentinelActive(columnId: string): boolean {
    const state = this.columnStates()[columnId];

    return !!state && state.hasMore && !state.loading;
  }

  /** Board filter values shared by initial load and load-more requests. */
  private buildPageQuery(cursors: Record<string, string>): BoardPageQuery {
    const query: BoardPageQuery = {};

    if (Object.keys(cursors).length > 0) query.cursors = cursors;

    const sprintId = this.sprintId();

    if (sprintId) query.sprintId = sprintId;

    // Concrete assignee/priority filters go server-side (same as sprintId).
    // `me` resolves to the current user id at query time; `unassigned` has no
    // server-side equivalent (exact-id match only) and is post-filtered in
    // `displayedTasksByColumnId`.
    const assignee = this.assignee();
    const resolvedAssignee = assignee === 'me' ? (this.authStore.currentUser()?.id ?? '') : (assignee ?? '');

    if (resolvedAssignee && resolvedAssignee !== 'unassigned') {
      query.assigneeId = resolvedAssignee;
    }

    const priorityLevel = this.priorityLevel();

    if (priorityLevel !== null && priorityLevel !== undefined) {
      query.priorityLevel = priorityLevel;
    }

    return query;
  }

  /** Replace every column state with a fresh initial page (filter change / first load). */
  private setInitialStates(board: BoardConfig, page: Record<string, BoardColumnPage>): void {
    const states: Record<string, BoardColumnState> = {};

    for (const column of board.columns) {
      const columnPage = page[column.id];

      states[column.id] = {
        tasks: columnPage?.tasks ?? [],
        nextCursor: columnPage?.nextCursor ?? null,
        hasMore: columnPage?.hasMore ?? false,
        loading: false,
      };
    }

    this.columnStates.set(states);
  }

  private setColumnLoading(columnIds: readonly string[], loading: boolean): void {
    this.columnStates.update((states) => {
      const next = { ...states };
      let changed = false;

      for (const id of columnIds) {
        const current = next[id];

        if (current && current.loading !== loading) {
          next[id] = { ...current, loading };
          changed = true;
        }
      }

      return changed ? next : states;
    });
  }

  /** Append one page with dedupe by id (a moved card may arrive twice). */
  private appendPage(columnId: string, page: BoardColumnPage): void {
    this.columnStates.update((states) => {
      const current = states[columnId];

      if (!current) return states;

      const seen = new Set(current.tasks.map((task) => task.id));
      const fresh = page.tasks.filter((task) => !seen.has(task.id));

      return {
        ...states,
        [columnId]: {
          tasks: [...current.tasks, ...fresh],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          loading: current.loading,
        },
      };
    });
  }

  /**
   * Sentinel fired for one column — micro-batched so simultaneously hungry
   * sentinels share a single HTTP request with several cursor params.
   */
  protected requestNextPage(columnId: string): void {
    const state = this.columnStates()[columnId];

    if (!state || !state.hasMore || state.loading) return;

    this.pendingColumns.add(columnId);

    if (this.loadMoreTimer !== null) return;

    this.loadMoreTimer = setTimeout(() => {
      this.loadMoreTimer = null;
      this.flushPendingPages();
    }, 0);
  }

  /** Load the next page for every pending column in one HTTP request. */
  private flushPendingPages(): void {
    const ids = [...this.pendingColumns];

    this.pendingColumns.clear();

    const ready = ids.filter((id) => {
      const state = this.columnStates()[id];

      return !!state && state.hasMore && !state.loading;
    });

    if (ready.length === 0) return;

    const pid = this.effectiveProjectId();

    if (!pid) return;

    const generation = this.pagesGeneration;
    const cursors: Record<string, string> = {};

    for (const id of ready) {
      // `hasMore` always comes with a cursor from the server; a missing one
      // is skipped defensively instead of refetching the first page.
      const cursor = this.columnStates()[id]?.nextCursor;

      if (cursor) cursors[id] = cursor;
    }

    if (Object.keys(cursors).length === 0) return;

    this.setColumnLoading(ready, true);
    this.taskClient.listBoardPages(pid, this.buildPageQuery(cursors)).subscribe({
      next: (page) => {
        if (generation !== this.pagesGeneration) return;

        for (const id of ready) {
          const columnPage = page[id];

          if (columnPage) this.appendPage(id, columnPage);
        }

        this.setColumnLoading(ready, false);
      },
      error: (err) => {
        if (generation !== this.pagesGeneration) return;

        this.setColumnLoading(ready, false);
        // 4xx only: a 5xx or a network failure is already toasted by the global
        // errorInterceptor, and toasting it again here showed the user two.
        if (isCallerHandled(err)) this.notify.error(getErrorMessage(err));
      },
    });
  }

  // The `allStatusIds` getter was removed as dead code — column status ids are
  // read from the board config directly where needed.

  /** Navigate to the unified create-task page (U1 — replaces the board dialog) */
  goToNewTask(): void {
    const projectKey = this.route.snapshot.paramMap.get('projectKey') ?? this.projectStore.activeProject()?.key ?? '';

    this.router.navigate(['/w', getTenantSlug(this.route), 'projects', projectKey, 'tasks', 'new']);
  }

  /** Handle CDK drag-drop event */
  protected onTaskDrop(event: CdkDragDrop<BoardTask[], BoardTask[], BoardTask>, column: BoardColumn): void {
    const task = event.item.data;

    if (!task) return;

    // Same-column drops carry no persisted position (order is sort-derived).
    if (event.previousContainer === event.container) return;

    // If column has multiple statuses, prompt user to select
    if (column.statusIds.length > 1) {
      this.pendingDrop.set({ task, targetColumn: column });
      this.showStatusSelect.set(true);
      return;
    }

    // Single status column — apply directly
    const targetStatusId = column.statusIds[0];

    if (targetStatusId) {
      this.moveTaskToStatus(task, targetStatusId);
    }
  }

  /** Apply the selected status from the multi-status prompt */
  protected applyStatusSelection(statusId: string): void {
    const pending = this.pendingDrop();

    if (pending) {
      this.moveTaskToStatus(pending.task, statusId);
    }
    this.showStatusSelect.set(false);
    this.pendingDrop.set(null);
  }

  protected onStatusSelectDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showStatusSelect.set(false);
      this.pendingDrop.set(null);
    }
  }

  /** a11y: open the "move to column" picker for a card focused via the keyboard. */
  protected openMoveToColumn(task: BoardTask): void {
    this.pendingMove.set(task);
    this.showMoveToColumn.set(true);
  }

  /**
   * Apply a keyboard move: identical semantics to a cross-column drop — a
   * multi-status column still asks which status the card should land in.
   */
  protected moveToColumn(column: BoardColumn): void {
    const task = this.pendingMove();

    this.showMoveToColumn.set(false);
    this.pendingMove.set(null);

    if (!task) return;

    if (column.statusIds.length > 1) {
      this.pendingDrop.set({ task, targetColumn: column });
      this.showStatusSelect.set(true);
      return;
    }

    const targetStatusId = column.statusIds[0];

    if (targetStatusId) {
      this.moveTaskToStatus(task, targetStatusId);
    }
  }

  protected onMoveToColumnDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showMoveToColumn.set(false);
      this.pendingMove.set(null);
    }
  }

  /**
   * Move a task to a new status with optimistic local reconciliation — no
   * column refetch, no cursor/hasMore/scroll changes. The server-returned
   * card (fresh version) replaces the local object; single-card upserts are
   * safe across board generations, so no generation guard is needed here.
   */
  private moveTaskToStatus(task: BoardTask, statusId: string): void {
    if (this.pendingMutations.has(task.id)) return;

    const sourceColumnId = this.columnOwnerByStatusId().get(task.statusId)?.id ?? null;

    this.removeCard(task.id);
    this.pendingMutations.add(task.id);
    this.taskClient.update(task.id, { statusId, version: task.version }).subscribe({
      next: (updated) => {
        this.pendingMutations.delete(task.id);
        this.applyMutationCard(toBoardTask(updated));
      },
      error: (err) => {
        this.pendingMutations.delete(task.id);

        if (err instanceof HttpErrorResponse && err.status === 409) {
          // Someone else bumped the version — refresh the single card and
          // route it by its fresh status instead of rolling back blindly.
          this.taskClient.getById(task.id).subscribe({
            next: (fresh) => this.applyMutationCard(toBoardTask(fresh)),
            error: (refreshErr) => {
              this.removeCard(task.id);
              this.notify.error(getErrorMessage(refreshErr));
            },
          });
        } else if (err instanceof HttpErrorResponse && err.status === 404) {
          // Deleted elsewhere — the optimistic removal already stands.
          this.notify.error(getErrorMessage(err));
        } else {
          this.restoreCard(task, sourceColumnId);
          this.notify.error(getErrorMessage(err));
        }
      },
    });
  }

  /**
   * Route one fresh card into its owner column: insert sorted when it belongs
   * to the loaded prefix, skip when it sits behind the cursor (it arrives via
   * load-more), always insert into an exhausted column (terminal server set).
   * Cursor and `hasMore` are never touched here.
   */
  private applyMutationCard(card: BoardTask): void {
    this.removeCard(card.id);

    const targetId = this.columnOwnerByStatusId().get(card.statusId)?.id;

    if (!targetId) return;

    const state = this.columnStates()[targetId];

    if (!state) return;

    if (!state.hasMore || this.sortsWithinPrefix(card, state.nextCursor)) {
      this.insertCardSorted(targetId, card);
    }
  }

  /**
   * True when the card sorts at or before the loaded prefix end
   * (`priorityLevel` DESC, `number` ASC against the decoded cursor).
   */
  private sortsWithinPrefix(card: BoardTask, nextCursor: string | null): boolean {
    if (!nextCursor) return true;

    try {
      const cursor = decodeBoardCursor(nextCursor);

      return (
        card.priorityLevel > cursor.priorityLevel ||
        (card.priorityLevel === cursor.priorityLevel && card.number <= cursor.number)
      );
    } catch {
      return true;
    }
  }

  /** Sorted insert (no duplicates, no tail truncation — see `applyMutationCard`). */
  private insertCardSorted(columnId: string, card: BoardTask): void {
    this.columnStates.update((states) => {
      const current = states[columnId];

      if (!current || current.tasks.some((task) => task.id === card.id)) return states;

      const tasks = [...current.tasks, card].sort((a, b) => b.priorityLevel - a.priorityLevel || a.number - b.number);

      return { ...states, [columnId]: { ...current, tasks } };
    });
  }

  /** Remove one card from every column (source side of a move, rollback aid). */
  private removeCard(taskId: string): void {
    this.columnStates.update((states) => {
      let changed = false;
      const next: Record<string, BoardColumnState> = {};

      for (const [id, column] of Object.entries(states)) {
        const tasks = column.tasks.filter((task) => task.id !== taskId);

        if (tasks.length !== column.tasks.length) {
          changed = true;
          next[id] = { ...column, tasks };
        } else {
          next[id] = column;
        }
      }

      return changed ? next : states;
    });
  }

  /** Rollback aid: re-insert into the source column, cursor/`hasMore` untouched. */
  private restoreCard(card: BoardTask, sourceColumnId: string | null): void {
    if (sourceColumnId && this.columnStates()[sourceColumnId]) {
      this.insertCardSorted(sourceColumnId, card);
    } else {
      this.applyMutationCard(card);
    }
  }

  /** Get the CDK drop list IDs for all columns */
  protected getColumnDropId(column: BoardColumn): string {
    return `column-${column.id}`;
  }

  protected goToTask(task: BoardTask): void {
    const projectKey = this.route.snapshot.paramMap.get('projectKey') ?? this.projectStore.activeProject()?.key ?? '';

    // Canonical task URL uses the project key + task number
    this.router.navigate([
      '/w',
      getTenantSlug(this.route),
      'projects',
      projectKey,
      'tasks',
      `${projectKey}-${task.number}`,
    ]);
  }
}
