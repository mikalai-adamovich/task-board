/**
 * Tests for the AuditLogViewer table.
 *
 * Covers:
 * - Table columns render (Time · Actor · Action · Entity · Changes)
 * - Human-readable refs: no raw UUIDs for status/sprint/task entities
 * - Time sort toggle (asc/desc, default desc)
 * - Filters narrow the query (action / entity type / actor)
 * - Pagination via the shared component
 * - Row-click inline expansion of full changes
 * - lucideHistory icon vertical alignment with the heading
 */
import { TestBed } from '@angular/core/testing';
import { Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { firstValueFrom, Subject, of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { AuditLogViewer } from './audit-log-viewer';
import { AuditClient } from '@services/audit-client';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import type { AuditEvent, PaginatedResponse } from '@task-board/shared';
import { clickUntil, settle } from '@app/shared/testing/zoneless';

const NOW = '2025-01-01T00:00:00Z';
const mockEvents: AuditEvent[] = [
  {
    id: 'ae1',
    tenantId: 't1',
    projectId: 'p1',
    entityType: 'TASK',
    entityId: 'task-1',
    action: 'CREATED',
    actor: { userId: 'u1', displayName: 'Alice' },
    changes: [{ field: 'title', oldValue: null, newValue: 'New Task' }],
    createdAt: NOW,
    entityLabel: 'PROJ-123',
  },
  {
    id: 'ae2',
    tenantId: 't1',
    projectId: 'p1',
    entityType: 'SPRINT',
    entityId: 'sprint-1',
    action: 'UPDATED',
    actor: { userId: 'u2', displayName: 'Bob' },
    changes: [
      {
        field: 'statusId',
        oldValue: 'status-todo-id',
        newValue: 'status-inprog-id',
        oldLabel: 'To Do',
        newLabel: 'In Progress',
        rawOldValue: 'status-todo-id',
        rawNewValue: 'status-inprog-id',
      },
      { field: 'name', oldValue: 'Sprint 1', newValue: 'Sprint 1 Updated' },
      { field: 'goal', oldValue: null, newValue: 'Ship it' },
    ],
    createdAt: NOW,
    entityLabel: 'Sprint 1',
  },
];
const mockPaginatedResponse: PaginatedResponse<AuditEvent> = {
  data: mockEvents,
  pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
};
const EN_LANG = {
  auditLog: {
    title: 'Audit Log',
    loading: 'Loading audit events…',
    noEvents: 'No audit events found.',
    allEntityTypes: 'All Entity Types',
    allActions: 'All Actions',
    allActors: 'All Actors',
    time: 'Time',
    actor: 'Actor',
    actionCol: 'Action',
    entity: 'Entity',
    changes: 'Changes',
  },
};

describe('AuditLogViewer (R3-P7 table)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fixture: any;
  let auditClientMock: { listByProject: ReturnType<typeof vi.fn> };
  let routerMock: { navigate: ReturnType<typeof vi.fn>; events: unknown };
  let routerEvents: Subject<NavigationEnd>;

  async function waitForLoaded() {
    for (let i = 0; i < 50 && component.loading(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(fixture);
  }

  /** Current persisted rows-per-page preference (0 = Auto sentinel) — mutable per test. */
  let preferencesPageSize = 20;

  async function setup(listFn?: ReturnType<typeof vi.fn>, persistedPageSize = 20, withoutProject = false) {
    preferencesPageSize = persistedPageSize;
    auditClientMock = {
      listByProject: listFn ?? vi.fn().mockReturnValue(of(mockPaginatedResponse)),
    };
    routerEvents = new Subject<NavigationEnd>();
    routerMock = { navigate: vi.fn().mockResolvedValue(true), events: routerEvents.asObservable() };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: { en: EN_LANG },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        { provide: AuditClient, useValue: auditClientMock },
        // R3-P8 format tokens + Q2 page-size preference consumed by the viewer
        {
          provide: PreferencesStore,
          useValue: {
            datePipeFormat: () => 'yyyy-MM-dd',
            dateTimePipeFormat: () => 'yyyy-MM-dd HH:mm',
            // Active language used as the DatePipe locale
            language: () => 'en',
            pageSize: () => preferencesPageSize,
            setPageSize: vi.fn(),
          },
        },
        {
          provide: ProjectStore,
          useValue: { activeProject: () => (withoutProject ? null : { id: 'p1' }), projectRole: () => null },
        },
        { provide: Router, useValue: routerMock },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParams: of({}),
            snapshot: { paramMap: { get: () => 'proj-key' } },
            parent: { queryParams: of({}), snapshot: { paramMap: { get: () => 'acme' } }, parent: null },
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(AuditLogViewer);
    fixture.componentRef.setInput('projectKey', 'proj-key');
    component = fixture.componentInstance;
    await settle(fixture);
  }

  // A blank projectId (store not hydrated yet) must not produce
  // `listByProject('')` — that request returns the SPA-fallback HTML.
  it('does NOT request the audit log while the project is unresolved (F21)', async () => {
    await setup(undefined, 20, true);
    await settle(fixture);

    expect(auditClientMock.listByProject).not.toHaveBeenCalled();
    expect(component.events()).toEqual([]);
  });

  it('renders the five table columns', async () => {
    await setup();
    await waitForLoaded();

    const headers = [...fixture.nativeElement.querySelectorAll('th')].map((th: HTMLElement) => th.textContent?.trim());

    expect(headers).toEqual(['Time', 'Actor', 'Action', 'Entity', 'Changes']);
  });

  it('renders enriched rows without raw UUIDs for status/sprint/task entities', async () => {
    await setup();
    await waitForLoaded();

    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('PROJ-123');
    expect(text).toContain('Sprint 1');
    expect(text).toContain('To Do');
    expect(text).toContain('In Progress');
    expect(text).not.toContain('task-1');
    expect(text).not.toContain('sprint-1');
    expect(text).not.toContain('status-todo-id');
  });

  it('shows compact diffs (field: old → new) and collapses long change lists', async () => {
    await setup();
    await waitForLoaded();

    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('title:');
    expect(text).toContain('statusId:');
    // Third change hidden until expansion
    expect(text).toContain('+1');
  });

  it('expands the full changes detail on row click', async () => {
    await setup();
    await waitForLoaded();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');

    await clickUntil(
      () => (rows[1] as HTMLElement).click(),
      () => expect(component.expandedEventId()).toBe('ae2'),
    );
    await settle(fixture);

    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('goal:');
    expect(text).not.toContain('+1');
  });

  describe('time sort toggle', () => {
    it('defaults to desc and toggles to asc via the URL', async () => {
      await setup();
      await waitForLoaded();

      expect(component.sort()).toBe('desc');

      const timeHeader = fixture.nativeElement.querySelector('th') as HTMLElement;
      const sortButton = timeHeader.querySelector('button') as HTMLButtonElement;

      await clickUntil(
        () => sortButton.click(),
        () =>
          expect(routerMock.navigate).toHaveBeenCalledWith(
            [],
            expect.objectContaining({ queryParams: { sort: 'asc' }, queryParamsHandling: 'merge', replaceUrl: true }),
          ),
      );
      await settle(fixture);

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { sort: 'asc' }, queryParamsHandling: 'merge', replaceUrl: true }),
      );
    });
  });

  describe('filters', () => {
    it('narrow the server query when bound from the URL', async () => {
      await setup();
      await waitForLoaded();
      auditClientMock.listByProject.mockClear();

      fixture.componentRef.setInput('action', 'UPDATED');
      fixture.componentRef.setInput('entityType', 'SPRINT');
      fixture.componentRef.setInput('actor', 'u2');
      await waitForLoaded();

      expect(auditClientMock.listByProject).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ page: 1, limit: 20, action: 'UPDATED', entityType: 'SPRINT', actorId: 'u2' }),
      );
    });

    it('write the action filter to the URL and reset the page', async () => {
      await setup();
      await waitForLoaded();

      component.onActionChange('DELETED');

      expect(routerMock.navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { action: 'DELETED', page: null } }),
      );
    });
  });

  describe('pagination', () => {
    it('writes the requested page to the URL', async () => {
      await setup(
        vi.fn().mockImplementation((_projectId: string, params: { page?: number }) =>
          of({
            data: params.page === 2 ? [mockEvents[0]] : mockEvents,
            pagination: { page: params.page ?? 1, limit: 20, total: 21, totalPages: 2 },
          }),
        ),
      );
      await waitForLoaded();

      component.goToPage(2);

      expect(routerMock.navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { page: 2 } }));
    });

    it('ignores out-of-range pages', async () => {
      await setup();
      await waitForLoaded();

      component.goToPage(0);
      component.goToPage(99);

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('surfaces the error message', async () => {
      await setup(vi.fn().mockReturnValue(throwError(() => ({ error: { message: 'Forbidden' } }))));
      await waitForLoaded();

      expect(component.error()).toBe('Forbidden');
      expect(component.loading()).toBe(false);
    });
  });

  it('aligns the history icon with the heading (flex items-center)', async () => {
    await setup();
    await waitForLoaded();

    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;

    expect(heading.className).toContain('flex');
    expect(heading.className).toContain('items-center');
    expect(heading.querySelector('ng-icon')).toBeTruthy();
  });

  describe('Q2 (F-05) full-height + Auto page size', () => {
    it('renders no loading spinner — the defaultValue empty state shows directly', async () => {
      await setup(vi.fn().mockReturnValue(new Subject())); // never emits — stays loading forever
      await settle(fixture);

      expect(fixture.nativeElement.querySelector('hlm-spinner')).toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('Loading audit events');
    });

    it('derives the effective limit from the measured wrapper when the Auto sentinel is persisted', async () => {
      await setup(undefined, 0); // AUTO_PAGE_SIZE_SENTINEL
      await waitForLoaded();

      // jsdom wrapper has no height → clamped to the minimum of 3 rows
      expect(auditClientMock.listByProject).toHaveBeenCalledWith('p1', expect.objectContaining({ limit: 3 }));
    });
  });
});
