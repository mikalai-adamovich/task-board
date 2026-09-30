import * as z from 'zod';
import { uuid } from '../validators/common.js';
import { boundedIdArray, MAX_IDS_PER_DOCUMENT } from './task.js';

/**
 * Board column schema — embedded value object.
 *
 * The SAME bound as `tasks.labelIds`, for the SAME reason — one document
 * per project, read by every member on the kanban path, and `columns` had no
 * ceiling at all (only `.min(1)`). The constant lives in `task.ts` next to the
 * BSON derivation that caps it; imported here so the two single-document
 * resources cannot drift apart.
 */
const BoardColumnSchema = z.object({
  id: uuid().optional(),
  statusIds: boundedIdArray().min(1, 'Each column must have at least one status'),
  position: z.number().int().nonnegative(),
});

/**
 * Schema for updating the project's single board (columns/workflow).
 * The board itself cannot be created/deleted/renamed via the API — it is
 * created with the project and dies with it (single-board model, doc 102).
 */
export const UpdateBoardColumnsSchema = z.object({
  columns: z
    .array(BoardColumnSchema)
    .min(1, 'Board must have at least one column')
    .max(MAX_IDS_PER_DOCUMENT, `At most ${MAX_IDS_PER_DOCUMENT} columns`),
  /**
   * Optimistic concurrency, mirroring `UpdateTaskSchema.version`
   * (`z.number().int().positive()`) exactly. A board save REPLACES the whole
   * `columns` array, so a stale write is a silent loss of the other admin's
   * edit; the version makes it a 409 instead.
   */
  version: z.number().int().positive(),
});
