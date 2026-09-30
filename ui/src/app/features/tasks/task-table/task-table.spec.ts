/**
 * Tests for the TaskTable:
 *
 * - Debounced free-text search (~300 ms)
 * - Filtered-empty vs true-empty distinction
 * - Active-filter chips with per-chip removal + clear-all
 * - Fixed table layout, stable body height, Auto page-size
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TASK_SEARCH_MIN_LENGTH } from '@task-board/shared';
import { By } from '@angular/platform-browser';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { TranslocoTestingModule, TranslocoService } from '@jsverse/transloco';
import { TaskTable } from './task-table';
import { safeNumericParam } from '@app/shared/utils/numeric-param';
import { AUTO_PAGE_SIZE_SENTINEL, computeAutoPageSize } from '@app/shared/auto-table/auto-page-size';
import { TaskClient } from '@services/task-client';
import { FilterClient } from '@services/filter-client';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import { clickUntil, settle } from '@app/shared/testing/zoneless';
import { toast } from '@spartan-ng/brain/sonner';

vi.mock('@spartan-ng/brain/sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('TaskTable — W9 polish', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<TaskTable>;
  let taskClientMock: { list: ReturnType<typeof vi.fn>; bulkUpdate?: ReturnType<typeof vi.fn> };
  let routerMock: { navigate: ReturnType<typeof vi.fn>; events: unknown };
  let routerEvents: Subject<NavigationEnd>;

  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  async function setup(
    inputOverrides: Record<string, unknown> = {},
    storedPageSize = 30,
    tenantRole: string | null = 'OWNER',
    projectRole: string | null = null,
    storedColumns: string[] | null = null,
  ) {
    taskClientMock = {
      list: vi.fn().mockReturnValue(of({ data: [], pagination: { total: 0, page: 1, limit: 30, totalPages: 0 } })),
    };
    routerEvents = new Subject<NavigationEnd>();
    routerMock = { navigate: vi.fn().mockResolvedValue(true), events: routerEvents.asObservable() };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: { en: {} },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: FilterClient, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        {
          provide: ProjectStore,
          useValue: { activeProject: () => ({ id: 'p1', key: 'ABC' }), projectRole: () => projectRole },
        },
        { provide: AuthStore, useValue: { tenantRole: () => tenantRole } },
        {
          provide: PreferencesStore,
          useValue: {
            pageSize: () => storedPageSize,
            // Format token consumed by the Created/Updated columns
            dateTimePipeFormat: () => 'yyyy-MM-dd HH:mm',
            // Active language used as the DatePipe locale
            language: () => 'en',
            datePipeFormat: () => 'yyyy-MM-dd',
            setPageSize: vi.fn(),
            // Per-project visible task-table columns (null = default set)
            getTaskTableColumns: vi.fn(() => storedColumns),
            setTaskTableColumns: vi.fn(),
            loadProjectPreferences: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ProjectRefStore,
          useValue: {
            ensure: vi.fn(),
            // One status so resolveNameToId can map the URL value to its id
            options: (_pid: string, kind: string) => (kind === 'statuses' ? [{ id: 'st1', name: 'To Do' }] : []),
            nameMap: (_pid: string, kind: string) => (kind === 'statuses' ? { st1: 'To Do' } : {}),
            nameOf: (_pid: string, kind: string, id: string) => (kind === 'statuses' && id === 'st1' ? 'To Do' : id),
          },
        },
        { provide: Router, useValue: routerMock },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParams: of({}),
            snapshot: { paramMap: { get: () => 'ABC' } },
            parent: { queryParams: of({}), snapshot: { paramMap: { get: () => 'acme' } }, parent: null },
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TaskTable);

    fixture.componentRef.setInput('projectKey', 'ABC');
    Object.entries(inputOverrides).forEach(([key, value]) => {
      fixture.componentRef.setInput(key, value);
    });

    component = fixture.componentInstance;
    await settle(fixture);
  }

  // ── Debounced search ───────────────────────────────────

  describe('debounced search', () => {
    beforeEach(() => setup());

    it('should not navigate immediately on keystroke', () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: 'foo' } });

      expect(routerMock.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should commit the search param after ~300 ms of inactivity', () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: 'foo' } });
      vi.advanceTimersByTime(300);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { search: 'foo', page: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
      vi.useRealTimers();
    });

    it('should only commit the last value when typing continues', () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: 'fo' } });
      vi.advanceTimersByTime(200);
      component.onSearch({ target: { value: 'foo' } });
      vi.advanceTimersByTime(300);

      const calls = routerMock.navigate.mock.calls as unknown[];

      expect(calls).toHaveLength(1);
      vi.useRealTimers();
    });

    it('should buffer keystrokes locally without touching the URL', () => {
      component.onSearch({ target: { value: 'bar' } });

      expect(component.searchInput()).toBe('bar');
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  // ── Never send a sub-minimum search ─────────────────────
  // The API rejects `search` shorter than TASK_SEARCH_MIN_LENGTH with a 400
  // (a 1-character term matches virtually every task and the server-side
  // `$or` of five regexes is evaluated against all of them). Committing such a
  // value to the URL would trade the 400 for a wasted full-project scan.

  describe('search minimum (F11)', () => {
    beforeEach(() => setup());

    it('should not commit a 1-character search to the URL', () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: 'a' } });
      vi.advanceTimersByTime(300);

      expect(routerMock.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should still show the typed character in the input (the box is not frozen)', () => {
      component.onSearch({ target: { value: 'a' } });

      expect(component.searchInput()).toBe('a');
    });

    it(`should commit as soon as the term reaches the minimum (${TASK_SEARCH_MIN_LENGTH})`, () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: 'a' } });
      component.onSearch({ target: { value: 'r'.repeat(TASK_SEARCH_MIN_LENGTH) } });
      vi.advanceTimersByTime(300);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { search: 'r'.repeat(TASK_SEARCH_MIN_LENGTH), page: null } }),
      );
      vi.useRealTimers();
    });

    it('should always commit an empty value — that is how the search is cleared', () => {
      vi.useFakeTimers();

      component.onSearch({ target: { value: '' } });
      vi.advanceTimersByTime(300);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { search: null, page: null } }),
      );
      vi.useRealTimers();
    });

    it('should not send a sub-minimum search that arrived in the URL (bookmark / shared link)', async () => {
      // The buffer still mirrors the URL (so the input shows what the link asked
      // for), but no request may carry it — the API would answer 400.
      fixture.componentRef.setInput('search', 'a');
      await settle(fixture);

      expect(component.searchInput()).toBe('a');

      const sent = taskClientMock.list.mock.calls.map((call) => (call[1] as { search?: string }).search);

      expect(sent.every((value) => value === undefined)).toBe(true);
    });

    it('should send a search at or above the minimum unchanged', async () => {
      fixture.componentRef.setInput('search', 're');
      await settle(fixture);

      const lastQuery = taskClientMock.list.mock.calls[taskClientMock.list.mock.calls.length - 1]?.[1] as {
        search?: string;
      };

      expect(lastQuery?.search).toBe('re');
    });
  });

  // ── V4-7: no literal "undefined" in the search input ───

  describe('search input rendering (V4-7 regression)', () => {
    it('should render an empty search input when no ?search= param is present', async () => {
      // Simulate withComponentInputBinding handing `undefined` for the absent param
      await setup({ search: undefined });

      expect(component.searchInput()).toBe('');

      const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;

      expect(input.value).not.toContain('undefined');
      expect(input.value).toBe('');
    });

    it('should keep the buffered search text empty when the URL param is removed', async () => {
      await setup({ search: 'hello' });
      expect(component.searchInput()).toBe('hello');

      // Chip removal / back-navigation clears the param — router binds undefined
      fixture.componentRef.setInput('search', undefined);
      await settle(fixture);

      expect(component.searchInput()).toBe('');
    });
  });

  // ── V4-8: Title column width + clickable sort ──────────

  describe('title column header (V4-8 regression)', () => {
    it('should give the Title th an explicit percentage width with a min-width', async () => {
      await setup();

      const headers = fixture.nativeElement.querySelectorAll('thead th');
      // First th is the selection checkbox — Title is the third column
      const titleTh = headers[2] as HTMLElement;

      expect(titleTh.className).toContain('w-[30%]');
      expect(titleTh.className).toContain('min-w-50');
    });

    it('should keep the fixed widths of non-title columns well below typical container widths', async () => {
      await setup();

      // V4-8 (reopened): if these sum ≥ available width, Title collapses to 0px.
      const pxWidths = component.taskColumns
        .filter((c: { field: string }) => c.field !== 'title')
        .map((c: { width?: string }) => Number.parseInt((c.width ?? '').match(/w-(\d+)/)?.[1] ?? '0', 10) * 4);
      const sum = pxWidths.reduce((a: number, b: number) => a + b, 0);

      expect(pxWidths).toHaveLength(10); // every column except Title
      expect(pxWidths.every((w: number) => w > 0)).toBe(true);
      // Trimmed fixed widths (V4-8 reopened) — must stay well below the ~1232px
      // container of a 1280px viewport so Title keeps a usable share.
      expect(sum).toBe(1132);
    });

    it('should yield a Title column wider than 150px at a common desktop viewport (fixed-layout math)', async () => {
      await setup();

      // The unit-test DOM has no layout engine, so assert the CSS invariant the
      // classes encode: under `table-fixed`, when specified widths exceed the
      // table width each column keeps its proportional share — Title's 30% must
      // still clear 150px at a 1280px viewport (~1232px container after px-6).
      const container = 1280 - 48;
      const fixedSum = component.taskColumns
        .filter((c: { field: string }) => c.field !== 'title')
        .reduce(
          (acc: number, c: { width?: string }) =>
            acc + Number.parseInt((c.width ?? '').match(/w-(\d+)/)?.[1] ?? '0', 10) * 4,
          0,
        );
      const titleSpecified = container * 0.3;
      const titleWidth = container * (titleSpecified / Math.max(fixedSum + titleSpecified, container));

      expect(fixedSum).toBeGreaterThan(0);
      expect(titleWidth).toBeGreaterThan(150);
    });

    it('should keep the Title sort button clickable by mouse', async () => {
      await setup();

      const headers = fixture.nativeElement.querySelectorAll('thead th');
      // First th is the selection checkbox — Title is the third column
      const titleTh = headers[2] as HTMLElement;
      const sortButton = titleTh.querySelector('button') as HTMLButtonElement;

      expect(sortButton).toBeTruthy();
      await clickUntil(
        () => sortButton.click(),
        () =>
          expect(routerMock.navigate).toHaveBeenCalledWith(
            [],
            expect.objectContaining({ queryParams: { sort: 'title:asc', page: null } }),
          ),
      );
      await settle(fixture);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { sort: 'title:asc', page: null } }),
      );
    });
  });

  // ── Empty-state distinction ────────────────────────────

  describe('empty states', () => {
    it('should report no active filters when the URL has none', async () => {
      await setup();

      expect(component.hasActiveFilters()).toBe(false);
    });

    it('should detect active filters and build a chip per filter', async () => {
      await setup({ search: 'hello', priorityLevel: 2 });

      expect(component.hasActiveFilters()).toBe(true);

      const chips = component.activeFilterChips();

      expect(chips).toEqual([
        { param: 'search', labelKey: 'taskTable.filterSearch', value: 'hello' },
        // Priority chips show the translated display label (test dict is empty → the key)
        { param: 'priorityLevel', labelKey: 'taskTable.filterPriority', value: 'priority.high' },
      ]);
    });

    it('should resolve reference-data names for filter chips', async () => {
      await setup({ status: 'To Do' });

      expect(component.activeFilterChips()).toEqual([
        { param: 'status', labelKey: 'taskTable.filterStatus', value: 'To Do' },
      ]);
    });
  });

  // ── Chip removal & clear-all ───────────────────────────

  describe('filter removal', () => {
    beforeEach(() => setup());

    it('should remove a single filter via its param', () => {
      component.removeFilter('priorityLevel');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { priorityLevel: null, page: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should clear every filter at once', () => {
      component.clearFilters();

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: {
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
          },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should reset the buffered search text when clearing filters', () => {
      component.onSearch({ target: { value: 'partial' } });
      component.clearFilters();

      expect(component.searchInput()).toBe('');
    });
  });

  // ── New Task navigation ────────────────────────────────

  describe('goToNewTask', () => {
    beforeEach(() => setup());

    it('should navigate to the unified create-task page instead of opening a dialog', () => {
      component.goToNewTask();

      // The ActivatedRoute mock resolves every param to 'ABC' — including tenantSlug
      expect(routerMock.navigate).toHaveBeenCalledWith(['/w', 'ABC', 'projects', 'ABC', 'tasks', 'new']);
    });
  });

  // ── U3/V4-8: constrained table layout ──────────────────
  // V4-8: `table-fixed` ignores `min-width`, so the Title th collapsed to
  // 0px whenever the fixed px columns consumed the table width and the Type
  // header swallowed mouse clicks on the Title sort button. The table must NOT
  // use `table-fixed`; auto layout + per-cell `truncate` keeps widths stable.

  describe('constrained layout (U3 / V4-8)', () => {
    beforeEach(() => setup());

    it('should render a full-width table WITHOUT table-fixed', () => {
      const table = fixture.nativeElement.querySelector('table');

      expect(table.classList.contains('table-fixed')).toBe(false);
      expect(table.classList.contains('w-full')).toBe(true);
    });

    it('should give every non-title column an explicit width class', () => {
      const widths: [string, string | undefined][] = component.taskColumns.map(
        (c: { field: string; width?: string }) => [c.field, c.width],
      );
      const expected: Record<string, string> = {
        number: 'w-23',
        typeId: 'w-23',
        statusId: 'w-33',
        priority: 'w-25',
        assigneeId: 'w-33',
        reporterId: 'w-33',
        sprintId: 'w-28',
        labelIds: 'w-35',
        createdAt: 'w-25',
        updatedAt: 'w-25',
      };

      for (const [field, width] of Object.entries(expected)) {
        expect(widths.find(([f]) => f === field)?.[1]).toBe(width);
      }
      // Title gets an explicit percentage share (V4-8 reopened: no 0px collapse)
      expect(component.taskColumns.find((c: { field: string }) => c.field === 'title').width).toBe('w-[30%] min-w-50');
    });

    it('should hard-truncate a 500-char unbreakable title (max-w-0 + truncate + tooltip)', async () => {
      const longTitle = 'x'.repeat(500);

      taskClientMock.list.mockReturnValue(
        of({
          data: [
            {
              id: 't1',
              number: 1,
              title: longTitle,
              priorityLevel: 2,
              typeId: 'type1',
              statusId: 'st1',
              labelIds: ['l1'],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: { total: 1, page: 1, limit: 30, totalPages: 1 },
        }),
      );

      const fixture2 = TestBed.createComponent(TaskTable);

      fixture2.componentRef.setInput('projectKey', 'ABC');
      await settle(fixture2);

      // First td is the selection checkbox — Title is the third cell
      const titleCell: HTMLElement = fixture2.nativeElement.querySelector('tbody tr td:nth-child(3)');

      // Max-w-0 removes the cell's intrinsic width contribution under table-auto,
      // so an unbreakable title can never widen the column/table (no horizontal scroll)
      expect(titleCell.classList.contains('max-w-0')).toBe(true);
      expect(titleCell.classList.contains('truncate')).toBe(true);

      // Native `[title]` replaced by the HlmTooltip directive on the cell
      const titleCellTooltip = fixture2.debugElement
        .queryAll(By.directive(HlmTooltip))
        .find((d) => d.nativeElement === titleCell);

      expect(titleCellTooltip).toBeTruthy();
    });

    it('should lay out as a fixed-height flex column with a flexing table wrapper (R3-P3)', () => {
      // beforeEach already ran setup()
      const root: HTMLElement = fixture.nativeElement.children[0];

      // Exactly viewport minus app header (--header-height: 4rem) minus main p-6 (2×1.5rem)
      expect(root.classList.contains('h-[calc(100dvh-var(--header-height)-1.5rem)]')).toBe(true);
      expect(root.classList.contains('lg:h-[calc(100dvh-var(--header-height)-3rem)]')).toBe(true);
      expect(root.classList.contains('flex-col')).toBe(true);

      const wrap = component.tableWrapRef()?.nativeElement as HTMLElement | undefined;

      expect(wrap).toBeTruthy();
      expect(wrap?.classList.contains('flex-1')).toBe(true);
      expect(wrap?.classList.contains('min-h-0')).toBe(true);
    });
  });

  // ── Auto page-size ─────────────────────────────────────

  describe('auto page-size (U3 / R3-P3 — measured wrapper height)', () => {
    /**
     * Minimal ResizeObserver stub — jsdom has none. Records instances AND observed
     * elements so tests can trigger the observer watching the table wrapper (other
     * UI-kit directives may create their own observers on the same page).
     */
    class MockResizeObserver {
      static instances: MockResizeObserver[] = [];
      readonly observed: Element[] = [];
      readonly unobserve = vi.fn();
      readonly disconnect = vi.fn();
      private readonly cb: ResizeObserverCallback;

      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        MockResizeObserver.instances.push(this);
      }

      observe(target: Element): void {
        this.observed.push(target);
      }

      trigger(wrapperHeight: number): void {
        this.cb(
          [{ contentRect: { height: wrapperHeight } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
    }

    /** The observer the component attached to the table wrapper */
    function wrapperObserver(): MockResizeObserver | undefined {
      const el = component.tableWrapRef()?.nativeElement as Element | undefined;

      return MockResizeObserver.instances.find((i) => el !== undefined && i.observed.includes(el));
    }

    beforeEach(() => {
      MockResizeObserver.instances = [];
      vi.stubGlobal('ResizeObserver', MockResizeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should compute clamped rows from the measured available height', () => {
      expect(computeAutoPageSize(714)).toBe(14); // floor(714/48)
      expect(computeAutoPageSize(239)).toBe(4); // floor(239/48), above the minimum clamp
      expect(computeAutoPageSize(100000)).toBe(100); // clamped to maximum
    });

    it('should derive the effective size from the MEASURED wrapper when Auto is persisted', async () => {
      await setup({}, AUTO_PAGE_SIZE_SENTINEL);

      expect(component.isAutoMode()).toBe(true);

      const ro = wrapperObserver();

      expect(ro).toBeDefined();

      ro?.trigger(720); // floor(720/48) = 15 rows
      await settle(fixture);

      expect(component.pageSize()).toBe(15);
    });

    it('should recompute on wrapper resize and refetch only when the row count changes', async () => {
      await setup({}, AUTO_PAGE_SIZE_SENTINEL);

      // The probe row renders with a real height in the browser; mock it for jsdom
      const probe: HTMLElement = fixture.nativeElement.querySelector('tbody tr[data-row-probe]');

      expect(probe).toBeTruthy();
      vi.spyOn(probe, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);

      const ro = wrapperObserver();
      const initialCalls = taskClientMock.list.mock.calls.length;

      ro?.trigger(720); // floor(720/44) = 16 rows
      await settle(fixture);

      const afterFirst = taskClientMock.list.mock.calls.length;

      expect(component.pageSize()).toBe(16);
      expect(afterFirst).toBeGreaterThan(initialCalls);

      const lastQuery = taskClientMock.list.mock.calls[afterFirst - 1]?.[1];

      expect(lastQuery).toEqual(expect.objectContaining({ limit: 16 }));

      ro?.trigger(730); // still 16 rows → no refetch
      await settle(fixture);
      expect(taskClientMock.list.mock.calls.length).toBe(afterFirst);

      ro?.trigger(2000); // floor(2000/45) = 44 rows (incl. the 1px row-border pitch) → one refetch
      await settle(fixture);

      expect(component.pageSize()).toBe(44);
      expect(taskClientMock.list.mock.calls.length).toBe(afterFirst + 1);
    });

    it('should fill the page at common viewport heights (900px / 700px mocked chrome-adjusted wrappers)', async () => {
      await setup({}, AUTO_PAGE_SIZE_SENTINEL);

      const ro = wrapperObserver();

      // 900px viewport − header/paddings chrome ≈ 788px of table wrapper
      ro?.trigger(788);
      await settle(fixture);
      expect(component.pageSize()).toBe(16); // floor(788/48)

      // 700px viewport ≈ 588px of table wrapper
      ro?.trigger(588);
      await settle(fixture);
      expect(component.pageSize()).toBe(12); // floor(588/48)
    });

    it('should fit MORE rows using the MEASURED row height than the 48px fallback', async () => {
      await setup({}, AUTO_PAGE_SIZE_SENTINEL);
      // tasks is now a resource-backed computed — seed the resource value instead
      component.tasksResource.value.set({
        data: [{ id: 't1' } as never],
        pagination: { page: 1, limit: 30, total: 1, totalPages: 1 },
      });
      await settle(fixture);

      // Real rows are ~44px tall vs the 48px fallback constant
      const row: HTMLElement = fixture.nativeElement.querySelector('tbody tr:not([aria-hidden="true"])');

      expect(row).toBeTruthy();
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);

      const ro = wrapperObserver();

      ro?.trigger(720); // floor(720/48) = 15 with the fallback, floor(720/44) = 16 measured
      await settle(fixture);

      expect(component.pageSize()).toBe(16);
    });

    it('should persist the Auto sentinel and omit limit from the URL when selected', async () => {
      await setup();

      const setPageSize = TestBed.inject(PreferencesStore).setPageSize as ReturnType<typeof vi.fn>;

      component.onAutoPageSize();

      expect(setPageSize).toHaveBeenCalledWith(AUTO_PAGE_SIZE_SENTINEL);
      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { limit: null, page: null }, queryParamsHandling: 'merge' }),
      );
    });

    it('should persist numeric sizes with the URL limit param', async () => {
      await setup();

      const setPageSize = TestBed.inject(PreferencesStore).setPageSize as ReturnType<typeof vi.fn>;

      component.onPageSizeChange(50);

      expect(setPageSize).toHaveBeenCalledWith(50);
      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { limit: 50, page: null }, queryParamsHandling: 'merge' }),
      );
    });
  });

  // ── Status display names + label chip padding ─

  describe('status names & label padding (DR-1/DR-4)', () => {
    beforeEach(() => setup());

    async function renderOneTask(): Promise<ComponentFixture<TaskTable>> {
      taskClientMock.list.mockReturnValue(
        of({
          data: [
            {
              id: 't1',
              number: 1,
              title: 'Task A',
              priorityLevel: 2,
              typeId: 'type1',
              statusId: 'st1',
              labelIds: ['l1'],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: { total: 1, page: 1, limit: 30, totalPages: 1 },
        }),
      );

      const fx = TestBed.createComponent(TaskTable);

      fx.componentRef.setInput('projectKey', 'ABC');
      await settle(fx);

      return fx;
    }

    it('should render the status badge with the human display name, not the raw id', async () => {
      const fx = await renderOneTask();
      // First td is the selection checkbox — Status is the fifth cell
      const statusCell: HTMLElement = fx.nativeElement.querySelector('tbody tr td:nth-child(5)');

      expect(statusCell.textContent?.trim()).toBe('To Do');

      // Native `[title]` replaced by the HlmTooltip directive on the cell
      const statusCellTooltip = fx.debugElement
        .queryAll(By.directive(HlmTooltip))
        .find((d) => d.nativeElement === statusCell);

      expect(statusCellTooltip).toBeTruthy();
    });

    it('should expose named status options to the column filter select', async () => {
      await renderOneTask();

      const statusColumn = component.taskColumns.find((c: { field: string }) => c.field === 'statusId');
      const options: { id: string; name: string }[] = statusColumn.getOptions();

      expect(options).toEqual([{ id: 'st1', name: 'To Do' }]);
      expect(statusColumn.itemToString('st1')).toBe('To Do');
    });

    it('should pad the labels cell so chips do not crowd the right edge (DR-4)', async () => {
      const fx = await renderOneTask();
      // Q10 adds a leading selection cell: 1 ✓, 2 Key, 3 Title, 4 Type, 5 Status,
      // 6 Priority, 7 Assignee, 8 Reporter, 9 Sprint, 10 Labels
      const labelsCell: HTMLElement = fx.nativeElement.querySelector('tbody tr td:nth-child(10)');

      expect(labelsCell.classList.contains('pr-4')).toBe(true);
    });
  });

  // ── V1-3: NaN guard + stale-list refresh ───────────────

  describe('limit NaN guard (V1-3)', () => {
    it('should map garbage numeric params to the fallback instead of NaN', () => {
      expect(safeNumericParam('abc')).toBe(0);
      expect(safeNumericParam('')).toBe(0);
      expect(safeNumericParam(null)).toBe(0);
      expect(safeNumericParam('25')).toBe(25);
    });

    it('should fall back to the stored preference when the URL limit is not a number', async () => {
      await setup({ limit: 'abc' }, 30);

      expect(Number.isNaN(component.pageSize())).toBe(false);
      expect(component.pageSize()).toBe(30);
    });

    it('should never write a non-finite page size to the URL', async () => {
      await setup();
      component.onPageSizeChange(Number.NaN);

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('should refetch when a navigation completes after mount (stale list fix)', async () => {
      await setup();

      const callsAfterMount = taskClientMock.list.mock.calls.length;

      // First NavigationEnd belongs to this mount — skipped…
      routerEvents.next(new NavigationEnd(1, '/tasks', '/tasks'));

      await new Promise((r) => setTimeout(r, 0));

      expect(taskClientMock.list.mock.calls.length).toBe(callsAfterMount);

      // …any later one (e.g. browser-back from tasks/new) triggers a refresh.
      routerEvents.next(new NavigationEnd(2, '/tasks', '/tasks'));

      await new Promise((r) => setTimeout(r, 0));

      expect(taskClientMock.list.mock.calls.length).toBe(callsAfterMount + 1);
    });
  });

  // ── V2-10: role-gated New Task control ─────────────────

  describe('role-gated write controls (V2-10)', () => {
    it('should hide the New Task control from VIEWER-role users', async () => {
      await setup({}, 30, null, 'VIEWER');

      expect(component.canCreateTasks()).toBe(false);

      await settle(fixture);

      // Transloco test module has no dictionaries — the raw key would render if ungated
      expect(fixture.nativeElement.textContent).not.toContain('taskTable.newTask');
    });

    it('should show the New Task control to EDITOR-role users', async () => {
      await setup({}, 30, null, 'EDITOR');

      expect(component.canCreateTasks()).toBe(true);
    });
  });

  // ── Column chooser ─────────────────────────────────────

  describe('column chooser (R3-P4)', () => {
    function storeMocks() {
      return TestBed.inject(PreferencesStore) as unknown as {
        setTaskTableColumns: ReturnType<typeof vi.fn>;
        getTaskTableColumns: ReturnType<typeof vi.fn>;
      };
    }

    it('should render all 11 columns when the persisted preference is null (default set)', async () => {
      await setup();

      const headers = fixture.nativeElement.querySelectorAll('thead th');

      // 11 data columns + the selection checkbox column (writer role)
      expect(headers).toHaveLength(12);
      expect(component.visibleColumnCount()).toBe(11);
    });

    it('should remove hidden columns from the DOM when a preference is stored', async () => {
      await setup({}, 30, 'OWNER', null, ['key', 'title', 'priority']);

      await settle(fixture);

      const headers = Array.from(fixture.nativeElement.querySelectorAll('thead th')) as HTMLElement[];
      const headerText = headers.map((h) => h.textContent ?? '').join('|');

      // 3 visible data columns + the selection checkbox column
      expect(headers).toHaveLength(4);
      expect(headerText).toContain('taskTable.key');
      expect(headerText).toContain('taskTable.titleCol');
      expect(headerText).toContain('taskTable.priority');
      expect(headerText).not.toContain('taskTable.type');

      // colspan of the empty-state row follows the visible count
      expect(component.visibleColumnCount()).toBe(3);
    });

    it('should always keep the pinned Key/Title columns even if missing from the preference', async () => {
      await setup({}, 30, 'OWNER', null, ['status']);

      await settle(fixture);

      const headers = Array.from(fixture.nativeElement.querySelectorAll('thead th')) as HTMLElement[];
      const headerText = headers.map((h) => h.textContent ?? '').join('|');

      expect(headerText).toContain('taskTable.key');
      expect(headerText).toContain('taskTable.titleCol');
      expect(headerText).toContain('taskTable.status');
      // 3 visible data columns (pinned Key/Title + status) + the checkbox column
      expect(headers).toHaveLength(4);
    });

    it('should apply a toggle immediately and persist the canonical payload after ~400 ms', async () => {
      await setup();
      vi.useFakeTimers();

      component.toggleColumn('type', false);

      // Applied immediately…
      expect(component.visibleFields().has('typeId')).toBe(false);

      // …but not yet persisted
      const { setTaskTableColumns } = storeMocks();

      expect(setTaskTableColumns).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);

      // Persisted in canonical column order, without `type`
      expect(setTaskTableColumns).toHaveBeenCalledWith('p1', [
        'key',
        'title',
        'status',
        'priority',
        'assignee',
        'reporter',
        'sprint',
        'labels',
        'created',
        'updated',
      ]);

      vi.useRealTimers();
    });

    it('should coalesce rapid toggles into one debounced persist call', async () => {
      await setup();
      vi.useFakeTimers();

      component.toggleColumn('type', false);
      vi.advanceTimersByTime(200);
      component.toggleColumn('type', true);
      vi.advanceTimersByTime(400);

      const { setTaskTableColumns } = storeMocks();
      const calls = setTaskTableColumns.mock.calls as unknown[];

      expect(calls).toHaveLength(1);
      // Re-showing restores the full default set
      expect(setTaskTableColumns).toHaveBeenCalledWith('p1', [
        'key',
        'title',
        'type',
        'status',
        'priority',
        'assignee',
        'reporter',
        'sprint',
        'labels',
        'created',
        'updated',
      ]);

      vi.useRealTimers();
    });

    it('must not hide the pinned Key/Title columns', async () => {
      await setup();
      vi.useFakeTimers();

      component.toggleColumn('key', false);
      component.toggleColumn('title', false);

      expect(component.visibleFields().has('number')).toBe(true);
      expect(component.visibleFields().has('title')).toBe(true);

      vi.advanceTimersByTime(400);

      const { setTaskTableColumns } = storeMocks();

      expect(setTaskTableColumns).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should hide the context-targeted column via "Hide this column"', async () => {
      await setup();
      vi.useFakeTimers();

      const typeColumn = component.taskColumns.find((c: { field: string }) => c.field === 'typeId');

      component.contextColumn.set(typeColumn);
      component.hideContextColumn();

      expect(component.visibleFields().has('typeId')).toBe(false);

      vi.advanceTimersByTime(400);

      const { setTaskTableColumns } = storeMocks();

      expect(setTaskTableColumns).toHaveBeenCalledWith('p1', expect.not.arrayContaining(['type']));

      vi.useRealTimers();
    });

    it('should disable "Hide this column" for pinned columns', async () => {
      await setup();

      const keyColumn = component.taskColumns.find((c: { field: string }) => c.field === 'number');

      component.contextColumn.set(keyColumn);

      expect(component.canHideContextColumn()).toBe(false);
    });

    it('should open the cursor-anchored chooser from the context menu action', async () => {
      await setup();

      expect(component.showContextColumnChooser()).toBe(false);

      component.openChooserFromContextMenu();

      // The context menu opens the CURSOR-anchored instance…
      expect(component.showContextColumnChooser()).toBe(true);
      // …and never the toolbar one
      expect(component.showColumnChooser()).toBe(false);
    });

    it('should keep only one chooser instance open at a time', async () => {
      await setup();

      // Opening the cursor instance (context-menu path) closes the toolbar instance
      component.showColumnChooser.set(true);
      component.openChooserFromContextMenu();

      expect(component.showColumnChooser()).toBe(false);
      expect(component.showContextColumnChooser()).toBe(true);

      // …and a toolbar-side open closes the cursor instance
      component.onChooserStateChange('open');

      expect(component.showContextColumnChooser()).toBe(false);
    });

    it('should render a dialog-style header with a close button that closes the open instance', async () => {
      await setup();

      component.showColumnChooser.set(true);
      await settle(fixture);

      // The chooser content renders into the CDK overlay (document.body)
      const closeBtn = document.body.querySelector('[data-column-chooser-close]');

      expect(closeBtn).not.toBeNull();

      component.closeColumnChooser();

      expect(component.showColumnChooser()).toBe(false);
      expect(component.showContextColumnChooser()).toBe(false);
    });

    // P13b (Fix 3a): the toolbar popover is opened by CLICKING its trigger —
    // the overlay's internal state goes 'open' while the `[state]` binding
    // signal stayed false, so the × button's set(false) was a no-op. The
    // stateChanged handler must mirror 'open' into the signal.
    it('should sync showColumnChooser when the toolbar instance reports open (× regression)', async () => {
      await setup();

      expect(component.showColumnChooser()).toBe(false);

      component.onChooserStateChange('open');

      expect(component.showColumnChooser()).toBe(true);

      component.closeColumnChooser();

      expect(component.showColumnChooser()).toBe(false);
    });

    it('should sync showContextColumnChooser when the cursor instance reports open', async () => {
      await setup();

      component.onContextChooserStateChange('open');

      expect(component.showContextColumnChooser()).toBe(true);
      expect(component.showColumnChooser()).toBe(false);

      component.closeColumnChooser();

      expect(component.showContextColumnChooser()).toBe(false);
    });

    // P13b (Fix 3c): autoFocus picks the FIRST tabbable element — the × header
    // row must therefore come LAST in DOM (order-first keeps it visually on
    // top) so focus lands on the Select-all checkbox, not the × (whose focus
    // tooltip used to hang over the button).
    it('should render the select-all checkbox before the × button in DOM order', async () => {
      await setup();

      component.showColumnChooser.set(true);
      await settle(fixture);

      const closeBtn = document.body.querySelector('[data-column-chooser-close]');

      expect(closeBtn).not.toBeNull();

      // closeBtn lives in the header row; the row's parent is the popover root
      const headerRow = closeBtn?.parentElement;
      const content = headerRow?.parentElement;

      expect(headerRow).not.toBeNull();
      expect(content).not.toBeNull();

      const anyCheckbox = content?.querySelector('hlm-checkbox, brn-checkbox, [role="checkbox"]');

      expect(anyCheckbox).not.toBeNull();

      // The header row is the LAST child in DOM (order-first keeps it on top)
      expect(headerRow?.nextElementSibling).toBeNull();
      expect(headerRow?.classList.contains('order-first')).toBe(true);
      // …and the checkbox list is the FIRST child, so autoFocus (first tabbable)
      // lands on the Select-all checkbox, not the × button.
      expect(content?.firstElementChild).not.toBe(headerRow);
      expect(content?.firstElementChild?.contains(anyCheckbox as Node)).toBe(true);
    });

    it('should toggle all non-pinned columns with Select all and persist once', async () => {
      await setup();
      vi.useFakeTimers();

      // Hide all — pinned Key/Title must survive
      component.toggleAllColumns(false);

      expect(component.visibleFields().has('typeId')).toBe(false);
      expect(component.visibleFields().has('number')).toBe(true);
      expect(component.visibleFields().has('title')).toBe(true);
      expect(component.allColumnsSelected()).toBe(false);
      expect(component.someColumnsSelected()).toBe(false);

      vi.advanceTimersByTime(400);

      const { setTaskTableColumns } = storeMocks();

      expect(setTaskTableColumns).toHaveBeenCalledWith('p1', ['key', 'title']);

      // Show all — the full canonical set comes back
      component.toggleAllColumns(true);

      expect(component.allColumnsSelected()).toBe(true);
      expect(component.someColumnsSelected()).toBe(false);

      vi.advanceTimersByTime(400);

      expect(setTaskTableColumns).toHaveBeenLastCalledWith('p1', [
        'key',
        'title',
        'type',
        'status',
        'priority',
        'assignee',
        'reporter',
        'sprint',
        'labels',
        'created',
        'updated',
      ]);

      vi.useRealTimers();
    });

    it('should report indeterminate while only some non-pinned columns are visible', async () => {
      await setup();

      component.toggleColumn('type', false);

      expect(component.someColumnsSelected()).toBe(true);
      expect(component.allColumnsSelected()).toBe(false);
    });
  });

  // ── Multi-select + bulk actions ─────────────────────────

  describe('bulk actions', () => {
    function makeTask(id: string) {
      return {
        id,
        projectId: 'p1',
        number: id === 't1' ? 1 : 2,
        typeId: 'ty1',
        title: `Task ${id}`,
        description: null,
        statusId: 'st1',
        priorityLevel: 0,
        reporterId: null,
        reporterSnapshot: null,
        assigneeId: null,
        assigneeSnapshot: null,
        sprintId: null,
        labelIds: [],
        createdById: 'u1',
        createdBySnapshot: { displayName: 'User One' },
        version: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
    }

    async function setupWithTasks(tenantRole: string | null = 'OWNER', projectRole: string | null = null) {
      await setup({}, 30, tenantRole, projectRole);
      // tasks is now a resource-backed computed — seed the resource value instead
      component.tasksResource.value.set({
        data: [makeTask('t1'), makeTask('t2')],
        pagination: { page: 1, limit: 30, total: 2, totalPages: 1 },
      });
      await settle(fixture);
    }

    it('should toggle individual row selection', async () => {
      await setupWithTasks();

      component.toggleRowSelection('t1', true);

      expect(component.selectedIds().has('t1')).toBe(true);
      expect(component.selectedCount()).toBe(1);
      expect(component.allSelected()).toBe(false);

      component.toggleRowSelection('t2', true);

      expect(component.allSelected()).toBe(true);

      component.toggleRowSelection('t1', false);

      expect(component.allSelected()).toBe(false);
    });

    it('should select all loaded tasks with select-all and clear with clearSelection', async () => {
      await setupWithTasks();

      component.toggleSelectAll(true);

      expect(component.selectedCount()).toBe(2);
      expect(component.allSelected()).toBe(true);

      component.clearSelection();

      expect(component.selectedCount()).toBe(0);
      expect(component.allSelected()).toBe(false);
    });

    it('should enforce exactly-one-field by clearing other bulk fields', async () => {
      await setupWithTasks();

      component.onBulkStatusChange('st1');
      component.onBulkAssigneeChange('u9');

      expect(component.bulkStatus()).toBe('');
      expect(component.bulkAssignee()).toBe('u9');
      expect(component.canApplyBulk()).toBe(true);

      component.onBulkSprintChange('s1');

      expect(component.bulkAssignee()).toBe('');
      expect(component.bulkSprint()).toBe('s1');
      expect(component.canApplyBulk()).toBe(true);
    });

    it('should not allow apply when no bulk field is chosen', async () => {
      await setupWithTasks();

      expect(component.canApplyBulk()).toBe(false);
    });

    it('should send a single-field payload and clear the selection on success', async () => {
      await setupWithTasks();
      taskClientMock['bulkUpdate'] = vi.fn().mockReturnValue(of({ updated: 2 }));

      component.toggleRowSelection('t1', true);
      component.toggleRowSelection('t2', true);
      component.onBulkStatusChange('st1');
      component.applyBulkUpdate();

      expect(taskClientMock['bulkUpdate']).toHaveBeenCalledWith('p1', {
        taskIds: ['t1', 't2'],
        data: { statusId: 'st1' },
      });
      expect(component.selectedCount()).toBe(0);
      expect(component.bulkStatus()).toBe('');
    });

    it('should map the unassigned sentinel to a null assigneeId', async () => {
      await setupWithTasks();
      taskClientMock['bulkUpdate'] = vi.fn().mockReturnValue(of({ updated: 1 }));

      component.toggleRowSelection('t1', true);
      component.onBulkAssigneeChange('__unassigned__');
      component.applyBulkUpdate();

      expect(taskClientMock['bulkUpdate']).toHaveBeenCalledWith('p1', {
        taskIds: ['t1'],
        data: { assigneeId: null },
      });
    });

    it('should do nothing when apply is triggered without a valid field or selection', async () => {
      await setupWithTasks();
      taskClientMock['bulkUpdate'] = vi.fn();

      component.applyBulkUpdate();

      expect(taskClientMock['bulkUpdate']).not.toHaveBeenCalled();
    });

    it('should hide checkboxes and the bulk bar from users who cannot write', async () => {
      await setupWithTasks(null, 'VIEWER');

      expect(component.canCreateTasks()).toBe(false);

      const checkboxes = fixture.nativeElement.querySelectorAll('hlm-checkbox');

      expect(checkboxes.length).toBe(0);
    });

    // ── P8-12: checkbox regression ──────────────────────────
    // Clicking a row checkbox renders the bulk bar, which shrinks the table
    // wrapper; in Auto page-size mode the ResizeObserver then recomputes the
    // page size and the fetch effect refetches with a new `limit`. That
    // limit-only refetch used to clear the fresh selection, so the checkmark
    // appeared for an instant and unset itself.

    /** Poll until the list client has been called at least `count` times (no fixed timeouts) */
    async function waitForListCalls(count: number): Promise<void> {
      for (let i = 0; i < 100 && taskClientMock.list.mock.calls.length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(taskClientMock.list.mock.calls.length).toBeGreaterThanOrEqual(count);
    }

    it('should KEEP the selection when a limit-only refetch completes (P8-12)', async () => {
      await setupWithTasks();
      component.toggleRowSelection('t1', true);

      expect(component.selectedCount()).toBe(1);

      const callsBefore = taskClientMock.list.mock.calls.length;

      // Auto page-size re-measure → only `limit` changes, scope is identical
      fixture.componentRef.setInput('limit', 10);
      await settle(fixture);
      await waitForListCalls(callsBefore + 1);

      expect(component.selectedIds().has('t1')).toBe(true);
      expect(component.selectedCount()).toBe(1);
    });

    it('should CLEAR the selection when the query scope changes (filter change)', async () => {
      await setupWithTasks();
      component.toggleRowSelection('t1', true);

      const callsBefore = taskClientMock.list.mock.calls.length;

      // Status filter changes WHICH tasks are listed → page-scoped selection resets
      fixture.componentRef.setInput('status', 'To Do');
      await settle(fixture);
      await waitForListCalls(callsBefore + 1);

      expect(component.selectedCount()).toBe(0);
    });
  });

  // ── Saved-view date-range params ───────────────────────

  describe('saved-view date-range params (Q12)', () => {
    beforeEach(() => setup());

    it('should write the four date params when applying criteria with dates', () => {
      component.onFilterApplied({
        filters: {
          search: 'x',
          createdFrom: '2026-01-01',
          createdTo: '2026-01-31',
          updatedFrom: '2026-02-01',
          updatedTo: '2026-02-28',
        },
        sort: { field: 'createdAt', direction: 'desc' },
      });

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: expect.objectContaining({
            createdFrom: '2026-01-01',
            createdTo: '2026-01-31',
            updatedFrom: '2026-02-01',
            updatedTo: '2026-02-28',
            page: null,
          }),
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should clear the date params when applying criteria without dates', () => {
      component.onFilterApplied({ filters: {}, sort: { field: 'createdAt', direction: 'desc' } });

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: expect.objectContaining({
            createdFrom: null,
            createdTo: null,
            updatedFrom: null,
            updatedTo: null,
          }),
        }),
      );
    });

    it('should capture URL date params into currentFilters for saved views', async () => {
      fixture.componentRef.setInput('createdFrom', '2026-01-01');
      fixture.componentRef.setInput('updatedTo', '2026-03-31');
      await settle(fixture);

      expect(component.currentFilters()).toEqual(
        expect.objectContaining({ createdFrom: '2026-01-01', updatedTo: '2026-03-31' }),
      );
    });
  });

  // ── Round 4: date-filter mode handling ─────────────────

  describe('date-filter mode handling (round 4)', () => {
    beforeEach(() => setup());

    function col(field: string) {
      return component.taskColumns.find((c: { field: string }) => c.field === field);
    }

    it('should return the translated label from dateModeToString (F1)', () => {
      const translate = vi.spyOn(TestBed.inject(TranslocoService), 'translate').mockReturnValue('Between');

      expect(component.dateModeToString('between')).toBe('Between');
      expect(translate).toHaveBeenCalledWith('taskTable.dateMode.between');
    });

    // ── Localized trigger formatting ────────────────────────────────────────

    it('should format the picker trigger via DatePipe with the store format + locale (no weekday)', () => {
      // Mocked store: language 'en', datePipeFormat 'yyyy-MM-dd' → plain ISO, no weekday
      const formatted = component.dateFilterTriggerFormat(new Date(2026, 7, 27));

      expect(formatted).toBe('2026-08-27');
    });

    it('should not write any DATE params when picking between with no existing bounds (F2)', () => {
      component.onDateModeChange(col('createdAt'), 'between');

      // Clearing to empty bounds is allowed — inventing today's date is not
      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { createdFrom: null, createdTo: null },
          queryParamsHandling: 'merge',
        }),
      );
      // The UI-mode override keeps 'between' selected even without dates
      expect(component.dateMode(col('createdAt'))).toBe('between');
    });

    it("should never invent today's date in any mode with no existing bounds (F2)", () => {
      component.onDateModeChange(col('createdAt'), 'on');
      component.onDateModeChange(col('createdAt'), 'before');
      component.onDateModeChange(col('createdAt'), 'after');

      const calls = routerMock.navigate.mock.calls as [unknown[], { queryParams: Record<string, string | null> }][];

      expect(calls.length).toBeGreaterThan(0);

      for (const [, { queryParams }] of calls) {
        for (const key of ['createdFrom', 'createdTo']) {
          const value = queryParams[key];

          expect(value === null || value === undefined || value === '').toBe(true);
        }
      }
    });

    it('should keep an existing from bound and clear to when switching to between (F2)', async () => {
      fixture.componentRef.setInput('createdFrom', '2026-01-01');
      await settle(fixture);

      component.onDateModeChange(col('createdAt'), 'between');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { createdFrom: '2026-01-01', createdTo: null },
          queryParamsHandling: 'merge',
        }),
      );
    });

    it('should collapse both bounds to a single day when switching to on (F2)', async () => {
      fixture.componentRef.setInput('createdFrom', '2026-01-01');
      fixture.componentRef.setInput('createdTo', '2026-01-31');
      await settle(fixture);

      component.onDateModeChange(col('createdAt'), 'on');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { createdFrom: '2026-01-01', createdTo: '2026-01-01' },
          queryParamsHandling: 'merge',
        }),
      );
    });

    it('should clear the override and bounds when switching to none (F2)', () => {
      component.onDateModeChange(col('createdAt'), 'between');
      component.onDateModeChange(col('createdAt'), 'none');

      expect(component.dateMode(col('createdAt'))).toBe('none');
      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { createdFrom: null, createdTo: null },
          queryParamsHandling: 'merge',
        }),
      );
    });

    it('should drop the override via removeFilter so derived mode takes over again (F2)', () => {
      component.onDateModeChange(col('createdAt'), 'between');
      component.removeFilter('createdFrom');

      expect(component.dateMode(col('createdAt'))).toBe('none');
    });

    it('should drop all overrides via clearFilters (F2)', () => {
      component.onDateModeChange(col('createdAt'), 'between');
      component.onDateModeChange(col('updatedAt'), 'after');
      component.clearFilters();

      expect(component.dateMode(col('createdAt'))).toBe('none');
      expect(component.dateMode(col('updatedAt'))).toBe('none');
    });

    it('should align the Created/Updated filter popovers end so they open leftward (F3)', () => {
      expect(col('createdAt').align).toBe('end');
      expect(col('updatedAt').align).toBe('end');
      // Non-date columns keep the default center alignment
      expect(col('statusId').align).toBeUndefined();
    });

    it('should swallow exactly one terminating click after opening the context menu (F4)', () => {
      let reachedBody = false;
      const bodyListener = (): void => {
        reachedBody = true;
      };
      const target = document.createElement('div');

      document.body.addEventListener('click', bodyListener);
      document.body.appendChild(target);

      try {
        component.swallowNextClick();

        // First click after open — swallowed in capture phase before CDK's body listener
        target.click();
        expect(reachedBody).toBe(false);

        // One-shot only: later clicks (e.g. selecting a menu item) pass through
        target.click();
        expect(reachedBody).toBe(true);
      } finally {
        document.body.removeEventListener('click', bodyListener);
        target.remove();
      }
    });
  });

  // ── The caller half of the toast contract ────────────────────────────────
  //
  // `error-toast-count.spec.ts` asserts the global half: the interceptor toasts
  // a 5xx or a network failure exactly once, and never a 4xx. This block asserts
  // the caller half on the component that had the defect: the local toast covers
  // the 4xx the global layer leaves alone, and NOTHING else. Together: exactly
  // one toast per failure. The spec runs WITHOUT the interceptor installed, so
  // every toast counted here is the component's own.
  describe('list-load failure toasts (D-41)', () => {
    beforeEach(() => setup());

    /** Make the (mocked) task list fail with `status` and settle the resource. */
    async function failListWith(status: number): Promise<void> {
      taskClientMock.list.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status,
              statusText: 'Failed',
              error: { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            }),
        ),
      );
      component.reloadTick.update((tick: number) => tick + 1);
      await settle(fixture);
    }

    it('should not toast a 5xx list failure locally — the global interceptor owns it', async () => {
      await failListWith(500);

      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('should not toast a network failure locally — the global interceptor owns it', async () => {
      await failListWith(0);

      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('should toast a 4xx list failure locally — the caller owns it', async () => {
      await failListWith(403);

      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
  });
});
