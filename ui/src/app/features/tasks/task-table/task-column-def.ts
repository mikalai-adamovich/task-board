import type { TaskTableColumnKey } from '@task-board/shared';
import { TASK_TABLE_PINNED_COLUMNS } from '@task-board/shared';
import type { SelectOption } from '@stores/project-ref-store';

/**
 * Column definition shared between the TaskTable composition root
 * (which owns the URL-bound filter accessors) and the TaskTableColumns UI
 * child (chooser + header context menu).
 */
export interface TaskColumnDef {
  field: string;
  /** Stable preference key shared with the server (`taskTableColumns`) */
  columnKey: TaskTableColumnKey;
  labelKey: string;
  filterType: 'none' | 'text' | 'select' | 'date';
  width?: string;
  popoverWidth?: string;
  /**
   * Round-4 F3: overlay alignment for the header filter popover. The rightmost
   * columns (Created/Updated) use `'end'` so the popover opens leftward and is
   * not clipped at the right viewport edge.
   */
  align?: 'start' | 'center' | 'end';
  getFilterValue: () => string;
  setFilterValue?: (value: string) => void;
  getOptions?: () => SelectOption[];
  /** Date-range accessors for `filterType: 'date'` columns */
  getDateFrom?: () => string;
  getDateTo?: () => string;
  /** Empty string on either side clears that bound */
  setDateRange?: (from: string, to: string) => void;
  allLabelKey?: string;
  placeholder?: string;
  staticOptions?: { value: string | number; labelKey: string }[];
  itemToString?: (value: string) => string;
}

/** Identity-anchor columns can never be hidden */
export function isPinnedColumn(columnKey: TaskTableColumnKey): boolean {
  return (TASK_TABLE_PINNED_COLUMNS as readonly string[]).includes(columnKey);
}
