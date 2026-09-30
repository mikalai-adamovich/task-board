import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons } from '@ng-icons/core';
import { lucidePlus, lucideCalendar, lucideChevronRight, lucideChevronsUpDown, lucideInbox } from '@ng-icons/lucide';
import { rxResource } from '@angular/core/rxjs-interop';
import { map, of } from 'rxjs';
import { SprintClient } from '@services/sprint-client';
import { TaskClient } from '@services/task-client';
import { isSprintOverdue } from '@app/shared/utils/sprint-utils';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { PreferencesStore } from '@stores/preferences-store';
import { TenantStore } from '@stores/tenant-store';
import { statusBadgeVariant } from '@app/constants/priority';
import { SprintStatus } from '@task-board/shared';
import { canManageProject } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { HlmCollapsibleImports } from '@spartan-ng/helm/collapsible';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { NgIcon } from '@ng-icons/core';
import { form, FormField, FormRoot, schema, required } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import type { Sprint } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';

export interface CreateSprintForm {
  name: string;
  startDate: string;
  endDate: string;
}

interface SprintGroup {
  label: string;
  labelKey: string;
  sprints: Sprint[];
}

@Component({
  selector: 'ui-sprint-list',
  imports: [
    FieldControl,
    HlmAlertImports,
    HlmEmptyImports,
    RouterLink,
    DatePipe,
    TranslocoPipe,
    FormField,
    FormRoot,
    NgIcon,
    HlmButtonImports,
    HlmDialogImports,
    HlmSpinnerImports,
    HlmFieldImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmCollapsibleImports,
    HlmBadgeImports,
    HlmTooltipImports,
  ],
  providers: [provideIcons({ lucidePlus, lucideCalendar, lucideChevronRight, lucideChevronsUpDown, lucideInbox })],
  templateUrl: './sprint-list.html',
})
export class SprintList {
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  /** Visual-only overdue flag */
  protected readonly isSprintOverdue = isSprintOverdue;
  private readonly notify = injectToasts();
  private readonly preferencesStore = inject(PreferencesStore);
  /** DatePipe token derived from the user's date format preference */
  protected readonly dateFmt = this.preferencesStore.datePipeFormat;
  /** Active language passed as the DatePipe locale for localized month names */
  protected readonly lang = this.preferencesStore.language;
  private readonly sprintClient = inject(SprintClient);
  private readonly taskClient = inject(TaskClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly tenantStore = inject(TenantStore);
  /** Shared ProjectRefStore cache — sprints are shared with board/overview */
  private readonly refStore = inject(ProjectRefStore);
  /** Current tenant slug for building sprint-detail links */
  protected readonly tenantSlug = computed(() => this.tenantStore.activeTenant()?.slug ?? '');
  /** Bound via withComponentInputBinding() — now receives project key from route */
  readonly projectKey = input<string>('');
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  // The sprint list comes from the shared ProjectRefStore cache
  private readonly sprints = computed(() => this.refStore.sprintEntities(this.projectId()));

  constructor() {
    // Kick off the sprint fetch EAGERLY (like the previous rxResource did)
    // so the first render already has data loading without waiting for the
    // first effect flush.
    const initialPid = this.projectId();

    if (initialPid) this.refStore.ensure(initialPid, ['sprints']);

    // Reactive ensure: reading entities keeps the effect tracking the cache —
    // after an invalidate() (sprint mutations elsewhere) it re-runs/refetches.
    effect(() => {
      const pid = this.projectId();

      if (!pid) return;

      this.refStore.sprintEntities(pid);
      this.refStore.ensure(pid, ['sprints']);
    });
  }
  /**
   * Number of unassigned (backlog) tasks — powers the Backlog group count.
   * `hasSprint: false` is the server-side "no sprint" filter. Passing
   * `sprintId: null` (the pre-F7 call) only meant "no sprint filtering", so the
   * counter showed ALL project tasks instead of the backlog ones.
   */
  // No request while the project id is blank (the store resolves
  // asynchronously) — it would hit `/projects//tasks`.
  private readonly backlogCountResource = rxResource<number, { projectId: string }>({
    params: () => ({ projectId: this.projectId() ?? '' }),
    stream: ({ params }) =>
      params.projectId
        ? this.taskClient
            .list(params.projectId, { hasSprint: false, limit: 1 })
            .pipe(map((res) => res.pagination.total))
        : of(0),
    defaultValue: 0,
  });
  protected readonly backlogCount = computed(() =>
    this.backlogCountResource.hasValue() ? this.backlogCountResource.value() : 0,
  );
  protected readonly loading = computed(() => this.refStore.isLoading(this.projectId(), 'sprints'));
  private readonly actionError = signal('');
  protected readonly error = computed(() => this.actionError());
  private readonly showCreateModal = signal(false);
  private readonly expandedGroups = signal<Record<string, boolean>>({});
  private readonly model = signal<CreateSprintForm>({
    name: '',
    startDate: '',
    endDate: '',
  });
  protected readonly newSprintForm = form(
    this.model,
    schema<CreateSprintForm>((field) => {
      required(field.name, { message: 'validation.nameRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          this.actionError.set('');

          const m = this.model();

          this.sprintClient
            .create(this.projectId() ?? '', {
              name: m.name,
              startDate: m.startDate ? new Date(m.startDate).toISOString() : undefined,
              endDate: m.endDate ? new Date(m.endDate).toISOString() : undefined,
            })
            .subscribe({
              next: (sprint) => {
                // Patch the SHARED cache — board/overview see the new sprint
                // immediately without any extra GET.
                this.refStore.upsertEntity(this.projectId(), 'sprints', sprint);
                this.showCreateModal.set(false);
                f().reset({ name: '', startDate: '', endDate: '' });
                this.notify.success('toasts.created');
              },
              error: (err) => {
                this.actionError.set(getErrorMessage(err));
              },
            });
        },
      },
    },
  );
  /** Group sprints by status: Active, Future, Completed */
  protected readonly sprintGroups = computed<SprintGroup[]>(() => {
    const allSprints = this.sprints();
    const active = allSprints.filter((s) => s.status === SprintStatus.ACTIVE);
    const future = allSprints.filter((s) => s.status === SprintStatus.FUTURE);
    const completed = allSprints.filter((s) => s.status === SprintStatus.COMPLETED);
    const groups: SprintGroup[] = [];

    if (active.length > 0) {
      groups.push({ label: 'Active', labelKey: 'sprints.active', sprints: active });
    }
    if (future.length > 0) {
      groups.push({ label: 'Future', labelKey: 'sprints.future', sprints: future });
    }
    if (completed.length > 0) {
      groups.push({ label: 'Completed', labelKey: 'sprints.completed', sprints: completed });
    }

    return groups;
  });
  protected readonly canCreate = computed(() => {
    return canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole());
  });

  protected isGroupExpanded(groupKey: string): boolean {
    return this.expandedGroups()[groupKey] ?? true;
  }

  protected toggleGroup(groupKey: string): void {
    this.expandedGroups.update((groups) => ({
      ...groups,
      [groupKey]: !groups[groupKey],
    }));
  }

  protected onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showCreateModal.set(false);
    }
  }
}
