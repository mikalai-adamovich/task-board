import * as z from 'zod';
import { AuditActionValues, AuditEntityTypeValues, SortDirectionValues } from '@task-board/shared';
import { uuid } from '../validators/common.js';
import { MAX_TASK_PAGE } from './task.js';

export const AuditQuerySchema = z.object({
  // Same deep-skip ceiling as the task list, for the same reason —
  // `audit_events` is append-only with no TTL, so `skip` is linear in the
  // offset and grows with the tenant's whole history (see MAX_TASK_PAGE).
  page: z.coerce.number().int().positive().max(MAX_TASK_PAGE, `page must be <= ${MAX_TASK_PAGE}`).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  entityType: z.enum(AuditEntityTypeValues).optional(),
  entityId: uuid().optional(),
  /**
   * Filter by action.
   *
   * Derived from `AuditActionValues` instead of a hand-copied literal list.
   * `AuditEvent.action` in `shared/src/types/audit.ts` is `AuditAction`, so the
   * two are the same domain and the copy could silently drift (a new action added
   * to the shared constant would be rejected by this query for no reason).
   */
  action: z.enum(AuditActionValues).optional(),
  /** Filter by actor user id */
  actorId: uuid().optional(),
  /** Time sort direction — defaults to desc (newest first) */
  sort: z.enum(SortDirectionValues).optional().default('desc'),
});

// NOTE: the R3-P7 response schemas (`AuditChangeResponseSchema` /
// `AuditEventResponseSchema`) were removed as dead code — nothing ever parsed a
// response with them, so `entityType`/`action` were widened back to `z.string()`
// and the "documented contract of the `{ data }` envelope" was never enforced at
// runtime. The contract now lives in exactly one place, the shared
// `AuditEvent` interface, and `AuditQuerySchema` above is derived from the same
// shared unions. Re-introducing a response schema is a deliberate decision, and
// when it happens it must use `AuditEntityTypeValues` / `AuditActionValues`.
