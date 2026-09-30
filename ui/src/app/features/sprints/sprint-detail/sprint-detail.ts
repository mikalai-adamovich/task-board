import { Component, computed, inject, input, signal, OnInit } from '@angular/core';
import { getTenantSlug } from '@app/shared/utils/route-utils';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { DatePipe } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { provideIcons } from '@ng-icons/core';
import { lucideX, lucideCalendarDays } from '@ng-icons/lucide';
import { finalize, forkJoin, of } from 'rxjs';
import { SprintClient } from '@services/sprint-client';
import { TaskClient } from '@services/task-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { ProjectRefStore } from '@stores/project-ref-store';
import { canManageProject } from '@app/shared/utils/role-utils';
import {
  PriorityDotColorMap,
  NeutralDotColor,
  priorityBadgeVariant,
  priorityLabelKey,
  type BadgeVariant,
} from '@app/constants/priority';
import { SprintStatus, type TaskPriorityLevel } from '@task-board/shared';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { NgIcon } from '@ng-icons/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { Sprint, Task } from '@task-board/shared';
import { statusBadgeVariant } from '@app/constants/priority';
import { isSprintOverdue } from '@app/shared/utils/sprint-utils';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

@Component({
  selector: 'ui-sprint-detail',
  imports: [
    ConfirmDialog,
    HlmEmptyImports,
    RouterLink,
    DatePipe,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmBadgeImports,
    HlmDialogImports,
    HlmFieldImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmTooltipImports,
  ],
  providers: [provideIcons({ lucideX, lucideCalendarDays })],
  templateUrl: './sprint-detail.html',
})
export class SprintDetail implements OnInit {
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  private readonly i18n = inject(TranslocoService);
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
  private readonly refStore = inject(ProjectRefStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Bound via withComponentInputBinding() */
  readonly sprintId = input.required<string>();
  private readonly sprint = signal<Sprint | null>(null);
  private readonly tenantSlug = signal<string>('');
  /** Project key of the active project (canonical task URLs, DEC-032) */
  protected readonly projectKey = computed(() => this.projectStore.activeProject()?.key ?? '');
  /** Resolved project UUID — reference-data key for statuses/sprints */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  private readonly sprintTasks = signal<Task[]>([]);
  private readonly loading = signal(true);
  private readonly showDeleteConfirm = signal(false);
  // ─── V8 gap: dedicated start/end date edit dialog ──────────────────────────
  private readonly showEditDates = signal(false);
  /** `YYYY-MM-DD` buffers for the two date inputs (pre-filled from the sprint) */
  private readonly editStartDate = signal('');
  private readonly editEndDate = signal('');
  private readonly savingDates = signal(false);
  // ─── V1-7: completion disposition ─────────────────────────────────────────
  /**
   * Future sprints offered as "Move to…" targets when completing with
   * unfinished tasks. F2: derived from the shared ProjectRefStore cache.
   */
  protected readonly futureSprints = computed(() =>
    this.refStore.sprintEntities(this.projectId()).filter((sp) => sp.status === SprintStatus.FUTURE),
  );
  private readonly showDispositionDialog = signal(false);
  /** `''` = Move to Backlog (default); otherwise the target sprint id. */
  private readonly dispositionTarget = signal('');
  private readonly completing = signal(false);
  protected readonly canManage = computed(() => {
    return canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole());
  });

  protected getPriorityDot(priorityLevel: TaskPriorityLevel): string {
    return PriorityDotColorMap[priorityLevel] ?? NeutralDotColor;
  }

  protected getPriorityBadge(priorityLevel: TaskPriorityLevel): BadgeVariant {
    return priorityBadgeVariant(priorityLevel);
  }

  /** Translated display label instead of the raw enum value; unknown values render verbatim. */
  protected getPriorityLabel(priorityLevel: TaskPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.i18n.translate(key) : String(priorityLevel);
  }

  /** Get available status transitions for the current sprint */
  protected get availableTransitions(): { label: string; status: SprintStatus }[] {
    const s = this.sprint();

    if (!s) return [];

    switch (s.status) {
      case SprintStatus.FUTURE:
        return [{ label: 'Start Sprint', status: SprintStatus.ACTIVE }];

      case SprintStatus.ACTIVE:
        return [{ label: 'Complete Sprint', status: SprintStatus.COMPLETED }];

      case SprintStatus.COMPLETED:
        return [{ label: 'Reopen Sprint', status: SprintStatus.ACTIVE }];

      default:
        return [];
    }
  }

  /** Statuses considered final ("DONE") for the active project — from reference data. */
  private readonly finalStatusIds = computed(() => {
    const done = new Set<string>();

    for (const option of this.refStore.options(this.projectId(), 'statuses')) {
      if (option.name.trim().toUpperCase() === 'DONE') done.add(option.id);
    }

    return done;
  });
  /** V1-7: sprint tasks whose status is not the project's final/DONE status. */
  private readonly unfinishedTasks = computed(() =>
    this.sprintTasks().filter((task) => !this.finalStatusIds().has(task.statusId)),
  );

  protected transitionSprint(newStatus: SprintStatus): void {
    const s = this.sprint();

    if (!s) return;

    // V1-7: completing with unfinished tasks requires a disposition decision first
    if (newStatus === SprintStatus.COMPLETED && this.unfinishedTasks().length > 0) {
      this.dispositionTarget.set('');
      this.showDispositionDialog.set(true);

      return;
    }

    // V4-11: every other transition (Start/Reopen/Complete-without-unfinished)
    // PATCHes exactly the requested status — never hardcoded COMPLETED
    this.applyTransition(newStatus);
  }

