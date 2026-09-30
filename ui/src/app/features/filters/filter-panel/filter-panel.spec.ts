/**
 * Tests for the FilterPanel component.
 *
 * Covers:
 * - Loading saved views per project (rxResource)
 * - Saving current filter criteria under a name
 * - Applying a saved view (output emission)
 * - Renaming a view (PATCH)
 * - Deleting a view with confirmation
 * - Active-view detection against the current criteria/sort
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom, of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { FilterPanel, stableValue, type AppliedFilterState } from './filter-panel';
import { FilterClient } from '@services/filter-client';
import { ProjectRefStore } from '@stores/project-ref-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Filter } from '@task-board/shared';
import { settle } from '@app/shared/testing/zoneless';

const refStoreMock = {
  ensure: vi.fn(),
  options: (_pid: string, kind: string) => (kind === 'statuses' ? [{ id: 'st1', name: 'To Do' }] : []),
  nameMap: vi.fn(() => ({})),
  nameOf: vi.fn(),
};
const NOW = '2025-01-01T00:00:00Z';
const mockFilters: Filter[] = [
  {
    id: 'f1',
    projectId: 'p1',
    userId: 'u1',
    name: 'My High Priority',
    filters: { priorityLevel: [2, 3] },
    sort: { field: 'priority', direction: 'desc' },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'f2',
    projectId: 'p1',
    userId: 'u1',
    name: 'Open Bugs',
    filters: { search: 'bug', statusIds: ['s1'] },
    sort: { field: 'createdAt', direction: 'asc' },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'f3',
    projectId: 'p1',
    userId: 'u1',
    name: 'January Views',
    filters: { createdFrom: '2026-01-01', createdTo: '2026-01-31', updatedFrom: '2026-01-01' },
    sort: { field: 'createdAt', direction: 'desc' },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

describe('FilterPanel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixtureRef: ComponentFixture<FilterPanel>;
  let filterClientMock: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let emittedCriteria: AppliedFilterState | undefined;

  async function setup(filters: Filter[] = mockFilters, currentFilters: Record<string, unknown> = { search: 'test' }) {
    emittedCriteria = undefined;

    filterClientMock = {
      list: vi.fn().mockReturnValue(of(filters)),
      create: vi.fn().mockReturnValue(
        of({
          id: 'f3',
          projectId: 'p1',
          userId: 'u1',
          name: 'New Filter',
          filters: { search: 'test' },
          sort: { field: 'createdAt', direction: 'desc' },
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
      update: vi
        .fn()
        .mockImplementation((_id: string, body: { name: string }) => of({ ...mockFilters[0], name: body.name })),
      delete: vi.fn().mockReturnValue(of({ success: true })),
    };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: FilterClient, useValue: filterClientMock },
        { provide: ProjectRefStore, useValue: refStoreMock },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(FilterPanel);

    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('currentFilters', currentFilters);
    fixture.componentRef.setInput('currentSort', { field: 'createdAt', direction: 'desc' });

    component = fixture.componentInstance;
    fixtureRef = fixture;
    component.filterApplied.subscribe((state: AppliedFilterState) => {
      emittedCriteria = state;
    });
    await settle(fixture);
  }

  /** Waits until the rxResource-backed views list resolves */
  async function waitForViews(): Promise<void> {
    for (let i = 0; i < 100 && (!component.filters() || component.filters().length === 0); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await settle(fixtureRef);
  }

  // ── Loading ─────────────────────────────────────────────────────
  it('should load saved views for the project', async () => {
    await setup();
    await waitForViews();
    expect(filterClientMock.list).toHaveBeenCalledWith('p1');
    expect(component.filters()).toHaveLength(3);
    expect(component.loading()).toBe(false);
  });

  it('should surface a load error without throwing', async () => {
    filterClientMock = {
      list: vi.fn().mockReturnValue(throwError(() => new Error('fail'))),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: FilterClient, useValue: filterClientMock },
        { provide: ProjectRefStore, useValue: refStoreMock },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(FilterPanel);

    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('currentFilters', {});
    fixture.componentRef.setInput('currentSort', { field: 'createdAt', direction: 'desc' });

    component = fixture.componentInstance;
    await settle(fixture);

    expect(component.loadError()).toBe(true);
  });

  // ── Save ────────────────────────────────────────────────────────
  it('should save current filter criteria under a name', async () => {
    await setup();
    await waitForViews();
    component.saveModel.set({ name: 'New Filter' });
    component.submitSave();

    expect(filterClientMock.create).toHaveBeenCalledWith('p1', {
      name: 'New Filter',
      filters: { search: 'test' },
      sort: { field: 'createdAt', direction: 'desc' },
    });
    expect(component.showSaveForm()).toBe(false);
  });

  it('should not save with an empty name', async () => {
    await setup();
    await waitForViews();
    component.saveModel.set({ name: '   ' });
    component.submitSave();
    expect(filterClientMock.create).not.toHaveBeenCalled();
  });

  // ── Apply ───────────────────────────────────────────────────────
  it('should emit filterApplied when applying a view', async () => {
    await setup();
    await waitForViews();

    const view = component.filters()[0];

    component.applyFilter(view);
    expect(emittedCriteria).toEqual({
      filters: { priorityLevel: [2, 3] },
      sort: { field: 'priority', direction: 'desc' },
    });
  });

  // ── V4-10: editable filter fields ───────────────────────────────

  describe('filter fields (V4-10)', () => {
    it('should seed the draft from the current filters', async () => {
      await setup();
      await waitForViews();
      fixtureRef.componentRef.setInput('currentFilters', { search: 'bug', statusIds: ['st1'] });
      await settle(fixtureRef);

      expect(component.draft()).toEqual({ search: 'bug', statusIds: ['st1'] });
    });

    it('should emit the edited criteria on applyDraft', async () => {
      await setup(); // draft seeded from currentFilters: { search: 'test' }
      await waitForViews();
      component.setSingle('statusIds', 'st1');
      component.onDraftPriority(2);
      component.applyDraft();

      expect(emittedCriteria?.filters).toEqual({ search: 'test', statusIds: ['st1'], priorityLevel: [2] });
    });

    it('should clear a single-value key when set to empty and emit an empty state on clearDraft', async () => {
      await setup();
      await waitForViews();
      fixtureRef.componentRef.setInput('currentFilters', { search: 'bug', statusIds: ['st1'] });
      await settle(fixtureRef);

      component.setSingle('statusIds', '');
      expect(component.draft().statusIds).toBeUndefined();

      component.clearDraft();
      expect(emittedCriteria?.filters).toEqual({});
    });
  });

  // ── Rename ──────────────────────────────────────────────────────
  it('should rename a view via PATCH', async () => {
    await setup();
    await waitForViews();

    const view = component.filters()[0];

    component.startRename(view);
    expect(component.renameTarget()?.id).toBe('f1');
    expect(component.renameModel().name).toBe('My High Priority');

    component.renameModel.set({ name: 'Renamed View' });
    component.confirmRename();

    expect(filterClientMock.update).toHaveBeenCalledWith('f1', { name: 'Renamed View' });
    expect(component.renameTarget()).toBeNull();
  });

  it('should not rename to an empty or unchanged name', async () => {
    await setup();
    await waitForViews();

    const view = component.filters()[0];

    component.startRename(view);
    component.renameModel.set({ name: '   ' });
    component.confirmRename();
    expect(filterClientMock.update).not.toHaveBeenCalled();

    component.renameModel.set({ name: 'My High Priority' });
    component.confirmRename();
    expect(filterClientMock.update).not.toHaveBeenCalled();
  });

  // ── Active-view detection ───────────────────────────────────────
  it('should mark the view active whose criteria+sort match the current state', async () => {
    await setup(mockFilters, { search: 'bug', statusIds: ['s1'] });
    fixtureRef.componentRef.setInput('currentSort', { field: 'createdAt', direction: 'asc' });
    await settle(fixtureRef);
    await waitForViews();

    expect(component.activeViewId()).toBe('f2');
  });

  it('should have no active view when nothing matches', async () => {
    await setup(mockFilters, {});
    await settle(fixtureRef);
    await waitForViews();

    expect(component.activeViewId()).toBeNull();
  });

  it('should compare criteria order-insensitively (stableValue)', () => {
    expect(stableValue({ a: 1, b: [1, 2] })).toBe(stableValue({ b: [1, 2], a: 1 }));
    expect(stableValue({ a: 1 })).not.toBe(stableValue({ a: 2 }));
  });

  // ── Date-range criteria in saved views ──────────────────────────
  describe('date-range criteria (Q12)', () => {
    const DATE_FILTERS = {
      createdFrom: '2026-01-01',
      createdTo: '2026-01-31',
      updatedFrom: '2026-01-01',
      updatedTo: '2026-02-15',
    };

    it('should capture date-range criteria when saving a view', async () => {
      await setup(mockFilters, DATE_FILTERS);
      await waitForViews();
      component.saveModel.set({ name: 'Dated View' });
      component.submitSave();

      expect(filterClientMock.create).toHaveBeenCalledWith('p1', {
        name: 'Dated View',
        filters: DATE_FILTERS,
        sort: { field: 'createdAt', direction: 'desc' },
      });
    });

    it('should emit date-range criteria when applying a saved view', async () => {
      await setup();
      await waitForViews();

      component.applyFilter(component.filters()[2]);

      expect(emittedCriteria?.filters).toEqual({
        createdFrom: '2026-01-01',
        createdTo: '2026-01-31',
        updatedFrom: '2026-01-01',
      });
    });

    it('should detect the active view by its date-range criteria', async () => {
      await setup(mockFilters, { createdFrom: '2026-01-01', createdTo: '2026-01-31', updatedFrom: '2026-01-01' });
      await waitForViews();

      expect(component.activeViewId()).toBe('f3');
    });

    it('should have no active view when only the dates differ', async () => {
      await setup(mockFilters, { createdFrom: '2026-02-01', createdTo: '2026-01-31', updatedFrom: '2026-01-01' });
      await waitForViews();

      expect(component.activeViewId()).toBeNull();
    });

    it('should report active state when only date criteria are set', async () => {
      await setup(mockFilters, { updatedTo: '2026-02-15' });

      expect(component.hasActiveState()).toBe(true);
    });
  });

  // ── The editable draft must survive a background refresh ──────────────────

  it('should keep an in-progress draft when the parent re-emits identical criteria (F21)', async () => {
    await setup(mockFilters, { search: 'test' });
    await waitForViews();

    // The user edits a field in the panel…
    component.setSingle('statusIds', 'st1');
    component.onDraftSearch({ target: { value: 'half-typed' } } as unknown as Event);
    expect(component.draft().statusIds).toEqual(['st1']);

    // …and a background refresh re-emits the SAME criteria as a new object.
    fixtureRef.componentRef.setInput('currentFilters', { search: 'test' });
    await settle(fixtureRef);

    expect(component.draft().statusIds).toEqual(['st1']);
    expect(component.draft().search).toBe('half-typed');
  });

  it('should re-seed the draft when the applied criteria genuinely change (F21)', async () => {
    await setup(mockFilters, { search: 'test' });
    await waitForViews();

    component.setSingle('statusIds', 'st1');
    component.onDraftSearch({ target: { value: 'half-typed' } } as unknown as Event);

    // The parent applied a saved view — a real change of identity.
    fixtureRef.componentRef.setInput('currentFilters', { search: 'bug', statusIds: ['s1'] });
    await settle(fixtureRef);

    expect(component.draft()).toEqual({ search: 'bug', statusIds: ['s1'] });
  });

  it('should re-seed the draft when the criteria change only in key order (F21)', async () => {
    await setup(mockFilters, { search: 'test', statusIds: ['s1'] });
    await waitForViews();

    component.setSingle('labelIds', 'l9');

    // Same content, different key insertion order → still "the same filter".
    fixtureRef.componentRef.setInput('currentFilters', { statusIds: ['s1'], search: 'test' });
    await settle(fixtureRef);

    expect(component.draft().labelIds).toEqual(['l9']);
  });

  // ── Delete ──────────────────────────────────────────────────────
  it('should confirm and delete a view', async () => {
    await setup();
    await waitForViews();

    const view = component.filters()[0];

    component.confirmDelete(view);
    expect(component.showDeleteConfirm()).toBe(true);
    expect(component.filterToDelete()?.id).toBe('f1');

    component.deleteFilter();
    expect(filterClientMock.delete).toHaveBeenCalledWith('f1');
    expect(component.showDeleteConfirm()).toBe(false);
    expect(component.filterToDelete()).toBeNull();
  });
});
