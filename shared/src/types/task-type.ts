/** Task type entity type (project-level task type, e.g., Task, Bug, Story) */
export interface TaskType {
  /** Unique task type identifier (UUID v4) */
  id: string;
  /** Parent project ID */
  projectId: string;
  /** Machine-readable key (e.g., "TASK", "BUG", "STORY") — immutable after creation */
  key: string;
  /** Display name (e.g., "Task", "Bug", "Story") */
  name: string;
  /** Icon identifier or emoji */
  icon: string | null;
  /** Position/order within the project's task type list */
  position: number;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Create task type request body type */
export interface CreateTaskType {
  key: string;
  name: string;
  icon?: string | undefined;
  position: number;
}

/** Update task type request body type (key is immutable) */
export interface UpdateTaskType {
  name?: string | undefined;
  icon?: string | undefined;
  position?: number | undefined;
}
