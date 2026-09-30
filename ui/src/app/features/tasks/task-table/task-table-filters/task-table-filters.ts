import { Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { FilterPanel, AppliedFilterState } from '@features/filters/filter-panel/filter-panel';
import type { FilterCriteria, FilterSort } from '@task-board/shared';

/** Shape of one removable active-filter chip */
export interface TaskTableFilterChip {
  param: string;
  labelKey: string;
  value: string;
}

/**
 * Filter UI extracted from the TaskTable composition root —
 * the saved-filters dialog and the active-filter chips row. Purely
 * presentational: the URL-bound filter state and the patchParams data flow
 * stay in the parent (`TaskTable`); this component renders and emits.
 */
@Component({
  selector: 'ui-task-table-filters',
  imports: [TranslocoPipe, NgIcon, HlmButtonImports, HlmBadgeImports, HlmDialogImports, HlmTooltipImports, FilterPanel],
  providers: [provideIcons({ lucideX })],
  templateUrl: './task-table-filters.html',
})
export class TaskTableFilters {
  /** Whether the saved-filters dialog is open (state owned by the parent) */
  readonly dialogOpen = input(false);
  readonly projectId = input.required<string>();
  readonly currentFilters = input<FilterCriteria>({});
  readonly currentSort = input<FilterSort>({ field: 'createdAt', direction: 'desc' });
  /** Active filters as removable chips rendered above the table */
  readonly chips = input<TaskTableFilterChip[]>([]);
  /** Mirrors the dialog's open state up so the parent signal stays the source of truth */
  readonly dialogOpenChange = output<boolean>();
  /** Remove a single active filter via its chip's × button */
  readonly removeFilter = output<string>();
  /** A saved filter was applied inside the dialog */
  readonly filterApplied = output<AppliedFilterState>();
}