  /**
   * V4-11: PATCH the sprint to `status`.
   * Only the COMPLETED transition bulk-moves unfinished tasks first
   * (to the chosen disposition target, `''` = backlog).
   */
  private applyTransition(status: SprintStatus): void {
    const s = this.sprint();

    if (!s || this.completing()) return;

    this.completing.set(true);

    const unfinished = this.unfinishedTasks();
    const moves$ =
      status === SprintStatus.COMPLETED && unfinished.length > 0
        ? forkJoin(
            unfinished.map((task) =>
              this.taskClient.update(task.id, {
                sprintId: this.dispositionTarget() || null,
                version: task.version,
              }),
            ),
          )
        : of([]);

    moves$.pipe(finalize(() => this.completing.set(false))).subscribe({
      next: () => {
        this.showDispositionDialog.set(false);
        this.sprintClient.update(s.id, { status }).subscribe({
          next: (sprint) => {
            this.sprint.set(sprint);
            // Keep the shared reference-data cache in sync
            this.refStore.upsertEntity(s.projectId, 'sprints', sprint);
            this.loadSprintTasks(s.projectId); // reflect the moves in the task list
          },
          error: (err) => {
            this.notify.error(getErrorMessage(err));
          },
        });
      },
      error: (err) => {
        this.notify.error(getErrorMessage(err));
      },
    });
  }

  /** V1-7: confirm-button handler of the disposition dialog — always completes. */
  protected completeSprint(): void {
    this.applyTransition(SprintStatus.COMPLETED);
  }

  protected onDispositionDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showDispositionDialog.set(false);
    }
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteConfirm.set(false);
    }
  }

  /** Open the date-edit dialog pre-filled with the sprint's current dates */
  protected openEditDates(): void {
    const s = this.sprint();

    if (!s) return;

    this.editStartDate.set(s.startDate ? s.startDate.slice(0, 10) : '');
    this.editEndDate.set(s.endDate ? s.endDate.slice(0, 10) : '');
    this.showEditDates.set(true);
  }

  /**
   * Save the edited dates via SprintClient.update. Values are plain
   * `YYYY-MM-DD` strings (server slices to 10 chars — V7-7); an empty input
   * sends `null` to clear the date.
   */
  protected saveDates(): void {
    const s = this.sprint();

    if (!s || this.savingDates()) return;

    this.savingDates.set(true);
    this.sprintClient
      .update(s.id, {
        startDate: this.editStartDate() || null,
        endDate: this.editEndDate() || null,
      })
      .subscribe({
        next: (updated) => {
          this.savingDates.set(false);
          this.sprint.set(updated);
          // Keep the shared reference-data cache in sync
          this.refStore.upsertEntity(updated.projectId, 'sprints', updated);
          this.showEditDates.set(false);
          this.notify.success('toasts.updated');
        },
        error: (err) => {
          this.savingDates.set(false);
          this.notify.error(getErrorMessage(err));
        },
      });
  }

  protected onEditDatesDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showEditDates.set(false);
    }
  }

  protected deleteSprint(): void {
    const s = this.sprint();

    if (!s) return;

    this.sprintClient.delete(s.id).subscribe({
      next: () => {
        // Drop the deleted sprint from the shared reference-data cache
        this.refStore.invalidate(s.projectId, 'sprints');

        const projectKey = this.projectStore.activeProject()?.key ?? s.projectId;

        this.router.navigate(['/w', getTenantSlug(this.route), 'projects', projectKey]);
      },
      error: (err) => this.notify.error(getErrorMessage(err)),
    });
  }

  /** Canonical task URL segment `KEY-NUMBER` for a sprint task */
  protected taskNumber(task: Task): string {
    const key = this.projectStore.activeProject()?.key ?? '';

    return `${key}-${task.number}`;
  }

  ngOnInit(): void {
    this.tenantSlug.set(getTenantSlug(this.route));
    this.loadSprint();
  }

  private loadSprint(): void {
    this.loading.set(true);
    this.sprintClient
      .getById(this.sprintId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (sprint) => {
          this.sprint.set(sprint);
          this.loadSprintTasks(sprint.projectId);
        },
        error: (err) => this.notify.error(getErrorMessage(err)),
      });
  }

  private loadSprintTasks(projectId: string): void {
    // V1-7: statuses reference data drives the final/DONE detection
    this.refStore.ensure(projectId, ['statuses', 'sprints']);
    // The sprint task list never renders the description — omit it from the payload
    this.taskClient.list(projectId, { sprintId: this.sprintId(), limit: 200, excludeDescription: true }).subscribe({
      next: (res) => this.sprintTasks.set(res.data),
      error: (err) => this.notify.error(getErrorMessage(err)),
    });
    // Future sprints (the "Move to…" targets of the disposition dialog)
    // are derived from the shared ProjectRefStore cache — ensure() above
    // loads them; no separate request needed.
  }

  protected removeTaskFromSprint(task: Task): void {
    this.taskClient.update(task.id, { sprintId: null, version: task.version }).subscribe({
      next: () => {
        this.sprintTasks.update((list) => list.filter((t) => t.id !== task.id));
      },
    });
  }
}
