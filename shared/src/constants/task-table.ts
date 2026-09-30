/**
 * Task-table column model.
 *
 * Single source of truth for the columns of the tasks table, shared by the
 * server (Zod validation of the persisted `taskTableColumns` preference) and
 * the UI (chooser popover, header context menu, rendering).
 *
 * `key` and `title` are identity anchors — always visible, never hideable.
 */
export const TASK_TABLE_COLUMN_KEYS = [
  'key',
  'title',
  'type',
  'status',
  'priority',
  'assignee',
  'reporter',
  'sprint',
  'labels',
  'created',
  'updated',
] as const;

export type TaskTableColumnKey = (typeof TASK_TABLE_COLUMN_KEYS)[number];

/** Columns that can never be hidden (identity anchors). */
export const TASK_TABLE_PINNED_COLUMNS: readonly TaskTableColumnKey[] = ['key', 'title'];

/** Visible set used when the persisted preference is null (default view). */
export const DEFAULT_TASK_TABLE_COLUMNS: readonly TaskTableColumnKey[] = TASK_TABLE_COLUMN_KEYS;
