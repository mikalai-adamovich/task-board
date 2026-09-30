import { Component, computed, effect, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideCalendar,
  lucideCircleDot,
  lucideExternalLink,
  lucideSettings,
  lucideTrash2,
  lucideUsers,
} from '@ng-icons/lucide';
import { rxResource } from '@angular/core/rxjs-interop';
import { map, of } from 'rxjs';
import { TaskClient } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { PreferencesStore } from '@stores/preferences-store';
import { TenantStore } from '@stores/tenant-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { SprintStatus, ProjectStatus } from '@task-board/shared';
import { statusBadgeVariant } from '@app/constants/priority';
import { canManageProject } from '@app/shared/utils/role-utils';
import type { Status, Task } from '@task-board/shared';

/** Per-status task count row */
interface StatusCount {
  status: Status;
  total: number;
}

/**
 * Project overview landing page (spec S9, DEC-034).
 *
 * Widgets: header (name/key/status/description), task summary by status,
 * active-sprint block, recent tasks, members preview, board shortcuts.
 * Lifecycle actions (archive/delete) live in the settings hub danger zone.
 */
@Component({
  selector: 'ui-project-detail',
  imports: [
    RouterLink,
    DatePipe,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmBadgeImports,
    HlmCardImports,
    HlmEmptyImports,
    HlmAlertImports,
  ],
  providers: [
    provideIcons({
      lucideArchive,
      lucideCalendar,
      lucideCircleDot,
      lucideExternalLink,
      lucideSettings,
      lucideTrash2,
      lucideUsers,
    }),
  ],
  templateUrl: './project-detail.html',
})
export class ProjectDetail {
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  private readonly taskClient = inject(TaskClient);
  private readonly refStore = inject(ProjectRefStore);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly preferencesStore = inject(PreferencesStore);
  /** DatePipe token derived from the user's date format preference */
  protected readonly dateFmt = this.preferencesStore.datePipeFormat;
  /** Active language passed as the DatePipe locale for localized month names */
  protected readonly lang = this.preferencesStore.language;
  private readonly tenantStore = inject(TenantStore);

  constructor() {
    // Load sprints + statuses through the shared ProjectRefStore cache.
    // Reading the entity lists keeps the effect reactive — after an
    // invalidate() (status/sprint mutations elsewhere) the effect re-runs.
    effect(() => {
      const pid = this.projectId();

      if (!pid) return;

      this.refStore.sprintEntities(pid);
      this.refStore.statusEntities(pid);
      this.refStore.ensure(pid, ['sprints', 'statuses']);
    });
  }
  /** Bound via withComponentInputBinding() — receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /** Current tenant slug for building links */
  protected readonly tenantSlug = computed(() => this.tenantStore.activeTenant()?.slug ?? '');
  protected readonly ProjectStatus = ProjectStatus;
  protected readonly SprintStatus = SprintStatus;
  // The project itself is NOT re-fetched here — projectGuard already loaded
  // it via /projects/by-key/:key into ProjectStore.activeProject() before this
  // component activates, and mutations (settings/danger zone) update the store
  // in place. A duplicate GET /projects/:projectId would only add latency.
  private readonly project = computed(() => this.projectStore.activeProject());
  // Single-board model (doc 102): no board-list fetch — the project has one board.
  // Sprints + statuses come from the SHARED ProjectRefStore cache (same data
  // as the board/tasks pages — no per-page duplicate requests).
  private readonly sprints = computed(() => this.refStore.sprintEntities(this.projectId()));
  protected readonly activeSprint = computed(
    () => this.sprints().find((s) => s.status === SprintStatus.ACTIVE) ?? null,
  );
  private readonly statuses = computed(() => this.refStore.statusEntities(this.projectId()));
  /**
   * One status-summary request (server-side $group aggregation) instead
   * of one list request per status; counts are joined with the statuses in code.
   */
  // Both project-scoped resources below short-circuit on a blank projectId
  // (the store is briefly empty between the guard resolving and the first
  // render). Without the guard they fired `GET /projects//…`.
  private readonly statusSummaryResource = rxResource({
    params: () => ({ projectId: this.projectId() }),
    stream: ({ params }) =>
      params.projectId
        ? this.taskClient.statusSummary(params.projectId)
        : of([] as { statusId: string; count: number }[]),
    defaultValue: [] as { statusId: string; count: number }[],
  });
  private readonly statusCounts = computed<StatusCount[]>(() => {
    if (!this.statusSummaryResource.hasValue()) return [];

    const counts = new Map(this.statusSummaryResource.value().map((row) => [row.statusId, row.count]));

    return this.statuses().map((status) => ({ status, total: counts.get(status.id) ?? 0 }));
  });
  protected readonly totalTasks = computed(() => this.statusCounts().reduce((sum, entry) => sum + entry.total, 0));
  private readonly recentTasksResource = rxResource({
    params: () => ({ projectId: this.projectId() }),
    stream: ({ params }) =>
      // Recent tasks never render the description — omit it from the payload
      params.projectId
        ? this.taskClient
            .list(params.projectId, { limit: 5, sort: 'updatedAt:desc', excludeDescription: true })
            .pipe(map((res) => res.data))
        : of([] as Task[]),
    defaultValue: [] as Task[],
  });
  protected readonly recentTasks = computed(() =>
    this.recentTasksResource.hasValue() ? this.recentTasksResource.value() : [],
  );
  // The guard resolves the project BEFORE the component activates, so there is
  // no in-component loading state; the spinner branch only covers the edge case
  // of the store being cleared while the component is alive (e.g. logout race).
  protected readonly loading = computed(() => !this.projectStore.hasProject());
  /** Members preview comes from the project context store (loaded by projectGuard) */
  private readonly membersPreview = computed(() => this.projectStore.members().slice(0, 5));
  protected readonly extraMembersCount = computed(() =>
    Math.max(this.projectStore.members().length - this.membersPreview().length, 0),
  );
  /**
   * Whether the current user can manage project settings (PROJECT_ADMIN+).
   * Tenant OWNER/ADMIN bypass project role checks.
   */
  protected readonly isAdmin = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** Read-only banner shown for archived / deletion-pending projects */
  protected readonly readOnlyBannerKey = computed(() => {
    const status = this.project()?.status;

    if (status === ProjectStatus.ARCHIVED) return 'projectDetail.archivedBanner';
    if (status === ProjectStatus.DELETION_PENDING) return 'projectDetail.deletionPendingBanner';

    return '';
  });

  protected memberInitials(name: string | undefined, email: string | undefined): string {
    const source = name || email || '?';
    const parts = source.trim().split(/\s+/);

    return parts.length > 1
      ? ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase()
      : source.slice(0, 2).toUpperCase();
  }
}
