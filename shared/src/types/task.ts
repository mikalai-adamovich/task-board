import type { TaskPriorityLevel } from '../constants/priority.js';
import type { IdentitySnapshot } from './tenant.js';

/** Task entity type */
export interface Task {
  /** Unique task identifier (UUID v4) */
  id: string;
  /** Parent project ID */
  projectId: string;
  /** Sequential task number within the project */
  number: number;
  /** Task type ID (references TaskType) */
  typeId: string;
  /** Task title */
  title: string;
  /** Optional detailed description (markdown) */
  description: string | null;
  /** Status ID (references Status) */
  statusId: string;
  /** Task priority level (position in TASK_PRIORITY_CONFIG) */
  priorityLevel: TaskPriorityLevel;
  /** User ID of the reporter */
  reporterId: string | null;
  /** Denormalized reporter identity at time of assignment */
  reporterSnapshot: IdentitySnapshot | null;
  /** User ID of the assignee */
  assigneeId: string | null;
  /** Denormalized assignee identity at time of assignment */
  assigneeSnapshot: IdentitySnapshot | null;
  /** Optional sprint assignment (null if in backlog) */
  sprintId: string | null;
  /**
   * Denormalized status name — sort-only display field kept in
   * sync with statuses.name by the server (rename/delete fan-out). Consumers
   * still resolve display names via the reference-data store. Optional:
   * list DTOs with field projections may omit it.
   */
  statusName?: string | null | undefined;
  /** Denormalized sprint name — same sync contract as statusName. */
  sprintName?: string | null | undefined;
  /** Label IDs attached to this task */
  labelIds: string[];
  /** User ID of the task creator */
  createdById: string;
  /** Denormalized creator identity at time of creation */
  createdBySnapshot: IdentitySnapshot;
  /** Optimistic concurrency version */
  version: number;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * Lightweight task projection for board cards (`view=board` list responses).
 * Contains exactly the fields the board UI reads for rendering, grouping,
 * filtering and drag-and-drop (optimistic `version`) — no description,
 * reporter, audit/timestamp or other detail fields (those live on the task
 * detail / task-table payloads).
 */
export interface BoardTask {
  /** Unique task identifier (UUID v4) */
  id: string;
  /** Sequential task number within the project */
  number: number;
  /** Task title */
  title: string;
  /** Task type ID — card renders the type name via the reference-data store */
  typeId: string;
  /** Status ID — board column grouping / drag-and-drop */
  statusId: string;
  /** Task priority level (position in TASK_PRIORITY_CONFIG) */
  priorityLevel: TaskPriorityLevel;
  /** User ID of the assignee (null if unassigned — board "unassigned" filter) */
  assigneeId: string | null;
  /** Denormalized assignee identity — card avatar + display name */
  assigneeSnapshot: IdentitySnapshot | null;
  /** Optimistic concurrency version — required by board drag-and-drop updates */
  version: number;
}

/** Create task request body type */
export interface CreateTask {
  typeId: string;
  title: string;
  description?: string | undefined;
  statusId: string;
  priorityLevel: TaskPriorityLevel;
  assigneeId?: string | undefined;
  sprintId?: string | undefined;
  labelIds?: string[] | undefined;
}

/** Update task request body type (version is required for optimistic concurrency) */
export interface UpdateTask {
  title?: string | undefined;
  description?: string | undefined;
  statusId?: string | undefined;
  priorityLevel?: TaskPriorityLevel | undefined;
  assigneeId?: string | null | undefined;
  typeId?: string | undefined;
  sprintId?: string | null | undefined;
  labelIds?: string[] | undefined;
  version: number;
}

/**
 * Bulk update request body.
 * Exactly ONE field of `data` must be present per request — enforced by the
 * server's Zod schema; nullable `assigneeId`/`sprintId` unassign/clear.
 */
export interface BulkUpdateTasks {
  /** Target task ids (1..100) */
  taskIds: string[];
  data: {
    statusId?: string;
    assigneeId?: string | null;
    sprintId?: string | null;
  };
}

/** A single task that could not be bulk-updated (never throws for these). */
export interface BulkUpdateTaskFailure {
  taskId: string;
  /** Machine-readable reason, e.g. TASK_NOT_FOUND | TASK_NOT_IN_PROJECT | VERSION_CONFLICT */
  reason: string;
}

/** Bulk update response — per-task failures are reported, not thrown. */
export interface BulkUpdateTasksResult {
  updated: number;
  failed?: BulkUpdateTaskFailure[];
}
