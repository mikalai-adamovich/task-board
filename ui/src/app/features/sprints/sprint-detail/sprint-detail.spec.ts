/**
 * Tests for the SprintDetail component.
 *
 * Covers:
 * - Loading sprint and tasks on init
 * - Loading/error states
 * - getStatusColor, getPriorityDot, getPriorityBadge helpers
 * - removeTaskFromSprint
 * - Status transitions
 * - Delete sprint
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { SprintDetail } from './sprint-detail';
import { SprintClient } from '@services/sprint-client';
import { TaskClient } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { API_BASE_URL } from '@app/api-url.token';
import { NeutralDotColor } from '@app/constants/priority';
import type { Sprint, Task, TaskPriorityLevel, User } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';
const mockSprint: Sprint = {
  id: 'sp000000-0000-0000-0000-000000000001',
  projectId: 'p0000000-0000-0000-0000-000000000001',
  name: 'Sprint 1',
  startDate: NOW,
  endDate: '2025-02-01T00:00:00Z',
  status: 'ACTIVE',
  createdAt: NOW,
  updatedAt: NOW,
};
const mockSprintTasks: Task[] = [
  {
    id: 'tk1',
    projectId: mockSprint.projectId,
    number: 1,
    typeId: 'type1',
    title: 'Task 1',
    description: null,
    statusId: 's1',
    priorityLevel: 2,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: mockSprint.id,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'Test User' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'tk2',
    projectId: mockSprint.projectId,
    number: 2,
    typeId: 'type1',
    title: 'Task 2',
    description: null,
    statusId: 's1',
    priorityLevel: 0,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: mockSprint.id,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'Test User' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

describe('SprintDetail', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<SprintDetail>;
  let sprintClientMock: {
    getById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  let taskClientMock: { list: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let authStoreMock: {
    currentUser: ReturnType<typeof vi.fn>;
    isAuthenticated: () => boolean;
    token: () => string | null;
    tenantRole: () => string | null;
  };
  let routerMock: { navigate: ReturnType<typeof vi.fn> };
  const refStoreMock = {
    ensure: vi.fn(),
    invalidate: vi.fn(),
    // Full-DTO layer — the disposition dialog's "Move to…" targets
    sprintEntities: vi.fn(() => []),
    statusEntities: vi.fn(() => []),
    upsertEntity: vi.fn(),
    options: vi.fn((_pid: string, kind: string) =>
      kind === 'statuses'
        ? [
            { id: 's1', name: 'TODO' },
            { id: 's2', name: 'DONE' },
          ]
        : [],
    ),
    nameMap: vi.fn(() => ({})),
    nameOf: vi.fn(),
  };

  async function setup(sprintOverrides: Partial<Sprint> = {}, tasks: Task[] = mockSprintTasks) {
    const sprint = { ...mockSprint, ...sprintOverrides };

    sprintClientMock = {
      getById: vi.fn().mockReturnValue(of(sprint)),
      update: vi.fn().mockReturnValue(of({ ...sprint, status: 'COMPLETED' })),
      delete: vi.fn().mockReturnValue(of(undefined)),
      list: vi.fn().mockReturnValue(of([{ ...mockSprint, id: 'sp-future', name: 'Future', status: 'FUTURE' }])),
    };
    taskClientMock = {
      list: vi
        .fn()
        .mockReturnValue(of({ data: tasks, pagination: { total: tasks.length, page: 1, limit: 200, totalPages: 1 } })),
      update: vi.fn().mockReturnValue(of(tasks[0])),
    };
    authStoreMock = {
      currentUser: vi.fn().mockReturnValue({ id: 'u1' } as User),
      isAuthenticated: () => true,
      token: () => 'fake-jwt',
      tenantRole: () => 'OWNER',
    };
    routerMock = {
      navigate: vi.fn().mockResolvedValue(true),
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
        { provide: Router, useValue: routerMock },
        { provide: ProjectRefStore, useValue: refStoreMock },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: () => 't1' } },
            parent: { snapshot: { paramMap: { get: () => 't1' } }, parent: null },
          },
        },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(SprintDetail);

    fixture.componentRef.setInput('sprintId', mockSprint.id);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  /** Tasks whose status is the project's final DONE status (`s2`). */
  const doneTasks: Task[] = mockSprintTasks.map((t) => ({ ...t, statusId: 's2' }));

  // ── Loading ─────────────────────────────────────────────────────

  describe('ngOnInit', () => {
    beforeEach(() => setup());

    it('should call sprintClient.getById on init', () => {
      expect(sprintClientMock.getById).toHaveBeenCalledWith(mockSprint.id);
    });

    it('should populate the sprint signal', () => {
      expect(component.sprint()).toBeTruthy();
      expect(component.sprint().name).toBe('Sprint 1');
    });

    it('should load sprint tasks via taskClient.list (F5: without description)', () => {
      expect(taskClientMock.list).toHaveBeenCalledWith(mockSprint.projectId, {
        sprintId: mockSprint.id,
        limit: 200,
        excludeDescription: true,
      });
      expect(component.sprintTasks()).toHaveLength(2);
    });

    it('should set loading to false', () => {
      expect(component.loading()).toBe(false);
    });

    it('should set loading to false on error', async () => {
      sprintClientMock = {
        getById: vi.fn().mockReturnValue(throwError(() => new Error('fail'))),
        update: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      };
      taskClientMock = { list: vi.fn(), update: vi.fn() };
      authStoreMock = {
        currentUser: vi.fn().mockReturnValue(null),
        isAuthenticated: () => false,
        token: () => null,
        tenantRole: () => null,
      };
      routerMock = { navigate: vi.fn() };

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
          { provide: Router, useValue: routerMock },
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: { paramMap: { get: () => 't1' } },
              parent: { snapshot: { paramMap: { get: () => 't1' } }, parent: null },
            },
          },
        ],
      });

      await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

      const fixture = TestBed.createComponent(SprintDetail);

      fixture.componentRef.setInput('sprintId', mockSprint.id);
      component = fixture.componentInstance;
      await settle(fixture);

      expect(component.loading()).toBe(false);
      expect(component.sprint()).toBeNull();
    });
  });

  // ── Helper methods ─────────────────────────────────────────────

  describe('getStatusColor', () => {
    beforeEach(() => setup());

    it('should return color for FUTURE', () => {
      expect(component.statusBadgeVariant('FUTURE')).toBe('secondary');
    });

    it('should return color for ACTIVE', () => {
      expect(component.statusBadgeVariant('ACTIVE')).toBe('default');
    });

    it('should return color for COMPLETED', () => {
      expect(component.statusBadgeVariant('COMPLETED')).toBe('outline');
    });

    it('should return fallback for unknown', () => {
      expect(component.statusBadgeVariant('unknown')).toBe('outline');
    });
  });

  // ── Overdue indicator ───────────────────────────────────

  describe('overdue indicator', () => {
    beforeEach(() => setup());

    it('should flag an ACTIVE sprint whose endDate is in the past', () => {
      expect(component.isSprintOverdue({ ...mockSprint, status: 'ACTIVE', endDate: '2000-01-01T00:00:00Z' })).toBe(
        true,
      );
    });

    it('should not flag an ACTIVE sprint with a future endDate', () => {
      expect(component.isSprintOverdue({ ...mockSprint, status: 'ACTIVE', endDate: '2099-01-01T00:00:00Z' })).toBe(
        false,
      );
    });

    it('should not flag non-ACTIVE sprints even with a past endDate', () => {
      expect(component.isSprintOverdue({ ...mockSprint, status: 'COMPLETED', endDate: '2000-01-01T00:00:00Z' })).toBe(
        false,
      );
    });
  });

  describe('getPriorityDot', () => {
    beforeEach(() => setup());

    it('should return correct dot color for each priority', () => {
      expect(component.getPriorityDot(0)).toBe('bg-primary/40');
      expect(component.getPriorityDot(1)).toBe('bg-primary/70');
      expect(component.getPriorityDot(2)).toBe('bg-destructive/70');
      expect(component.getPriorityDot(3)).toBe('bg-destructive');
      expect(component.getPriorityDot(99 as TaskPriorityLevel)).toBe(NeutralDotColor);
    });
  });

  describe('getPriorityBadge', () => {
    beforeEach(() => setup());

    it('should return correct badge color for each priority', () => {
      expect(component.getPriorityBadge(0)).toBe('outline');
      expect(component.getPriorityBadge(1)).toBe('secondary');
      expect(component.getPriorityBadge(2)).toBe('default');
      expect(component.getPriorityBadge(3)).toBe('destructive');
      expect(component.getPriorityBadge(99 as TaskPriorityLevel)).toBe('outline');
    });
  });

  // ── Status transitions ────────────────────────────────────────

  describe('status transitions', () => {
    it('should show Start Sprint for FUTURE sprint', async () => {
      await setup({ status: 'FUTURE' });
      expect(component.availableTransitions).toEqual([{ label: 'Start Sprint', status: 'ACTIVE' }]);
    });

    it('should show Complete Sprint for ACTIVE sprint', async () => {
      await setup({ status: 'ACTIVE' });
      expect(component.availableTransitions).toEqual([{ label: 'Complete Sprint', status: 'COMPLETED' }]);
    });

    it('should show Reopen Sprint for COMPLETED sprint', async () => {
      await setup({ status: 'COMPLETED' });
      expect(component.availableTransitions).toEqual([{ label: 'Reopen Sprint', status: 'ACTIVE' }]);
    });

    it('should call sprintClient.update on transitionSprint when no unfinished tasks remain', async () => {
      await setup({ status: 'ACTIVE' }, doneTasks);
      component.transitionSprint('COMPLETED');

      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, { status: 'COMPLETED' });
    });
  });

  // ── V4-11: Start must PATCH ACTIVE — never the hardcoded COMPLETED flow ──

  describe('start sprint (V4-11 regression)', () => {
    it('should PATCH status ACTIVE on Start and not move any tasks', async () => {
      await setup({ status: 'FUTURE' }, mockSprintTasks); // unfinished tasks present
      component.transitionSprint('ACTIVE');

      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, { status: 'ACTIVE' });
      expect(taskClientMock.update).not.toHaveBeenCalled();
      expect(component.showDispositionDialog()).toBe(false);
    });

    it('should not open the disposition dialog on Start even with unfinished tasks', async () => {
      await setup({ status: 'FUTURE' }, mockSprintTasks);
      component.transitionSprint('ACTIVE');

      expect(component.showDispositionDialog()).toBe(false);
    });
  });

  // ── V1-7: completion disposition dialog ───────────────────────

  describe('completion disposition (V1-7)', () => {
    it('should compute unfinished tasks from the project final/DONE status', async () => {
      await setup({ status: 'ACTIVE' });

      expect(component.unfinishedTasks()).toHaveLength(2);
      expect(component.finalStatusIds().has('s2')).toBe(true);
    });

    it('should open the disposition dialog instead of completing when unfinished tasks exist', async () => {
      await setup({ status: 'ACTIVE' });
      component.transitionSprint('COMPLETED');

      expect(component.showDispositionDialog()).toBe(true);
      expect(sprintClientMock.update).not.toHaveBeenCalled();
    });

    it('should complete directly when all tasks are done', async () => {
      await setup({ status: 'ACTIVE' }, doneTasks);
      component.transitionSprint('COMPLETED');

      expect(component.showDispositionDialog()).toBe(false);
      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, { status: 'COMPLETED' });
    });

    it('should bulk-move unfinished tasks to the backlog (default) then complete the sprint', async () => {
      await setup({ status: 'ACTIVE' });
      component.transitionSprint('COMPLETED'); // opens the dialog
      component.completeSprint();

      for (const task of mockSprintTasks) {
        expect(taskClientMock.update).toHaveBeenCalledWith(task?.id, { sprintId: null, version: task?.version });
      }
      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, { status: 'COMPLETED' });
      expect(component.showDispositionDialog()).toBe(false);
    });

    it('should move unfinished tasks to a chosen future sprint then complete', async () => {
      await setup({ status: 'ACTIVE' });
      component.transitionSprint('COMPLETED');
      component.dispositionTarget.set('sp-future');
      component.completeSprint();

      for (const task of mockSprintTasks) {
        expect(taskClientMock.update).toHaveBeenCalledWith(task.id, { sprintId: 'sp-future', version: task.version });
      }
      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, { status: 'COMPLETED' });
    });

    // ── V5-1: dialog copy must show the real count, not the raw placeholder ──

    it('should pass the count param and use transloco interpolation syntax in all locales', async () => {
      await setup({ status: 'ACTIVE' });

      // The unit-test DOM cannot load translations, so assert the contract that
      // fixed V5-1 directly: every locale's dispositionDesc uses transloco's
      // `{{ count }}` interpolation (a bare `{count}` renders literally), and
      // the component actually has 2 unfinished tasks to interpolate.
      const i18nDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../../public/assets/i18n');

      for (const file of readdirSync(i18nDir)) {
        const json = JSON.parse(readFileSync(join(i18nDir, file), 'utf8')) as {
          sprintDetail: { dispositionDesc: string };
        };

        expect(file).toMatch(/\.json$/);
        expect(json.sprintDetail.dispositionDesc).toContain('{{ count }}');
        expect(json.sprintDetail.dispositionDesc).not.toMatch(/(^|[^{])\{count\}([^}]|$)/);
      }

      expect(component.unfinishedTasks().length).toBe(2);
    });
  });

  // ── removeTaskFromSprint ───────────────────────────────────────────────

  describe('removeTaskFromSprint', () => {
    beforeEach(() => setup());

    it('should call taskClient.update with sprintId null', () => {
      const task = mockSprintTasks[0];

      component.removeTaskFromSprint(task);

      expect(taskClientMock.update).toHaveBeenCalledWith(task?.id, { sprintId: null, version: task?.version });
    });

    it('should remove task from sprintTasks signal', () => {
      component.removeTaskFromSprint(mockSprintTasks[0]);

      expect(component.sprintTasks()).toHaveLength(1);
      expect(component.sprintTasks().find((t: Task) => t.id === 'tk1')).toBeUndefined();
    });
  });

  // ── Dedicated start/end date edit dialog ─────────────────────

  describe('date edit dialog (V8)', () => {
    beforeEach(() => setup());

    it('should pre-fill the date inputs from the sprint when opened', () => {
      component.openEditDates();

      expect(component.showEditDates()).toBe(true);
      expect(component.editStartDate()).toBe(NOW.slice(0, 10));
      expect(component.editEndDate()).toBe('2025-02-01');
    });

    it('should save dates via sprintClient.update with YYYY-MM-DD values and close the dialog', () => {
      component.openEditDates();
      component.editStartDate.set('2025-03-01');
      component.saveDates();

      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, {
        startDate: '2025-03-01',
        endDate: '2025-02-01',
      });
      expect(component.showEditDates()).toBe(false);
      expect(component.savingDates()).toBe(false);
    });

    it('should send null to clear an emptied date input', () => {
      component.openEditDates();
      component.editStartDate.set('');
      component.saveDates();

      expect(sprintClientMock.update).toHaveBeenCalledWith(mockSprint.id, {
        startDate: null,
        endDate: '2025-02-01',
      });
    });

    it('should update the sprint signal with the saved sprint', () => {
      const saved = { ...mockSprint, startDate: '2025-03-01T00:00:00Z' };

      sprintClientMock.update.mockReturnValue(of(saved));

      component.openEditDates();
      component.editStartDate.set('2025-03-01');
      component.saveDates();

      expect(component.sprint().startDate).toBe('2025-03-01T00:00:00Z');
    });

    it('should close the dialog when its state changes to closed', () => {
      component.openEditDates();
      component.onEditDatesDialogStateChange('closed');

      expect(component.showEditDates()).toBe(false);
    });
  });

  // ── Delete sprint ─────────────────────────────────────────────

  describe('deleteSprint', () => {
    beforeEach(() => setup());

    it('should call sprintClient.delete', () => {
      component.deleteSprint();

      expect(sprintClientMock.delete).toHaveBeenCalledWith(mockSprint.id);
    });

    it('should navigate to project after deletion', () => {
      component.deleteSprint();

      expect(routerMock.navigate).toHaveBeenCalled();
    });
  });
});
