/**
 * Tests for the ProjectDetail overview (spec S9, DEC-034).
 *
 * Covers:
 * - Project from ProjectStore (guard-loaded; NO duplicate getById request — F1)
 * - Loading sprints/statuses/summary/recent-tasks resources
 * - Active-sprint computed
 * - Status-count computation from per-status totals
 * - Recent-tasks selection
 * - Read-only banner keys for archived / deletion-pending projects
 * - isAdmin computed signal
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom, of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { ProjectDetail } from './project-detail';
import { ProjectClient } from '@services/project-client';
import { SprintClient } from '@services/sprint-client';
import { StatusClient } from '@services/status-client';
import { TaskClient } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { TenantStore } from '@stores/tenant-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Project, Sprint, Status, Task } from '@task-board/shared';
import { settle } from '@app/shared/testing/zoneless';

const NOW = '2025-01-01T00:00:00Z';
const mockProject: Project = {
  id: 'p0000000-0000-0000-0000-000000000001',
  tenantId: 't0000000-0000-0000-0000-000000000001',
  key: 'TP',
  name: 'Test Project',
  description: 'A project for testing',
  status: 'ACTIVE',
  defaultStatusId: 's1',
  archiveReason: null,
  deletionScheduledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const mockSprints: Sprint[] = [
  {
    id: 'sp1',
    projectId: mockProject.id,
    name: 'Sprint 1',
    status: 'ACTIVE',
    startDate: '2025-01-01',
    endDate: '2025-01-14',
    createdAt: NOW,
    updatedAt: NOW,
  },
];
const mockStatuses: Status[] = [
  {
    id: 's1',
    projectId: mockProject.id,
    name: 'TODO',
    normalizedName: 'todo',
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 's2',
    projectId: mockProject.id,
    name: 'DONE',
    normalizedName: 'done',
    position: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function makeTask(number_: number): Task {
  return {
    id: `task-${number_}`,
    projectId: mockProject.id,
    number: number_,
    typeId: 't1',
    title: `Task ${number_}`,
    description: null,
    statusId: 's1',
    priorityLevel: 1,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'User One' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const mockRecentTasks = [makeTask(3), makeTask(2), makeTask(1)];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let component: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fixture: any;
let projectClientMock: Record<string, ReturnType<typeof vi.fn>>;
let sprintClientMock: Record<string, ReturnType<typeof vi.fn>>;
let statusClientMock: Record<string, ReturnType<typeof vi.fn>>;
let taskClientMock: Record<string, ReturnType<typeof vi.fn>>;

function paginated(data: unknown[], total = data.length) {
  return of({ data, pagination: { page: 1, limit: 30, total, totalPages: 1 } });
}

/** Poll until the condition holds (async resources resolve on microtasks/timers) */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settle(fixture);
}

async function setup(
  options: {
    tenantRole?: string;
    projectStatus?: Project['status'];
    withoutProject?: boolean;
    statusSummaryError?: number;
  } = {},
) {
  // `withoutProject` reproduces the window before the guard-loaded project
  // reaches the store (projectId === ''), which is what the blank-param guards
  // in the two task resources protect against.
  const project: Project | null = options.withoutProject
    ? null
    : { ...mockProject, status: options.projectStatus ?? mockProject.status };

  // The overview does NOT fetch the project itself — getById is asserted
  // to stay untouched; the store (fed by projectGuard) is the single source.
  projectClientMock = { getById: vi.fn().mockReturnValue(of(project)) };
  sprintClientMock = { list: vi.fn().mockReturnValue(of(mockSprints)) };
  statusClientMock = { list: vi.fn().mockReturnValue(of(mockStatuses)) };
  taskClientMock = {
    list: vi.fn((_projectId: string, query: Record<string, unknown> = {}) => {
      if (query.limit === 5) return paginated(mockRecentTasks);

      return paginated([]);
    }),
    // Per-status counts now come from one status-summary request
    statusSummary: vi.fn().mockReturnValue(
      of([
        { statusId: 's1', count: 5 },
        { statusId: 's2', count: 2 },
      ]),
    ),
  };

  // The status-summary aggregation is one of the endpoints most likely to
  // fail for a member without project access (403), and a 500 for anything else.
  // Both must leave the page rendering, not throw inside a computed.
  const statusSummaryError = options.statusSummaryError ?? 0;

  if (statusSummaryError > 0) {
    taskClientMock.statusSummary = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: statusSummaryError,
            statusText: 'Failed',
            error: { error: { code: 'FORBIDDEN', message: 'nope' } },
          }),
      ),
    );
  }

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      { provide: ProjectClient, useValue: projectClientMock },
      { provide: SprintClient, useValue: sprintClientMock },
      { provide: StatusClient, useValue: statusClientMock },
      { provide: TaskClient, useValue: taskClientMock },
      { provide: AuthStore, useValue: { tenantRole: vi.fn().mockReturnValue(options.tenantRole ?? 'OWNER') } },
      // Format tokens consumed by recent tasks / sprint dates
      {
        provide: PreferencesStore,
        useValue: {
          datePipeFormat: () => 'yyyy-MM-dd',
          dateTimePipeFormat: () => 'yyyy-MM-dd HH:mm',
          // Active language used as the DatePipe locale
          language: () => 'en',
        },
      },
      {
        provide: ProjectStore,
        useValue: {
          activeProject: vi.fn().mockReturnValue(project),
          hasProject: vi.fn().mockReturnValue(true),
          projectRole: vi.fn().mockReturnValue(null),
          members: vi.fn().mockReturnValue([
            { userId: 'u1', role: 'PROJECT_ADMIN', displayName: 'Ada Lovelace' },
            { userId: 'u2', role: 'EDITOR', email: 'bob@example.com' },
          ]),
        },
      },
      { provide: TenantStore, useValue: { activeTenant: vi.fn().mockReturnValue({ slug: 'ws' }) } },
    ],
  });
  await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

  fixture = TestBed.createComponent(ProjectDetail);
  fixture.componentRef.setInput('projectKey', mockProject.key);
  component = fixture.componentInstance;
  await settle(fixture);
}

