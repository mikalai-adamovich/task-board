import type { TaskPriorityLevel } from '../constants/priority.js';
import { valuesOf } from '../utils/values-of.js';

/**
 * Sort direction — the single source of truth for `'asc' | 'desc'`.
 *
 * The TypeScript audit counted twelve hand-copied `'asc' | 'desc'` unions
 * (server repositories/routes/schemas, UI services/components). Every one of them
 * is the SAME two-value domain, so they are all now derived from this constant:
 * TS positions take {@link SortDirection}, Zod positions take
 * {@link SortDirectionValues} (`z.enum(SortDirectionValues)`) and can no longer
 * drift apart — which is exactly how the audit list and the filter schema
 * started to disagree about what a valid direction is.
 *
 * The const object lives next to {@link FilterSort}, its first and canonical
 * consumer; the ideal home is a dedicated `constants/sort.ts` (
 * report — a new file was out of scope for that subtask).
 */
export const SortDirection = {
  ASC: 'asc',
  DESC: 'desc',
} as const;

export type SortDirection = (typeof SortDirection)[keyof typeof SortDirection];

/** Runtime value list for Zod: `z.enum(SortDirectionValues)`. */
export const SortDirectionValues = valuesOf(SortDirection);

/**
 * Filter criteria — all fields are optional and combined with AND logic.
 *
 * Every field is `?: T | undefined` because this type is produced by
 * `FilterCriteriaSchema` (a `.partial()`-style Zod object), whose parse output
 * carries explicit `undefined`s that a bare `field?: T` cannot accept under
 * `exactOptionalPropertyTypes`.
 */
export interface FilterCriteria {
  /** Full-text search string */
  search?: string | undefined;
  /** Filter by status IDs */
  statusIds?: string[] | undefined;
  /** Filter by priority levels (positions in TASK_PRIORITY_CONFIG) */
  priorityLevel?: TaskPriorityLevel[] | undefined;
  /** Filter by task type IDs */
  typeIds?: string[] | undefined;
  /** Filter by assignee user IDs */
  assigneeIds?: string[] | undefined;
  /** Filter by reporter user IDs */
  reporterIds?: string[] | undefined;
  /** Filter by sprint IDs */
  sprintIds?: string[] | undefined;
  /** Filter by label IDs */
  labelIds?: string[] | undefined;
  /** Only tasks created on/after this ISO date (`YYYY-MM-DD`, inclusive) */
  createdFrom?: string | undefined;
  /** Only tasks created on/before this ISO date (`YYYY-MM-DD`, inclusive) */
  createdTo?: string | undefined;
  /** Only tasks updated on/after this ISO date (`YYYY-MM-DD`, inclusive) */
  updatedFrom?: string | undefined;
  /** Only tasks updated on/before this ISO date (`YYYY-MM-DD`, inclusive) */
  updatedTo?: string | undefined;
}

/** Sort specification */
export interface FilterSort {
  /** Field to sort by */
  field: string;
  /** Sort direction */
  direction: SortDirection;
}

/** Saved filter entity type */
export interface Filter {
  /** Unique filter identifier (UUID v4) */
  id: string;
  /** Parent project ID */
  projectId: string;
  /** User ID who owns this filter */
  userId: string;
  /** Display name for the saved filter */
  name: string;
  /** Filter criteria */
  filters: FilterCriteria;
  /** Sort specification */
  sort: FilterSort;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Create filter request body type */
export interface CreateFilter {
  name: string;
  filters: FilterCriteria;
  sort: FilterSort;
}

/** Update filter request body type */
export interface UpdateFilter {
  name?: string | undefined;
  filters?: FilterCriteria | undefined;
  sort?: FilterSort | undefined;
}
