import { Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFilter, lucideRows3 } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';

/**
 * Toolbar extracted from the TaskTable composition root — title,
 * debounced search input (`data-task-table-search` is the `/` keyboard-shortcut
 * focus target), filters button, density toggle and the New Task control.
 * Presentational: the search buffer/debounce, density preference and navigation
 * stay in the parent. The column-chooser child is projected via <ng-content />
 * so the toolbar layout is unchanged.
 */
@Component({
  selector: 'ui-task-table-header',
  imports: [TranslocoPipe, NgIcon, HlmButtonImports, HlmInputImports, HlmTooltipImports],
  providers: [provideIcons({ lucideFilter, lucideRows3 })],
  templateUrl: './task-table-header.html',
})
export class TaskTableHeader {
  /** Buffered search text (committed to the URL by the parent after debounce) */
  readonly searchValue = input('');
  /** Device-local table density — compact mode label flips */
  readonly isCompact = input(false);
  /** V2-10: the New Task control is hidden from VIEWER-role users */
  readonly canCreateTasks = input(false);
  /** Raw input event — the parent owns the debounce + URL commit */
  readonly searchInput = output<Event>();
  readonly openFilters = output();
  readonly toggleDensity = output();
  readonly createTask = output();
}
