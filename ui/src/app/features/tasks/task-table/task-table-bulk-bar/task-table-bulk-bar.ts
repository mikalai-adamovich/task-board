import { Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import type { SelectOption } from '@stores/project-ref-store';

/**
 * Q10 sentinels for the nullable bulk-select options — hlm-select values are
 * strings, so "unassign"/"clear sprint" need a non-empty marker that maps to
 * `null` in the request body (the parent translates them when applying).
 */
export const BULK_UNASSIGNED = '__unassigned__';
export const BULK_NO_SPRINT = '__no_sprint__';

/**
 * Bulk-actions bar extracted from the TaskTable composition root.
 * Presentational: the selection set, the exactly-one-field contract and the
 * API call stay in the parent; this component renders the bar and emits the
 * chosen field / actions.
 */
@Component({
  selector: 'ui-task-table-bulk-bar',
  imports: [TranslocoPipe, HlmButtonImports, HlmSelectImports],
  templateUrl: './task-table-bulk-bar.html',
})
export class TaskTableBulkBar {
  /** Number of currently selected tasks */
  readonly selectedCount = input.required<number>();
  /** Exactly one bulk field chosen and the request is not in flight */
  readonly canApply = input(false);
  readonly applying = input(false);
  /** Buffered bulk field values (empty string = untouched) */
  readonly statusValue = input('');
  readonly assigneeValue = input('');
  readonly sprintValue = input('');
  /** Reference-data options for the three selects */
  readonly statusOptions = input<SelectOption[]>([]);
  readonly memberOptions = input<SelectOption[]>([]);
  readonly sprintOptions = input<SelectOption[]>([]);
  /** V9-4: resolve the selected status id to its label for the bulk trigger */
  readonly statusItemToString = input<(id: string) => string>((id) => id);
  /** Setting one bulk field clears the others (enforced by the parent) */
  readonly statusChange = output<string>();
  readonly assigneeChange = output<string>();
  readonly sprintChange = output<string>();
  /** Apply the single chosen field to every selected task */
  readonly apply = output();
  /** Clear the whole selection */
  readonly clear = output();
}
