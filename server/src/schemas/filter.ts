import * as z from 'zod';
import { SortDirectionValues, TASK_SEARCH_MAX_LENGTH, TASK_SEARCH_MIN_LENGTH } from '@task-board/shared';
import { SORT_FIELDS, boundedIdArray, taskPriorityLevelSchema } from './task.js';
import { nonEmptyString } from '../validators/common.js';

/**
 * Filter criteria schema — all fields are optional and combined with AND logic.
 */
/**
 * ISO date string (`YYYY-MM-DD`) used by the date-range criteria fields
 * (`createdFrom`/`createdTo`/`updatedFrom`/`updatedTo`).
 */
const isoDate = () => z.iso.date();
const FilterCriteriaSchema = z.object({
  // The criteria arrays are stored in ONE document per saved filter and
  // were unbounded, exactly like `tasks.labelIds`. Same bound, same reason.
  //
  // `search` is bounded by the SAME shared constants the task query uses.
  // A saved filter's `search` is replayed verbatim into `TaskQuerySchema`, so an
  // unbounded copy here is a value the filter can store and the query will later
  // reject — the filter 400s at apply time, far from the write that caused it.
  search: z
    .string()
    .min(TASK_SEARCH_MIN_LENGTH, `search must be at least ${TASK_SEARCH_MIN_LENGTH} characters`)
    .max(TASK_SEARCH_MAX_LENGTH, `search must be at most ${TASK_SEARCH_MAX_LENGTH} characters`)
    .optional(),
  statusIds: boundedIdArray().optional(),
  priorityLevel: z.array(taskPriorityLevelSchema).optional(),
  typeIds: boundedIdArray().optional(),
  assigneeIds: boundedIdArray().optional(),
  reporterIds: boundedIdArray().optional(),
  sprintIds: boundedIdArray().optional(),
  labelIds: boundedIdArray().optional(),
  createdFrom: isoDate().optional(),
  createdTo: isoDate().optional(),
  updatedFrom: isoDate().optional(),
  updatedTo: isoDate().optional(),
});
/**
 * Sort specification schema.
 */
const FilterSortSchema = z.object({
  /**
   * Derived from the SAME allow-list the task query validates against,
   * because this value is PERSISTED and later replayed into that query. It was
   * `z.string()` — the only free-form field left in the schema directory — so a
   * saved filter could store `passwordHash` (or any unindexed/dotted path) and
   * hand it to a `sort` the moment a user applied it. Rejecting it at the WRITE
   * is the only point where the author can still see the message.
   */
  field: z.enum(SORT_FIELDS),
  // Derived from the shared sort-direction contract instead of a copied
  // `['asc', 'desc']` literal, so this cannot drift from `FilterSort.direction`.
  direction: z.enum(SortDirectionValues),
});

export const CreateFilterSchema = z.object({
  name: nonEmptyString(100, 'Filter name'),
  filters: FilterCriteriaSchema,
  sort: FilterSortSchema,
});

export const UpdateFilterSchema = z.object({
  name: nonEmptyString(100, 'Filter name').optional(),
  filters: FilterCriteriaSchema.optional(),
  sort: FilterSortSchema.optional(),
});
