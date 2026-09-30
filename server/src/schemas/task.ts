import * as z from 'zod';
import { TASK_PRIORITY_CONFIG, TASK_SEARCH_MAX_LENGTH, TASK_SEARCH_MIN_LENGTH } from '@task-board/shared';
import { uuid, nonEmptyString, optionalString } from '../validators/common.js';

/**
 * Schema for creating a new task.
 */
/**
 * Priority-level validation derived from TASK_PRIORITY_CONFIG — a new level in
 * the config automatically becomes valid, no hardcoded `0..3` anywhere.
 */
export const taskPriorityLevelSchema = z.literal(TASK_PRIORITY_CONFIG.map((c) => c.level));

/**
 * The ceiling a single BSON document may occupy: 16 MiB. A platform guarantee
 * (the same one `db/query-timeout.ts` reasons from), not a project number.
 */
const BSON_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
/**
 * Bytes one array element costs in the worst case, for a uuid string:
 * 36 characters + 1 type byte + a 6-byte array key + ~1 byte of index slack.
 * Used only to derive the ceiling below, so the estimate is deliberately
 * pessimistic.
 */
const BSON_BYTES_PER_UUID_ELEMENT = 44;

/**
 * The largest number of uuids that can physically fit in one BSON document:
 * `16 MiB / 44 B ≈ 381,000`. A bound ABOVE this is meaningless (the write fails
 * on the document size, with a much worse error), so it is the hard limit any
 * per-document array bound must respect — and the guardrail asserts it.
 */
export const BSON_MAX_IDS_PER_DOCUMENT = Math.floor(BSON_MAX_DOCUMENT_BYTES / BSON_BYTES_PER_UUID_ELEMENT);

/**
 * The ceiling on an array of ids inside a SINGLE document per project.
 *
 * `tasks.labelIds`, `boards.columns[].statusIds` and the saved-filter criteria
 * arrays are all unbounded today, so a member can grow one document towards the
 * 16 MiB ceiling with no repair path short of direct database surgery — and the
 * two board documents are read by EVERY member on the kanban path, so the cost
 * lands on everyone.
 *
 * The value is far below `BSON_MAX_IDS_PER_DOCUMENT` on purpose: the derivation
 * above says what the platform can hold, not what the product should allow, and
 * a bound AT the ceiling would be no bound at all. 500 is the product judgement
 * — a task with more than 500 labels, or a board with more than 500 columns or
 * 500 statuses in a column, is not a shape a human designs. **If the owner wants
 * a different number, this constant is the only line to change; the guardrail
 * asserts the property (a bound exists, and it is within the platform ceiling),
 * not the value.**
 */
export const MAX_IDS_PER_DOCUMENT = 500;

/** `z.array(uuid())` with the same bound, so no schema can forget it. */
export const boundedIdArray = () => z.array(uuid()).max(MAX_IDS_PER_DOCUMENT, `At most ${MAX_IDS_PER_DOCUMENT} ids`);

export const CreateTaskSchema = z.object({
  typeId: uuid(),
  title: nonEmptyString(255, 'Task title'),
  description: optionalString(10000),
  statusId: uuid(),
  priorityLevel: taskPriorityLevelSchema,
  assigneeId: uuid().optional(),
  sprintId: uuid().optional(),
  labelIds: boundedIdArray().optional(),
});

/**
 * Schema for updating an existing task.
 * Version is required for optimistic concurrency.
 */
export const UpdateTaskSchema = z.object({
  title: nonEmptyString(255, 'Task title').optional(),
  description: optionalString(10000),
  statusId: uuid().optional(),
  priorityLevel: taskPriorityLevelSchema.optional(),
  assigneeId: uuid().nullable().optional(),
  typeId: uuid().optional(),
  sprintId: uuid().nullable().optional(),
  labelIds: boundedIdArray().optional(),
  version: z.number().int().positive(),
});

/**
 * Bulk update payload — exactly ONE field of `data` per request.
 * Nullable assigneeId/sprintId unassign/clear; absent fields stay untouched.
 */
export const BulkUpdateTasksSchema = z.object({
  taskIds: z.array(uuid()).min(1, 'At least one task id is required').max(100, 'At most 100 tasks per request'),
  data: z
    .object({
      statusId: uuid().optional(),
      assigneeId: uuid().nullable().optional(),
      sprintId: uuid().nullable().optional(),
    })
    .refine((data) => Object.values(data).filter((v) => v !== undefined).length === 1, {
      message: 'Exactly one of statusId, assigneeId or sprintId is required',
    }),
});

/** Whitelisted sort fields — must match TaskRepository's supported sorts
 * (plain fields + SEMANTIC_SORT_FIELDS). Prevents sorting on arbitrary /
 * unindexed / nested fields from user input.
 *
 * EXPORTED, because this is the one list of fields a task may be sorted
 * by, and the saved-filter schema (`schemas/filter.ts`) validates a sort field
 * that is PERSISTED and later replayed into this same query. Keeping a second
 * copy of the eleven names there is how the two would drift — and a filter
 * stored with a field this list no longer accepts is a filter that 400s the
 * moment a user applies it. One list, two consumers. */
export const SORT_FIELDS = [
  'number',
  'createdAt',
  'updatedAt',
  'title',
  'typeId',
  'priority',
  'statusId',
  'sprintId',
  'assigneeId',
  'reporterId',
  'labelIds',
] as const;

