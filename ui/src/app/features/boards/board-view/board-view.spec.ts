/**
 * Tests for the BoardView component (cursor pagination + infinite scroll + DnD).
 *
 * Covers:
 * - Initial loading state
 * - Board / initial column pages fetching on init (one HTTP request, no cursors)
 * - Per-column pagination: append, dedupe, batching, guards, stale generations
 * - Drag-and-drop optimistic reconciliation (no refetch, cursor/hasMore stable)
 * - goToTask / goToNewTask navigation, sprint selector, filters,
 *   status display names, loaded-count headers, empty columns
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, ActivatedRoute } from '@angular/router';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { BoardView } from './board-view';
import { BoardClient } from '@services/board-client';
import { TaskClient } from '@services/task-client';
import { SprintClient } from '@services/sprint-client';
import { StatusClient } from '@services/status-client';
import { ProjectClient } from '@services/project-client';
import { ProjectStore } from '@stores/project-store';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { BoardColumn, BoardConfig, BoardPage, BoardTask } from '@task-board/shared';
import { encodeBoardCursor } from '@task-board/shared';
import { clickUntil, settle } from '@app/shared/testing/zoneless';

// ── Test fixtures ───────────────────────────────────────────

const NOW = new Date().toISOString();
const mockBoard: BoardConfig = {
  projectId: 'p0000000-0000-0000-0000-000000000001',
  // A board carries a version, exactly as a task does.
  version: 1,
  columns: [
    { id: 'col1', statusIds: ['s1', 's2'], position: 0 },
    { id: 'col2', statusIds: ['s3'], position: 1 },
    { id: 'col3', statusIds: ['s4'], position: 2 },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

function makeCard(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'tk000000-0000-0000-0000-000000000001',
    number: 1,
    typeId: 'type1',
    title: 'Test Task',
    statusId: 's1',
    priorityLevel: 1,
    assigneeId: null,
    assigneeSnapshot: null,
    version: 1,
    ...overrides,
  };
}

function defaultPages(): BoardPage {
  return {
    col1: {
      tasks: [
        makeCard({ id: 'tk000000-0000-0000-0000-000000000001', statusId: 's1', title: 'Task A', number: 1 }),
        makeCard({ id: 'tk000000-0000-0000-0000-000000000002', statusId: 's1', title: 'Task B', number: 2 }),
      ],
      nextCursor: null,
      hasMore: false,
    },
    col2: {
      tasks: [makeCard({ id: 'tk000000-0000-0000-0000-000000000003', statusId: 's3', title: 'Task C', number: 3 })],
      nextCursor: null,
      hasMore: false,
    },
    col3: { tasks: [], nextCursor: null, hasMore: false },
  };
}

const mockSprints = [
  {
    id: 'sp1',
    projectId: 'p0000000-0000-0000-0000-000000000001',
    name: 'Sprint 1',
    status: 'ACTIVE',
    startDate: NOW,
    endDate: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'sp2',
    projectId: 'p0000000-0000-0000-0000-000000000001',
    name: 'Sprint 2',
    status: 'FUTURE',
    startDate: NOW,
    endDate: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

// ── Mock factories ──────────────────────────────────────────

function createBoardClientMock(board: BoardConfig = mockBoard) {
  return {
    getForProject: vi.fn().mockReturnValue(of(board)),
  };
}

function createTaskClientMock(pages: BoardPage = defaultPages()) {
  return {
    listBoardPages: vi.fn().mockReturnValue(of(pages)),
    update: vi
      .fn()
      .mockImplementation((id: string, data: { statusId: string; version: number }) =>
        of(makeCard({ id, statusId: data.statusId, version: data.version + 1 })),
      ),
    getById: vi.fn(),
    create: vi.fn().mockReturnValue(of(makeCard({ id: 'tk000000-0000-0000-0000-000000000099', title: 'New Task' }))),
  };
}

function createSprintClientMock() {
  return {
    list: vi.fn().mockReturnValue(of(mockSprints)),
  };
}

// ── Test suite ──────────────────────────────────────────────

describe('BoardView', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let boardClientMock: ReturnType<typeof createBoardClientMock>;
  let taskClientMock: ReturnType<typeof createTaskClientMock>;
  let sprintClientMock: ReturnType<typeof createSprintClientMock>;
  let routerMock: { navigate: ReturnType<typeof vi.fn> };

  async function setup(
    inputOverrides: Record<string, unknown> = {},
    statuses: { id: string; name: string }[] = [],
    board: BoardConfig = mockBoard,
    pages: BoardPage = defaultPages(),
    authUser: { id: string } | null = null,
  ) {
    boardClientMock = createBoardClientMock(board);
    taskClientMock = createTaskClientMock(pages);
    sprintClientMock = createSprintClientMock();
    routerMock = { navigate: vi.fn().mockResolvedValue(true) };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        {
          provide: AuthStore,
          useValue: {
            isAuthenticated: () => authUser !== null,
            currentUser: () => authUser,
            token: () => null,
            tenantRole: () => null,
          },
        },
        { provide: BoardClient, useValue: boardClientMock },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: SprintClient, useValue: sprintClientMock },
        { provide: StatusClient, useValue: { list: vi.fn().mockReturnValue(of(statuses)) } },
        { provide: ProjectClient, useValue: { listMembers: vi.fn().mockReturnValue(of([])) } },
        { provide: Router, useValue: routerMock },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParams: of({}),
            snapshot: { paramMap: { get: () => 't1' } },
            parent: { queryParams: of({}), snapshot: { paramMap: { get: () => 't1' } }, parent: null },
          },
        },
        {
          provide: ProjectStore,
          useValue: {
            activeProject: () => ({ id: 'p0000000-0000-0000-0000-000000000001' }),
            projectRole: () => null,
            members: () => [],
            loadedMembersFor: () => null,
            loadMembers: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(BoardView);

    // Set required input before detectChanges
    fixture.componentRef.setInput('projectKey', 'proj-key');
    Object.entries(inputOverrides).forEach(([key, value]) => {
      fixture.componentRef.setInput(key, value);
    });

    component = fixture.componentInstance;
    await settle(fixture);

    return fixture;
  }

  /** Poll until `cond()` is true (pages resolve asynchronously via rxResource) */
  async function until(fx: ComponentFixture<unknown>, cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await settle(fx);
    }
  }

  /** Drive a cross-column drop without CDK (the component only reads item/container/column) */
  function drop(task: BoardTask, column: BoardColumn) {
    component.onTaskDrop({ item: { data: task }, previousContainer: { id: 'src' }, container: { id: 'dst' } }, column);
  }

  function columnIds(): string[] {
    return Object.values(component.columnStates())
      .flatMap((state) => (state as { tasks: BoardTask[] }).tasks.map((task) => task.id))
      .sort();
  }

  // ── Loading state ───────────────────────────────────────

  describe('loading state', () => {
    it('should show loading spinner while data is being fetched', async () => {
      boardClientMock = createBoardClientMock();
      taskClientMock = createTaskClientMock();
      sprintClientMock = createSprintClientMock();
      routerMock = { navigate: vi.fn().mockResolvedValue(true) };

      TestBed.configureTestingModule({
        imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          { provide: API_BASE_URL, useValue: 'http://localhost/api' },
          {
            provide: AuthStore,
            useValue: {
              isAuthenticated: () => false,
              currentUser: () => null,
              token: () => null,
              tenantRole: () => null,
            },
          },
          { provide: BoardClient, useValue: boardClientMock },
          { provide: TaskClient, useValue: taskClientMock },
          { provide: SprintClient, useValue: sprintClientMock },
          { provide: StatusClient, useValue: { list: vi.fn().mockReturnValue(of([])) } },
          { provide: Router, useValue: routerMock },
          {
            provide: ActivatedRoute,
            useValue: {
              queryParams: of({}),
              snapshot: { paramMap: { get: () => 't1' } },
              parent: { queryParams: of({}), snapshot: { paramMap: { get: () => 't1' } }, parent: null },
            },
          },
          {
            provide: ProjectStore,
            useValue: {
              activeProject: () => ({ id: 'p0000000-0000-0000-0000-000000000001' }),
              projectRole: () => null,
              members: () => [],
              loadedMembersFor: () => null,
              loadMembers: vi.fn().mockResolvedValue(undefined),
            },
          },
        ],
      });
      await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

      const fixture = TestBed.createComponent(BoardView);

      // Before detectChanges, loading should be true
      component = fixture.componentInstance;
      expect(component.loading()).toBe(true);
    });

    it('should set loading to false after board loads successfully', async () => {
      await setup();

      expect(component.loading()).toBe(false);
    });

    it('should set loading to false when board fetch fails', async () => {
      boardClientMock = createBoardClientMock();
      boardClientMock.getForProject.mockReturnValue(throwError(() => new Error('Network error')));
      taskClientMock = createTaskClientMock();
      sprintClientMock = createSprintClientMock();
      routerMock = { navigate: vi.fn().mockResolvedValue(true) };

      TestBed.configureTestingModule({
        imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          { provide: API_BASE_URL, useValue: 'http://localhost/api' },
          {
            provide: AuthStore,
            useValue: {
              isAuthenticated: () => false,
              currentUser: () => null,
              token: () => null,
              tenantRole: () => null,
            },
          },
          { provide: BoardClient, useValue: boardClientMock },
          { provide: TaskClient, useValue: taskClientMock },
          { provide: SprintClient, useValue: sprintClientMock },
          { provide: StatusClient, useValue: { list: vi.fn().mockReturnValue(of([])) } },
          { provide: Router, useValue: routerMock },
          {
            provide: ActivatedRoute,
            useValue: {
              queryParams: of({}),
              snapshot: { paramMap: { get: () => 't1' } },
              parent: { queryParams: of({}), snapshot: { paramMap: { get: () => 't1' } }, parent: null },
            },
          },
          {
            provide: ProjectStore,
            useValue: {
              activeProject: () => ({ id: 'p0000000-0000-0000-0000-000000000001' }),
              projectRole: () => null,
              members: () => [],
              loadedMembersFor: () => null,
              loadMembers: vi.fn().mockResolvedValue(undefined),
            },
          },
        ],
      });
      await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

      const fixture = TestBed.createComponent(BoardView);

      component = fixture.componentInstance;
      await settle(fixture);

      expect(component.loading()).toBe(false);
    });
  });

  // ── Data fetching on init ──────────────────────────────────────

  describe('initial column pages', () => {
    it('should call boardClient.getForProject with the active project id', async () => {
      await setup();

      expect(boardClientMock.getForProject).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001');
    });

    it('should populate the board signal', async () => {
      await setup();

      expect(component.board()).toEqual(mockBoard);
    });

    it('should fetch the first page of every column in one request without cursors', async () => {
      const fx = await setup();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      expect(taskClientMock.listBoardPages).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001', {});
    });

    it('should populate per-column states from the response', async () => {
      const fx = await setup();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      expect(component.columnStates()['col1'].tasks).toHaveLength(2);
      expect(component.columnStates()['col2'].tasks).toHaveLength(1);
      expect(component.columnStates()['col3'].tasks).toHaveLength(0);
      expect(component.columnStates()['col1'].hasMore).toBe(false);
    });
  });

  // ── Pagination ────────────────────────────────────────────

  describe('column pagination', () => {
    const cursor184 = encodeBoardCursor({ priorityLevel: 2, number: 184 });

    async function setupPaged() {
      const pages: BoardPage = {
        col1: {
          tasks: [makeCard({ id: 't1', statusId: 's1', number: 1, priorityLevel: 2 })],
          nextCursor: cursor184,
          hasMore: true,
        },
        col2: { tasks: [], nextCursor: null, hasMore: false },
        col3: { tasks: [], nextCursor: null, hasMore: false },
      };

      return setup({}, [], mockBoard, pages);
    }

    async function flushTimers(fx: ComponentFixture<unknown>): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle(fx);
    }

    it('should append the next page with the column cursor in a single request', async () => {
      const fx = await setupPaged();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      taskClientMock.listBoardPages.mockReturnValue(
        of({
          col1: {
            tasks: [makeCard({ id: 't2', statusId: 's1', number: 200, priorityLevel: 2 })],
            nextCursor: null,
            hasMore: false,
          },
        }),
      );

      component.requestNextPage('col1');
      await flushTimers(fx);

      expect(taskClientMock.listBoardPages).toHaveBeenCalledTimes(2);
      expect(taskClientMock.listBoardPages).toHaveBeenLastCalledWith('p0000000-0000-0000-0000-000000000001', {
        cursors: { col1: cursor184 },
      });

      const state = component.columnStates()['col1'];

      expect(state.tasks.map((t: BoardTask) => t.id)).toEqual(['t1', 't2']);
      expect(state.hasMore).toBe(false);
      expect(state.nextCursor).toBeNull();
      expect(state.loading).toBe(false);
    });

    it('should batch simultaneously hungry sentinels into one HTTP request', async () => {
      const fx = await setupPaged();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      component.columnStates()['col2'] = { tasks: [], nextCursor: cursor184, hasMore: true, loading: false };
      taskClientMock.listBoardPages.mockReturnValue(of({}));

      component.requestNextPage('col1');
      component.requestNextPage('col2');
      await flushTimers(fx);

      expect(taskClientMock.listBoardPages).toHaveBeenCalledTimes(2);
      expect(taskClientMock.listBoardPages).toHaveBeenLastCalledWith('p0000000-0000-0000-0000-000000000001', {
        cursors: { col1: cursor184, col2: cursor184 },
      });
    });

    it('should never refetch an exhausted column', async () => {
      const fx = await setup();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      const calls = taskClientMock.listBoardPages.mock.calls.length;

      component.requestNextPage('col3');
      await flushTimers(fx);

      expect(taskClientMock.listBoardPages.mock.calls.length).toBe(calls);
      expect(component.sentinelActive('col3')).toBe(false);
    });

    it('should guard against concurrent loads of the same column', async () => {
      const fx = await setupPaged();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      const pending = new Subject<BoardPage>();

      taskClientMock.listBoardPages.mockReturnValue(pending);

      component.requestNextPage('col1');
      await flushTimers(fx);

      const calls = taskClientMock.listBoardPages.mock.calls.length;

      component.requestNextPage('col1');
      await flushTimers(fx);

      expect(taskClientMock.listBoardPages.mock.calls.length).toBe(calls);

      pending.next({ col1: { tasks: [], nextCursor: null, hasMore: false } });
      pending.complete();
      await settle(fx);

      expect(component.columnStates()['col1'].loading).toBe(false);
    });

    it('should dedupe cards that arrive both locally and via pagination', async () => {
      const fx = await setupPaged();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      taskClientMock.listBoardPages.mockReturnValue(
        of({
          col1: {
            tasks: [makeCard({ id: 't1', statusId: 's1', number: 1, priorityLevel: 2 })],
            nextCursor: null,
            hasMore: false,
          },
        }),
      );

      component.requestNextPage('col1');
      await flushTimers(fx);

      expect(component.columnStates()['col1'].tasks.map((t: BoardTask) => t.id)).toEqual(['t1']);
    });

    it('should ignore a stale generation response after a filter change', async () => {
      const fx = await setupPaged();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      const stale = new Subject<BoardPage>();

      taskClientMock.listBoardPages.mockReturnValue(stale);

      component.requestNextPage('col1');
      await flushTimers(fx);

      // Filter change bumps the generation and reloads from scratch.
      taskClientMock.listBoardPages.mockReturnValue(of(defaultPages()));
      fx.componentRef.setInput('priorityLevel', 2);
      await until(fx, () => component.columnStates()['col1']?.tasks.length === 2);

      // The stale page resolves afterwards and must not overwrite fresh state.
      stale.next({
        col1: { tasks: [makeCard({ id: 'stale', statusId: 's1', number: 999 })], nextCursor: null, hasMore: false },
      });
      stale.complete();
      await settle(fx);

      expect(columnIds()).not.toContain('stale');
      expect(component.columnStates()['col1'].tasks).toHaveLength(2);
    });
  });

  // ── Drag-and-drop reconciliation ──────────────────────────

  describe('drag-and-drop', () => {
    const cursor184 = encodeBoardCursor({ priorityLevel: 2, number: 184 });
    const col2 = mockBoard.columns[1] as BoardColumn;

    async function setupDnd() {
      const pages: BoardPage = {
        col1: {
          tasks: [
            makeCard({ id: 'm1', statusId: 's1', number: 100, priorityLevel: 2, title: 'Mover' }),
            makeCard({ id: 'keep', statusId: 's1', number: 50, priorityLevel: 3, title: 'Keeper' }),
          ],
          nextCursor: null,
          hasMore: false,
        },
        col2: {
          tasks: [makeCard({ id: 'b1', statusId: 's3', number: 10, priorityLevel: 3, title: 'Top' })],
          nextCursor: cursor184,
          hasMore: true,
        },
        col3: { tasks: [], nextCursor: null, hasMore: false },
      };
      const fx = await setup({}, [], mockBoard, pages);

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      // Mirror server semantics: a status move preserves sort keys and bumps the version.
      // Snapshot up front — the optimistic removal runs before the mock is called.
      const byId = new Map<string, BoardTask>();

      for (const state of Object.values(component.columnStates())) {
        for (const task of (state as { tasks: BoardTask[] }).tasks) byId.set(task.id, task);
      }

      taskClientMock.update.mockImplementation((id: string, data: { statusId: string; version: number }) => {
        const current = byId.get(id) ?? makeCard({ id });
        const fresh = { ...current, statusId: data.statusId, version: data.version + 1 };

        byId.set(id, fresh);

        return of(fresh);
      });

      return fx;
    }

    function mover(): BoardTask {
      return component.columnStates()['col1'].tasks.find((t: BoardTask) => t.id === 'm1');
    }

    it('should insert a card inside the loaded target range without touching cursor/hasMore', async () => {
      await setupDnd();

      const before = { ...component.columnStates()['col2'], tasks: 'stripped' };

      drop(mover(), col2);

      const target = component.columnStates()['col2'];

      // (2,100) sorts before the (2,184) cursor — inside the loaded prefix.
      expect(target.tasks.map((t: BoardTask) => t.id)).toEqual(['b1', 'm1']);
      expect(component.columnStates()['col1'].tasks.map((t: BoardTask) => t.id)).toEqual(['keep']);
      expect(target.nextCursor).toBe(before.nextCursor);
      expect(target.hasMore).toBe(before.hasMore);
      // Server-returned card (fresh version) replaces the local object.
      expect(target.tasks.find((t: BoardTask) => t.id === 'm1')?.version).toBe(2);
      expect('projectId' in (target.tasks.find((t: BoardTask) => t.id === 'm1') ?? {})).toBe(false);
      expect(target.tasks.find((t: BoardTask) => t.id === 'm1')?.statusId).toBe('s3');
    });

    it('should leave a card behind the target cursor for load-more', async () => {
      await setupDnd();

      // (1,5) sorts after the (2,184) cursor — beyond the loaded prefix.
      component.columnStates()['col1'].tasks.find((t: BoardTask) => t.id === 'm1').priorityLevel = 1;
      component.columnStates()['col1'].tasks.find((t: BoardTask) => t.id === 'm1').number = 5;

      drop(mover(), col2);

      expect(component.columnStates()['col2'].tasks.map((t: BoardTask) => t.id)).toEqual(['b1']);
      expect(component.columnStates()['col1'].tasks.map((t: BoardTask) => t.id)).toEqual(['keep']);
    });

    it('should always insert into an exhausted target column', async () => {
      await setupDnd();

      component.columnStates()['col2'] = { ...component.columnStates()['col2'], hasMore: false };

      // Beyond-cursor card, but the server set is terminal — insert anyway.
      component.columnStates()['col1'].tasks.find((t: BoardTask) => t.id === 'm1').priorityLevel = 1;
      component.columnStates()['col1'].tasks.find((t: BoardTask) => t.id === 'm1').number = 5;

      drop(mover(), col2);

      expect(component.columnStates()['col2'].tasks.map((t: BoardTask) => t.id)).toContain('m1');
      expect(component.columnStates()['col2'].hasMore).toBe(false);
    });

    it('should shrink the source without an automatic refill fetch', async () => {
      await setupDnd();

      const calls = taskClientMock.listBoardPages.mock.calls.length;

      drop(mover(), col2);

      expect(component.columnStates()['col1'].tasks).toHaveLength(1);
      expect(taskClientMock.listBoardPages.mock.calls.length).toBe(calls);
    });

    it('should grow the target past the page size without tail truncation', async () => {
      await setupDnd();

      component.columnStates()['col2'] = {
        tasks: Array.from({ length: 50 }, (_, i) =>
          makeCard({ id: `b-${i}`, statusId: 's3', number: 200 + i, priorityLevel: 1 }),
        ),
        nextCursor: cursor184,
        hasMore: true,
        loading: false,
      };

      drop(mover(), col2);

      // (2,100) sorts before every (1,N) card — inserted, nothing evicted.
      expect(component.columnStates()['col2'].tasks).toHaveLength(51);
      expect(component.columnStates()['col2'].tasks[0]?.id).toBe('m1');
    });

    it('should dedupe when a moved card also arrives via an in-flight page', async () => {
      await setupDnd();

      const pending = new Subject<BoardPage>();

      taskClientMock.listBoardPages.mockReturnValue(pending);

      component.requestNextPage('col2');
      await new Promise((resolve) => setTimeout(resolve, 0));

      drop(mover(), col2);

      pending.next({
        col2: {
          tasks: [makeCard({ id: 'm1', statusId: 's3', number: 100, priorityLevel: 2, version: 2 })],
          nextCursor: null,
          hasMore: false,
        },
      });
      pending.complete();

      expect(columnIds().filter((id) => id === 'm1')).toHaveLength(1);
    });

    it('should roll back on mutation failure without touching cursor/hasMore', async () => {
      await setupDnd();

      taskClientMock.update.mockReturnValue(throwError(() => new Error('Network error')));

      const cursorBefore = component.columnStates()['col2'].nextCursor;

      drop(mover(), col2);

      expect(
        component
          .columnStates()
          ['col1'].tasks.map((t: BoardTask) => t.id)
          .sort(),
      ).toEqual(['keep', 'm1']);
      expect(component.columnStates()['col2'].tasks.map((t: BoardTask) => t.id)).toEqual(['b1']);
      expect(component.columnStates()['col2'].nextCursor).toBe(cursorBefore);
      expect(component.columnStates()['col2'].hasMore).toBe(true);
    });

    it('should refresh the single card on version conflict instead of blind rollback', async () => {
      await setupDnd();

      taskClientMock.update.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
      );
      taskClientMock.getById.mockReturnValue(
        of(makeCard({ id: 'm1', statusId: 's3', number: 100, priorityLevel: 2, version: 7 })),
      );

      drop(mover(), col2);

      expect(taskClientMock.getById).toHaveBeenCalledWith('m1');

      const target = component.columnStates()['col2'];

      expect(target.tasks.find((t: BoardTask) => t.id === 'm1')?.version).toBe(7);
      expect(component.columnStates()['col1'].tasks.map((t: BoardTask) => t.id)).toEqual(['keep']);
    });

    it('should drop a server-deleted card on 404 without rollback', async () => {
      await setupDnd();

      taskClientMock.update.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })),
      );

      drop(mover(), col2);

      expect(columnIds()).not.toContain('m1');
    });

    it('should ignore a second drag of a card with an in-flight mutation', async () => {
      await setupDnd();

      const pending = new Subject<BoardTask>();

      taskClientMock.update.mockReturnValue(pending);

      drop(mover(), col2);
      drop(mover(), col2);

      expect(taskClientMock.update).toHaveBeenCalledTimes(1);

      pending.next(makeCard({ id: 'm1', statusId: 's3', number: 100, priorityLevel: 2, version: 2 }));
      pending.complete();
    });

    it('should upsert into fresh state when a filter changes mid-mutation', async () => {
      const fx = await setupDnd();
      const pending = new Subject<BoardTask>();

      taskClientMock.update.mockReturnValue(pending);

      drop(mover(), col2);

      taskClientMock.listBoardPages.mockReturnValue(of(defaultPages()));
      fx.componentRef.setInput('priorityLevel', 2);
      await until(fx, () => component.columnStates()['col1']?.tasks.length === 2);

      pending.next(makeCard({ id: 'm1', statusId: 's3', number: 100, priorityLevel: 2, version: 2 }));
      pending.complete();
      await settle(fx);

      // Fresh col2 holds Task C; the moved card upserts alongside it, no duplicates.
      expect(
        component
          .columnStates()
          ['col2'].tasks.map((t: BoardTask) => t.id)
          .sort(),
      ).toEqual(['m1', 'tk000000-0000-0000-0000-000000000003']);
      expect(columnIds().filter((id) => id === 'm1')).toHaveLength(1);
    });

    it('should keep every card in exactly one column after a move sequence', async () => {
      await setupDnd();

      drop(mover(), col2);

      const moved = component.columnStates()['col2'].tasks.find((t: BoardTask) => t.id === 'm1');

      // col1 groups two statuses — the move completes through the status dialog.
      drop(moved, mockBoard.columns[0] as BoardColumn);
      component.applyStatusSelection('s1');

      const ids = columnIds();
      const unique = new Set(ids);

      expect(ids.length).toBe(unique.size);
      expect(unique.has('m1')).toBe(true);
    });

    it('should ignore drops within the same column (order is sort-derived)', async () => {
      await setupDnd();

      const card = mover();

      component.onTaskDrop(
        { item: { data: card }, previousContainer: { id: 'same' }, container: { id: 'same' } },
        mockBoard.columns[0] as BoardColumn,
      );

      expect(taskClientMock.update).not.toHaveBeenCalled();
      expect(component.columnStates()['col1'].tasks.map((t: BoardTask) => t.id)).toEqual(['m1', 'keep']);
    });

    it('should prompt for a status when the target column groups several statuses', async () => {
      await setupDnd();

      drop(mover(), mockBoard.columns[0] as BoardColumn);

      expect(component.pendingDrop()).not.toBeNull();
      expect(component.showStatusSelect()).toBe(true);
      expect(taskClientMock.update).not.toHaveBeenCalled();

      component.applyStatusSelection('s2');

      expect(taskClientMock.update).toHaveBeenCalledWith('m1', expect.objectContaining({ statusId: 's2' }));
    });
  });

  // ── goToTask ────────────────────────────────────────────

  describe('goToTask', () => {
    it('should navigate to the task detail route using the KEY-number format', async () => {
      await setup();

      const task = makeCard({ number: 5 });

      component.goToTask(task);

      expect(routerMock.navigate).toHaveBeenCalledWith(['/w', 't1', 'projects', 't1', 'tasks', 't1-5']);
    });

    // Keyboard path (WCAG 2.2 SC 2.1.1). The card emits an application-level
    // `taskClick` output on Enter/Space, which does NOT bubble as a DOM click;
    // the board must bind it or a keyboard user can read a card and open none.
    it('should navigate when a board card is activated with Enter', async () => {
      const fx = await setup();
      const card = fx.nativeElement.querySelector('ui-task-card [role="button"]') as HTMLElement | null;

      expect(card).not.toBeNull();

      await clickUntil(
        () => card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
        () => expect(routerMock.navigate).toHaveBeenCalledWith(['/w', 't1', 'projects', 't1', 'tasks', 't1-1']),
      );
    });
  });

  // ── goToNewTask ─────────────────────────────────────────

  describe('goToNewTask', () => {
    it('should navigate to the unified create-task page instead of opening a dialog', async () => {
      await setup();

      component.goToNewTask();

      expect(routerMock.navigate).toHaveBeenCalledWith(['/w', 't1', 'projects', 't1', 'tasks', 'new']);
    });
  });

  // ── Sprint selector ────────────────────────────────────

  describe('sprint selector', () => {
    it('should fetch sprints for the board project', async () => {
      await setup();

      expect(sprintClientMock.list).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001');
      expect(component.sprints()).toEqual(mockSprints);
    });

    it('should scope the task query when sprintId input is set', async () => {
      TestBed.resetTestingModule();
      await setup({ sprintId: 'sp1' });

      expect(taskClientMock.listBoardPages).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001', {
        sprintId: 'sp1',
      });
    });

    it('should resolve the scoped sprint display name from the list', async () => {
      TestBed.resetTestingModule();
      await setup({ sprintId: 'sp1' });

      expect(component.selectedSprintName()).toBe('Sprint 1');
    });

    it('should fall back to the raw id for an unknown sprint', async () => {
      TestBed.resetTestingModule();
      await setup({ sprintId: 'unknown-id' });

      expect(component.selectedSprintName()).toBe('unknown-id');
    });

    it('should write ?sprintId= to the URL (replaceUrl) on selection', async () => {
      await setup();

      component.onSprintSelect('sp1');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { sprintId: 'sp1' },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should clear the sprint param when the empty value is selected', async () => {
      await setup();

      component.onSprintSelect('');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { sprintId: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });
  });

  // ── Board assignee/priority filters ─────────────────────

  describe('board filters (F-08)', () => {
    it('should resolve ?assignee=me to the current user id at query time', async () => {
      TestBed.resetTestingModule();
      await setup({ assignee: 'me' }, [], mockBoard, defaultPages(), { id: 'u1' });

      expect(taskClientMock.listBoardPages).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001', {
        assigneeId: 'u1',
      });
    });

    it('should pass a concrete member id server-side', async () => {
      TestBed.resetTestingModule();
      await setup({ assignee: 'u2' });

      expect(taskClientMock.listBoardPages).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001', {
        assigneeId: 'u2',
      });
    });

    it('should not send assigneeId for ?assignee=unassigned and post-filter client-side', async () => {
      TestBed.resetTestingModule();

      const assigned = makeCard({ id: 'tk-assigned', statusId: 's1', title: 'Assigned', number: 9, assigneeId: 'u2' });
      const pages = defaultPages();

      pages['col1'] = { tasks: [...(pages['col1']?.tasks ?? []), assigned], nextCursor: null, hasMore: false };

      const fx = await setup({ assignee: 'unassigned' }, [], mockBoard, pages);

      await until(fx, () => Object.keys(component.columnStates()).length === 3);

      const call = taskClientMock.listBoardPages.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(call.assigneeId).toBeUndefined();
      expect(
        component
          .displayedTasksByColumnId()
          .get('col1')
          ?.map((t: BoardTask) => t.id),
      ).not.toContain('tk-assigned');
      expect(component.displayedTasksByColumnId().get('col1')).toHaveLength(2);
    });

    it('should send the priority filter server-side', async () => {
      TestBed.resetTestingModule();
      await setup({ priorityLevel: 2 });

      expect(taskClientMock.listBoardPages).toHaveBeenCalledWith('p0000000-0000-0000-0000-000000000001', {
        priorityLevel: 2,
      });
    });

    it('should write ?assignee= to the URL on selection and clear with the empty value', async () => {
      await setup();

      component.onAssigneeSelect('u2');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { assignee: 'u2' },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );

      component.onAssigneeSelect('');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { assignee: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should write ?priorityLevel= to the URL on selection and clear with the empty value', async () => {
      await setup();

      component.onPrioritySelect(2);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { priorityLevel: '2' },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );

      component.onPrioritySelect('');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { priorityLevel: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }),
      );
    });

    it('should fall back to the raw id for the assignee chip label when members are not loaded', async () => {
      TestBed.resetTestingModule();
      await setup({ assignee: 'u2' });

      expect(component.selectedAssigneeLabel()).toBe('u2');
    });

    it('should produce an empty chip label when no assignee filter is set', async () => {
      await setup();

      expect(component.selectedAssigneeLabel()).toBe('');
      expect(component.selectedPriorityLabel()).toBe('');
    });
  });

  // ── Status display names ────────────────────────────────

  describe('status display names (DR-1)', () => {
    const namedStatuses = [
      { id: 's1', name: 'To Do' },
      { id: 's2', name: 'In Progress' },
      { id: 's3', name: 'Done' },
      { id: 's4', name: 'Reopened' },
    ];

    it('should render human status names (not raw ids) in board column headers', async () => {
      const fx = await setup({}, namedStatuses);

      // Column names resolve asynchronously once ProjectRefStore has the statuses
      await until(fx, () => fx.nativeElement.textContent.includes('To Do / In Progress'));

      const text = fx.nativeElement.textContent as string;

      expect(text).toContain('To Do / In Progress');
      expect(text).toContain('Done');
      expect(text).toContain('Reopened');
      expect(text).not.toContain('Column 1');
    });

    it('should fall back to a positional label when statuses are not loaded', async () => {
      const fx = await setup({});

      expect(fx.nativeElement.textContent).toContain('Column 1');
    });
  });

  // ── Loaded counts in column headers  ──────

  describe('loaded counts in column headers (Q9)', () => {
    it('should render a muted count badge with the loaded cards per column', async () => {
      const fx = await setup({});

      // Wait for the board + pages to render (2 in col1, 1 in col2, 0 in col3)
      await until(fx, () => !!fx.nativeElement.querySelector('.cdk-drop-list'));

      const counts = Array.from(fx.nativeElement.querySelectorAll('h2 span:last-child')).map((span) =>
        (span as HTMLElement).textContent?.trim(),
      );

      expect(counts).toEqual(['2', '1', '0']);
    });

    it('should mark columns with more server-side cards with a trailing plus', async () => {
      const pages = defaultPages();

      pages['col1'] = {
        tasks: pages['col1']?.tasks ?? [],
        hasMore: true,
        nextCursor: encodeBoardCursor({ priorityLevel: 1, number: 2 }),
      };

      const fx = await setup({}, [], mockBoard, pages);

      await until(fx, () => Object.keys(component.columnStates()).length === 3);
      await until(fx, () => !!fx.nativeElement.querySelector('.cdk-drop-list'));

      const counts = Array.from(fx.nativeElement.querySelectorAll('h2 span:last-child')).map((span) =>
        (span as HTMLElement).textContent?.trim(),
      );

      expect(counts).toEqual(['2+', '1', '0']);
    });
  });

  // ── Empty columns ───────────────────────────────────────

  describe('empty columns', () => {
    it('should render no placeholder text at all in an empty column', async () => {
      const fx = await setup();
      // col3 (statusIds: ['s4']) has no matching tasks
      const dropList = fx.nativeElement.querySelector('#column-col3');

      expect(dropList).not.toBeNull();
      expect(dropList.querySelector('[data-drop-zone]')).toBeNull();
      expect((dropList.textContent as string).trim()).toBe('');
    });
  });

  // ── a11y: keyboard move-to-column (the keyboard path for a pointer-only drag) ──

  describe('keyboard move to column (F20)', () => {
    async function setupBoard() {
      const fx = await setup();

      await until(fx, () => Object.keys(component.columnStates()).length === 3);
      await until(fx, () => !!fx.nativeElement.querySelector('.cdk-drop-list'));

      return fx;
    }

    function firstCardInCol1(): BoardTask {
      return component.columnStates()['col1'].tasks[0] as BoardTask;
    }

    it('should open the picker from a card and offer every OTHER column', async () => {
      const fx = await setupBoard();

      component.openMoveToColumn(firstCardInCol1());

      expect(component.showMoveToColumn()).toBe(true);
      expect(component.pendingMove()?.id).toBe('tk000000-0000-0000-0000-000000000001');

      // The card lives in col1 (s1/s2), so col1 is filtered out and the picker
      // must never offer a no-op.
      expect(component.moveTargets().map((c: BoardColumn) => c.id)).toEqual(['col2', 'col3']);
      expect(taskClientMock.update).not.toHaveBeenCalled();
      void fx;
    });

    it('should persist the move when a single-status column is picked', async () => {
      await setupBoard();

      const card = firstCardInCol1();

      component.openMoveToColumn(card);
      component.moveToColumn(mockBoard.columns[1] as BoardColumn);

      expect(taskClientMock.update).toHaveBeenCalledWith(card.id, { statusId: 's3', version: card.version });
      expect(component.showMoveToColumn()).toBe(false);
      expect(component.pendingMove()).toBeNull();
    });

    it('should ask which status to use when the picked column groups several', async () => {
      await setupBoard();

      const card = firstCardInCol1();

      component.openMoveToColumn(card);
      // col2 is single-status; going BACK to a multi-status column must reuse
      // the existing status prompt rather than guessing.
      component.moveToColumn({ id: 'colX', statusIds: ['s7', 's8'], position: 9 } as BoardColumn);

      expect(component.showMoveToColumn()).toBe(false);
      expect(component.showStatusSelect()).toBe(true);
      expect(component.pendingDrop()?.targetColumn.id).toBe('colX');
      expect(taskClientMock.update).not.toHaveBeenCalled();

      component.applyStatusSelection('s8');

      expect(taskClientMock.update).toHaveBeenCalledWith(card.id, { statusId: 's8', version: card.version });
    });

    it('should forget the pending card when the picker is dismissed', async () => {
      await setupBoard();

      component.openMoveToColumn(firstCardInCol1());
      component.onMoveToColumnDialogStateChange('closed');

      expect(component.showMoveToColumn()).toBe(false);
      expect(component.pendingMove()).toBeNull();
    });

    it('should advertise the shortcut on the rendered card and open the picker on `v`', async () => {
      const fx = await setupBoard();
      const card = fx.nativeElement.querySelector('[role="button"][aria-keyshortcuts="v"]') as HTMLElement;

      expect(card).not.toBeNull();

      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      await settle(fx);

      expect(component.showMoveToColumn()).toBe(true);
    });
  });
});
