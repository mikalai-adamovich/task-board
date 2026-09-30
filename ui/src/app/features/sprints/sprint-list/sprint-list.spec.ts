/**
 * Tests for the SprintList component.
 *
 * Covers:
 * - Loading sprints (project-level and tenant-level)
 * - createSprint validation & submission
 * - getStatusColor helper
 * - isGroupExpanded / toggleGroup
 * - onDialogStateChange
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { submit } from '@angular/forms/signals';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { SprintList, CreateSprintForm } from './sprint-list';
import { SprintClient } from '@services/sprint-client';
import { TaskClient } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Sprint, User } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';
const mockSprints: Sprint[] = [
  {
    id: 'sp1',
    projectId: 'p1',
    name: 'Sprint 1',
    startDate: NOW,
    endDate: '2025-02-01T00:00:00Z',
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'sp2',
    projectId: 'p2',
    name: 'Sprint 2',
    startDate: NOW,
    endDate: '2025-02-01T00:00:00Z',
    status: 'FUTURE',
    createdAt: NOW,
    updatedAt: NOW,
  },
];

describe('SprintList', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<SprintList>;
  let sprintClientMock: {
    list: ReturnType<typeof vi.fn>;
    listByTenant: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let taskClientMock: { list: ReturnType<typeof vi.fn> };
  let authStoreMock: {
    currentUser: ReturnType<typeof vi.fn>;
    isAuthenticated: () => boolean;
    token: () => string | null;
    tenantRole: () => string | null;
    tenantId: ReturnType<typeof vi.fn>;
  };

  async function setup(projectId?: string) {
    sprintClientMock = {
      list: vi.fn().mockReturnValue(of(mockSprints)),
      listByTenant: vi.fn().mockReturnValue(of(mockSprints)),
      create: vi.fn().mockReturnValue(of(mockSprints[0])),
    };
    taskClientMock = {
      list: vi.fn().mockReturnValue(of({ data: [], pagination: { total: 5, page: 1, limit: 1, totalPages: 5 } })),
    };
    authStoreMock = {
      currentUser: vi.fn().mockReturnValue({ id: 'u1' } as User),
      isAuthenticated: () => true,
      token: () => 'fake-jwt',
      tenantRole: () => 'OWNER',
      tenantId: vi.fn().mockReturnValue('t1'),
    };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: SprintClient, useValue: sprintClientMock },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: AuthStore, useValue: authStoreMock },
        {
          provide: ProjectStore,
          useValue: { activeProject: () => (projectId ? { id: projectId } : null), projectRole: () => null },
        },
      ],
    });

    fixture = TestBed.createComponent(SprintList);

    if (projectId) {
      fixture.componentRef.setInput('projectKey', projectId);
    }

    component = fixture.componentInstance;
    await settle(fixture);
  }

  // ── Loading ─────────────────────────────────────────────

  describe('ngOnInit - project-level', () => {
    beforeEach(() => setup('p1'));

    it('should call sprintClient.list with projectId', () => {
      expect(sprintClientMock.list).toHaveBeenCalledWith('p1');
    });

    it('should populate sprints signal', () => {
      expect(component.sprints()).toEqual(mockSprints);
    });

    it('should set loading to false', () => {
      expect(component.loading()).toBe(false);
    });
  });

  describe('ngOnInit - tenant-level (no project context)', () => {
    beforeEach(() => setup());

    // Without an active project there is nothing to fetch — the old
    // component issued a bogus `GET /projects//tasks`-style request here.
    it('should NOT call sprintClient.list when no projectId', () => {
      expect(sprintClientMock.list).not.toHaveBeenCalled();
    });

    it('should leave sprints empty when no projectId', () => {
      expect(component.sprints()).toEqual([]);
    });

    // The backlog counter resource used to run its stream with an empty
    // projectId, i.e. `taskClient.list('', { hasSprint: false, limit: 1 })`.
    it('should NOT call taskClient.list for the backlog count when no projectId (F21)', () => {
      expect(taskClientMock.list).not.toHaveBeenCalled();
      expect(component.backlogCount()).toBe(0);
    });

    it('should set loading to false', () => {
      expect(component.loading()).toBe(false);
    });

    it('should handle error and set loading to false', async () => {
      sprintClientMock = {
        list: vi.fn().mockReturnValue(throwError(() => new Error('fail'))),
        listByTenant: vi.fn(),
        create: vi.fn(),
      };
      authStoreMock = {
        currentUser: vi.fn().mockReturnValue(null),
        isAuthenticated: () => false,
        token: () => null,
        tenantRole: () => null,
        tenantId: vi.fn().mockReturnValue('t1'),
      };

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          { provide: API_BASE_URL, useValue: 'http://localhost/api' },
          { provide: SprintClient, useValue: sprintClientMock },
          { provide: TaskClient, useValue: taskClientMock },
          { provide: AuthStore, useValue: authStoreMock },
          { provide: ProjectStore, useValue: { activeProject: () => null, projectRole: () => null } },
        ],
      });

      await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

      const fixture = TestBed.createComponent(SprintList);

      component = fixture.componentInstance;
      await settle(fixture);

      expect(component.loading()).toBe(false);
    });
  });

  // ── getStatusColor ──────────────────────────────────────

  describe('getStatusColor', () => {
    beforeEach(() => setup());

    it('should return correct color for each status', () => {
      expect(component.statusBadgeVariant('FUTURE')).toBe('secondary');
      expect(component.statusBadgeVariant('ACTIVE')).toBe('default');
      expect(component.statusBadgeVariant('COMPLETED')).toBe('outline');
    });

    it('should return fallback for unknown', () => {
      expect(component.statusBadgeVariant('unknown')).toBe('outline');
    });
  });

  // ── toggleGroup ──────────────────────────────────────

  describe('isGroupExpanded / toggleGroup', () => {
    beforeEach(() => setup());

    it('should default to expanded', () => {
      expect(component.isGroupExpanded('p1')).toBe(true);
    });

    it('should toggle to expanded', () => {
      component.toggleGroup('p1');
      expect(component.isGroupExpanded('p1')).toBe(true);
    });

    it('should toggle back to collapsed', () => {
      component.toggleGroup('p1');
      component.toggleGroup('p1');
      expect(component.isGroupExpanded('p1')).toBe(false);
    });
  });

  // ── createSprint ────────────────────────────────────────

  describe('createSprint', () => {
    beforeEach(() => setup('p1'));

    it('should not create when name is empty', () => {
      component.model.update((m: CreateSprintForm) => ({ ...m, name: '' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, startDate: '2025-01-01' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, endDate: '2025-02-01' }));
      submit(component.newSprintForm);
      expect(sprintClientMock.create).not.toHaveBeenCalled();
    });

    it('should create sprint and add to list (F2: upsert into the shared cache)', () => {
      // The real server returns a NEW id for the created sprint — the default
      // mock reuses sp1, which the F2 upsert would (correctly) treat as an update.
      sprintClientMock.create.mockReturnValueOnce(of({ ...mockSprints[0], id: 'sp3', name: 'New Sprint' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, name: 'New Sprint' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, startDate: '2025-01-01' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, endDate: '2025-02-01' }));
      submit(component.newSprintForm);

      expect(sprintClientMock.create).toHaveBeenCalled();
      expect(component.sprints()).toHaveLength(3);
      expect(component.sprints().find((s: Sprint) => s.id === 'sp3')?.name).toBe('New Sprint');
      expect(component.showCreateModal()).toBe(false);
    });

    it('should reset form after creation', () => {
      component.model.update((m: CreateSprintForm) => ({ ...m, name: 'New Sprint' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, startDate: '2025-01-01' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, endDate: '2025-02-01' }));
      submit(component.newSprintForm);

      expect(component.model().name).toBe('');
      expect(component.model().startDate).toBe('');
      expect(component.model().endDate).toBe('');
    });

    it('should set creating to false on error', () => {
      sprintClientMock.create.mockReturnValueOnce(throwError(() => new Error('fail')));
      component.model.update((m: CreateSprintForm) => ({ ...m, name: 'Fail Sprint' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, startDate: '2025-01-01' }));
      component.model.update((m: CreateSprintForm) => ({ ...m, endDate: '2025-02-01' }));
      submit(component.newSprintForm);

      expect(component.loading()).toBe(false);
    });
  });

  // ── Backlog group & overdue flag ──────────────────────────
  // The backlog group header is a plain (non-link) label since the standalone
  // backlog page was removed — unsprinted tasks are found via the tasks-table
  // sprint filter instead.

  describe('backlog group', () => {
    beforeEach(() => setup('p1'));

    // The contract CHANGED deliberately — `sprintId: null` meant "no sprint
    // filtering" and silently counted ALL project tasks as backlog. The backlog
    // is now requested explicitly with `hasSprint: false`; the assertion is
    // equally strict, just on the new key.
    it('should fetch the backlog task count with the explicit no-sprint filter (hasSprint: false)', () => {
      expect(taskClientMock.list).toHaveBeenCalledWith('p1', { hasSprint: false, limit: 1 });
    });

    it('should expose the backlog count from the pagination total', () => {
      expect(component.backlogCount()).toBe(5);
    });

    it('should render a plain non-link group header with the backlog count', async () => {
      for (let i = 0; i < 20 && component.sprints().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await settle(fixture);

      const el: HTMLElement = fixture.nativeElement;
      const backlogLinks = Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).filter((a) =>
        (a.getAttribute('href') ?? '').includes('sprints/backlog'),
      );

      expect(backlogLinks).toHaveLength(0);
      expect(el.textContent).toContain('sprints.backlog');
      expect(el.textContent).toContain('sprints.tasks');
    });
  });

  describe('overdue indicator', () => {
    beforeEach(() => setup('p1'));

    it('should flag an ACTIVE sprint whose endDate is in the past', () => {
      const overdue = component.isSprintOverdue({
        ...mockSprints[0],
        status: 'ACTIVE',
        endDate: '2000-01-01T00:00:00Z',
      });

      expect(overdue).toBe(true);
    });

    it('should not flag an ACTIVE sprint with a future endDate', () => {
      expect(component.isSprintOverdue({ ...mockSprints[0], status: 'ACTIVE', endDate: '2099-02-01T00:00:00Z' })).toBe(
        false,
      );
    });

    it('should not flag non-ACTIVE sprints even with a past endDate', () => {
      expect(component.isSprintOverdue({ ...mockSprints[1], status: 'FUTURE', endDate: '2000-01-01T00:00:00Z' })).toBe(
        false,
      );
    });
  });

  // ── onDialogStateChange ──────────────────────────────────

  describe('onDialogStateChange', () => {
    beforeEach(() => setup());

    it('should close dialog on closed state', () => {
      component.showCreateModal.set(true);
      component.onDialogStateChange('closed');
      expect(component.showCreateModal()).toBe(false);
    });
  });
});