/**
 * Deep-pagination ceiling.
 *
 * `skip` pagination is linear in the offset — measured 1 ms at offset 0 and
 * 290 ms at offset 20,000 on a 25k-task project, with `keysExamined = skip +
 * limit` (the index is walked and discarded; no index can fix this). With
 * `page` unbounded and `limit` capped at 200, `?page=50000&limit=200` is a legal
 * request that walks 10 M index keys — the cheapest authenticated DoS in the
 * codebase: one parameter, no regex, no filters, no privilege required.
 *
 * The cap is deliberately generous for real use and tight for an attacker: at
 * the default `limit: 20`, page 500 is task 10,000 — past that a user should be
 * filtering, not scrolling. The honest trade-off is that a project with more
 * than 10,000 tasks (at the default page size) can no longer be reached by
 * clicking "last" in the paginator; the correct long-term answer is the keyset
 * cursor the board already uses (`findBoardPage`), which keeps `keysExamined`
 * flat regardless of depth. That rewrite is a separate, larger work package, and
 * this cap is the smallest change that removes the unbounded walk.
 */
export const MAX_TASK_PAGE = 500;

/**
 * Schema for task query parameters.
 */
export const TaskQuerySchema = z
  .object({
    page: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_TASK_PAGE, `page must be <= ${MAX_TASK_PAGE}`)
      .optional()
      .default(1),
    // 200: the board view fetches a project's full task list in one request
    limit: z.coerce.number().int().min(1).max(200).optional().default(20),
    sort: z
      .string()
      .regex(
        new RegExp(`^(${SORT_FIELDS.join('|')}):(asc|desc)$`),
        `sort must be "<field>:<asc|desc>" with field one of: ${SORT_FIELDS.join(', ')}`,
      )
      .optional(),
    /**
     * Bounded free-text search.
     *
     * `search` compiles to an `$or` over five regexes (title, description and
     * three identity snapshots). No B-tree can serve that shape, so the planner
     * walks the whole `{projectId}` range and evaluates five regexes per
     * document — measured 25,250 documents examined / 728–766 ms for a 20-row
     * page. Without a floor, `?search=a` is the MOST expensive payload anyone
     * can send (it matches nearly every task); without a ceiling, every extra
     * character is multiplied by five regex evaluations per scanned document.
     *
     * The bound is a UX contract, not a cost fix: a 2-char acronym search
     * ("QA", "UI") still costs a full scan. The hard cost backstop is
     * `maxTimeMS` on the query (see `db/query-timeout.ts`) and the indexes that
     * cover everything except this `$or`.
     */
    search: z
      .string()
      .min(TASK_SEARCH_MIN_LENGTH, `search must be at least ${TASK_SEARCH_MIN_LENGTH} characters`)
      .max(TASK_SEARCH_MAX_LENGTH, `search must be at most ${TASK_SEARCH_MAX_LENGTH} characters`)
      .optional(),
    statusId: uuid().optional(),
    priorityLevel: z.coerce.number().pipe(taskPriorityLevelSchema).optional(),
    typeId: uuid().optional(),
    assigneeId: uuid().optional(),
    reporterId: uuid().optional(),
    sprintId: uuid().optional(),
    /**
     * The explicit "no sprint" (backlog) filter.
     *
     * `sprintId` is a strict uuid, so the API had no way to say "tasks that are
     * NOT in a sprint" — omitting the param means "no sprint filtering at all"
     * (all project tasks), which is what the Sprints-page Backlog counter
     * silently showed. A magic sentinel inside the uuid field would be a lie the
     * schema cannot type, so the backlog gets its own tri-state boolean:
     *
     * - absent  → no sprint filtering (every task of the project)
     * - `false` → only tasks with `sprintId === null` (the backlog)
     * - `true`  → only tasks assigned to some sprint
     *
     * Mutually exclusive with `sprintId` (see the refine at the bottom) so the
     * two filters can never contradict each other.
     */
    hasSprint: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    labelId: uuid().optional(),
    /** Inclusive ISO date-range filters */
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
    updatedFrom: z.iso.date().optional(),
    updatedTo: z.iso.date().optional(),
    /**
     * Omit `description` from list responses. No list consumer
     * renders it (the board's task-card preview was removed — cards render only
     * key/priority/title/type/assignee), so tables/widget callers can cut ~40% of
     * payload. `description` search/filtering stays server-side and is unaffected.
     */
    excludeDescription: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * Board view (`view=board`): lightweight card projection — only the fields the
     * board UI reads (id/number/title/typeId/statusId/priority/assignee + snapshot,
     * version for optimistic DnD). Description, reporter, timestamps and other
     * detail fields are excluded server-side; the route maps the result to the
     * dedicated BoardTask DTO.
     */
    view: z.enum(['board']).optional(),
  })
  .refine((query) => query.sprintId === undefined || query.hasSprint === undefined, {
    message: 'sprintId and hasSprint are mutually exclusive — use hasSprint=false for the backlog',
    path: ['hasSprint'],
  });

/**
 * Board column pages (`GET …/tasks/board`): fixed `BOARD_PAGE_SIZE` cards per
 * column — no client-controlled limit. Per-column resume cursors arrive as
 * flat `cursor.<columnId>` query params holding opaque base64url strings;
 * `catchall` keeps them in the parsed output and the route decodes each one
 * (malformed → 400). Board filters mirror the flat board list so the paged
 * board keeps feature parity with it.
 */
export const BoardPageQuerySchema = z
  .object({
    sprintId: uuid().optional(),
    assigneeId: uuid().optional(),
    priorityLevel: z.coerce.number().pipe(taskPriorityLevelSchema).optional(),
  })
  .catchall(z.string());
