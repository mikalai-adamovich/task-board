import type { TaskTableColumnKey } from '../constants/task-table.js';

/** Per-user, per-project board preference */
export interface UserProjectBoardPreference {
  /** Unique preference identifier (UUID v4) */
  id: string;
  /** User ID */
  userId: string;
  /** Project ID */
  projectId: string;
  /**
   * Visible task-table columns for this project. Null = default set.
   * `key`/`title` are always part of the effective set regardless of this value.
   */
  taskTableColumns: TaskTableColumnKey[] | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Update user project board preference request body type (partial update) */
export interface UpdateUserProjectBoardPreference {
  taskTableColumns?: TaskTableColumnKey[] | null | undefined;
}