describe('ProjectDetail (overview)', () => {
  // `projectId` is blank until the guard-loaded project reaches the store.
  // The status-summary and recent-tasks resources used to run their streams in
  // that window, i.e. `statusSummary('')` and `list('', { limit: 5 })`.
  it('should NOT request status summary or recent tasks while the project is unresolved (F21)', async () => {
    await setup({ withoutProject: true });
    await settle(fixture);

    expect(taskClientMock.statusSummary).not.toHaveBeenCalled();
    expect(taskClientMock.list).not.toHaveBeenCalled();
    expect(component.statusCounts()).toEqual([]);
    expect(component.recentTasks()).toEqual([]);
  });

  it('should use the guard-loaded project from ProjectStore WITHOUT a duplicate getById request (F1)', async () => {
    await setup();
    await until(() => component.project() !== null);

    expect(projectClientMock.getById).not.toHaveBeenCalled();
    expect(component.project()?.name).toBe('Test Project');
    // The loading state resolves from the store (guard already resolved it)
    expect(component.loading()).toBe(false);
  });

  it('should expose the ACTIVE sprint', async () => {
    await setup();
    await until(() => component.activeSprint() !== null);

    expect(sprintClientMock.list).toHaveBeenCalledWith(mockProject.id);
    expect(component.activeSprint()?.name).toBe('Sprint 1');
  });

  // Reading `.value()` of an errored resource throws. A 403/500 on the
  // status-summary aggregation must degrade to "no counts", never to a thrown
  // computed — the guard is the property, the status is an input.
  for (const status of [403, 500]) {
    it(`should not throw when the status-summary request fails with ${status} (D-39)`, async () => {
      await setup({ statusSummaryError: status });
      await until(() => component.project() !== null);
      await settle(fixture);

      expect(() => component.statusCounts()).not.toThrow();
      expect(component.statusCounts()).toEqual([]);
      expect(component.totalTasks()).toBe(0);
    });
  }

  it('should compute per-status totals from the status-summary endpoint (S-05)', async () => {
    await setup();
    await until(() => component.statusCounts().length > 0);

    expect(taskClientMock.statusSummary).toHaveBeenCalledWith(mockProject.id);
    expect(component.statusCounts()).toEqual([
      { status: mockStatuses[0], total: 5 },
      { status: mockStatuses[1], total: 2 },
    ]);
    expect(component.totalTasks()).toBe(7);
  });

  it('should load recent tasks sorted by updatedAt desc', async () => {
    await setup();
    await until(() => component.recentTasks().length > 0);

    expect(taskClientMock.list).toHaveBeenCalledWith(mockProject.id, {
      limit: 5,
      sort: 'updatedAt:desc',
      excludeDescription: true,
    });
    expect(component.recentTasks()).toEqual(mockRecentTasks);
  });

  it('should show a read-only banner for archived projects', async () => {
    await setup({ projectStatus: 'ARCHIVED' });
    await until(() => component.project() !== null);

    expect(component.readOnlyBannerKey()).toBe('projectDetail.archivedBanner');
  });

  it('should show a read-only banner for deletion-pending projects', async () => {
    await setup({ projectStatus: 'DELETION_PENDING' });
    await until(() => component.project() !== null);

    expect(component.readOnlyBannerKey()).toBe('projectDetail.deletionPendingBanner');
  });

  it('should not show a banner for active projects', async () => {
    await setup();
    await until(() => component.project() !== null);

    expect(component.readOnlyBannerKey()).toBe('');
  });

  describe('isAdmin', () => {
    it('should be true for tenant OWNER', async () => {
      await setup({ tenantRole: 'OWNER' });
      await until(() => component.project() !== null);

      expect(component.isAdmin()).toBe(true);
    });

    it('should be false for tenant MEMBER without project role', async () => {
      await setup({ tenantRole: 'MEMBER' });
      await until(() => component.project() !== null);

      expect(component.isAdmin()).toBe(false);
    });
  });

  it('should build member initials from display name or email', async () => {
    await setup();
    await until(() => component.project() !== null);

    expect(component.memberInitials('Ada Lovelace', undefined)).toBe('AL');
    expect(component.memberInitials(undefined, 'bob@example.com')).toBe('BO');
    expect(component.memberInitials(undefined, undefined)).toBe('?');
  });

  // ── Round 5: equal-height overview cards ─────────────────────

  it('should render equal-height overview cards (items-stretch grid + h-full cards)', async () => {
    await setup();
    await until(() => component.project() !== null);

    const el: HTMLElement = fixture.nativeElement;
    const grid = el.querySelector('div.grid.items-stretch');

    expect(grid).not.toBeNull();

    const cards = el.querySelectorAll('hlm-card');

    expect(cards.length).toBe(4);
    cards.forEach((card) => expect(card.classList.contains('h-full')).toBe(true));
  });
});
