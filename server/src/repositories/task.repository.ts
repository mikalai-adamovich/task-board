import { BaseRepository } from './base.repository.js';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { BOARD_PAGE_SIZE } from '@task-board/shared';
import type { Task, IdentitySnapshot, BoardPageCursor, TaskPriorityLevel, SortDirection } from '@task-board/shared';
import { escapeRegExp } from '../utils/regex.js';
import { toPlainText } from '../utils/markdown-plain-text.js';
import { QUERY_MAX_TIME_MS_BOARD, QUERY_MAX_TIME_MS_LIST } from '../db/query-timeout.js';

// Required MongoDB indexes:
// - { id: 1 } (unique)
// - { projectId: 1, number: -1 }
// - { projectId: 1, createdAt: -1 }
// - { projectId: 1, updatedAt: -1 }
// - { projectId: 1, statusId: 1, number: -1 }
// - { projectId: 1, sprintId: 1, number: -1 }
// - { projectId: 1, assigneeId: 1, number: 1 }   (aligned tiebreaker — one index serves both directions)
// - { projectId: 1, reporterId: 1, number: 1 }   (aligned tiebreaker)
// - { projectId: 1, priorityLevel: 1, number: 1 } (aligned tiebreaker)
// - { projectId: 1, typeId: 1, number: 1 }       (aligned tiebreaker)
// - { assigneeId: 1, updatedAt: -1 } (cross-project /tasks/my — audit #3)
// - { projectId: 1, statusName: 1, number: -1 } (TOP-2 semantic sort)
// - { projectId: 1, sprintName: 1, number: -1 } (TOP-2 semantic sort)
// - { projectId: 1, typeId: 1 }                (countByType)

/** Sort fields that require resolving relation names / snapshots before sorting. */
/**
 * `statusId`/`sprintId` sorts moved OFF the aggregation pipeline — the
 * denormalized `statusName`/`sprintName` fields are plain indexed document
 * keys now (see SEMANTIC_TO_DOC_KEY). Only `labelIds` still needs the
 * $lookup pipeline (alphabetically-first label of a task's label set is not
 * denormalized — its fan-out cost was judged too high for the benefit).
 */
const SEMANTIC_SORT_FIELDS = new Set(['labelIds']);
/** Plain-field sorts whose indexes carry an ALIGNED `number` tiebreaker (see findByProject). */
const ALIGNED_TIEBREAKER_FIELDS = new Set(['priority', 'assigneeId', 'reporterId', 'typeId']);
/** API sort field → denormalized document key (plain-indexed sorts). */
const SEMANTIC_TO_DOC_KEY: Record<string, string> = {
  statusId: 'statusName',
  sprintId: 'sprintName',
};

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface TaskDocument {
  _id?: import('mongodb').ObjectId;
  id: string;
  projectId: string;
  number: number;
  typeId: string;
  title: string;
  description: string | null;
  /**
   * The PLAIN-TEXT PROJECTION of {@link description}.
   *
   * `description` is always Markdown (the editor's contract, unchanged). Search
   * used to compile its regex over the Markdown source, so a hit was syntax the
   * user could not see and the prose they could see was not matchable. This field
   * is the text as rendered, written on EVERY save by this repository (see
   * `create` / `updateWithVersion`) so no write path can forget it.
   *
   * NOT part of the `Task` domain type and NOT returned by any query: it is a
   * server-side search index, excluded from the board and lightweight projections
   * exactly like `description` itself. A document written before this field
   * existed carries no projection at all; `backfillTaskDescriptionText` in
   * `db/migrations.ts` fills those in.
   */
  descriptionText?: string | null;
  statusId: string;
  /** Denormalized status name — sort-only, synced by status mutations */
  statusName: string | null;
  /** Denormalized sprint name — sort-only, synced by sprint mutations */
  sprintName: string | null;
  priorityLevel: number;
  reporterId: string | null;
  reporterSnapshot: IdentitySnapshot | null;
  assigneeId: string | null;
  assigneeSnapshot: IdentitySnapshot | null;
  sprintId: string | null;
  labelIds: string[];
  createdById: string;
  createdBySnapshot: IdentitySnapshot;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields of a task document that may be set by an update. */
export type TaskUpdatePayload = Partial<
  Pick<
    TaskDocument,
    | 'title'
    | 'description'
    | 'statusId'
    | 'statusName'
    | 'sprintName'
    | 'priorityLevel'
    | 'reporterId'
    | 'reporterSnapshot'
    | 'assigneeId'
    | 'assigneeSnapshot'
    | 'typeId'
    | 'sprintId'
    | 'labelIds'
  >
>;

// ─── Filter Types ────────────────────────────────────────────────────────────

/**
 * Filter/pagination options for the task list — mirrors the (Zod-validated)
 * output of `TaskQuerySchema`.
 *
 * Every optional field carries `| undefined` because the route forwards the
 * parsed query object verbatim and `exactOptionalPropertyTypes` distinguishes
 * "key absent" from "key present and undefined". `sort.direction` is the shared
 * {@link SortDirection} instead of a hand-copied union.
 */
export interface TaskQueryOptions {
  page?: number | undefined;
  limit?: number | undefined;
  sort?: { field: string; direction: SortDirection } | undefined;
  statusId?: string | undefined;
  priorityLevel?: number | undefined;
  typeId?: string | undefined;
  assigneeId?: string | undefined;
  reporterId?: string | undefined;
  sprintId?: string | undefined;
  /**
   * Tri-state "has a sprint" filter, mirroring `TaskQuerySchema.hasSprint`.
   * `undefined` → no sprint filtering; `false` → only tasks with
   * `sprintId === null` (the backlog); `true` → only tasks in some sprint.
   * Mutually exclusive with `sprintId` (validated at the schema edge).
   */
  hasSprint?: boolean | undefined;
  labelId?: string | undefined;
  search?: string | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`) range filters */
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  /**
   * Omit `description` from the returned documents.
   * List consumers that never render the description (task table, widgets)
   * use this to cut ~40% of the response payload. Server-side description
   * search/filtering is unaffected.
   */
  excludeDescription?: boolean | undefined;
  /**
   * Board view: lightweight card projection — the returned documents carry
   * only the fields the board UI reads (id/number/title/typeId/statusId/
   * priority/assignee + snapshot, version for optimistic DnD). Exclusion
   * projection: applied after matching, so filters are unaffected.
   */
  view?: 'board' | undefined;
}

/**
 * Fields excluded from board-view responses — nothing a board card renders or
 * a board interaction needs (see BoardTask in @task-board/shared). Kept as an
 * exclusion list so newly added Task fields stay visible by default.
 */
const BOARD_VIEW_EXCLUDED_FIELDS = [
  'description',
  // The plain-text projection is a copy of the description, so a board card
  // that excluded the description but carried the projection would still ship the
  // whole body — the exact payload regression F5 removed.
  'descriptionText',
  'projectId',
  'reporterId',
  'reporterSnapshot',
  'statusName',
  'sprintName',
  'sprintId',
  'labelIds',
  'createdById',
  'createdBySnapshot',
  'createdAt',
  'updatedAt',
] as const;

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Options for one board column page (see `findBoardPage`). */
export interface BoardPageOptions {
  /** Column statuses — matched with `$in` (one column may group several). */
  statusIds: string[];
  /** Resume key of the last loaded card; absent for the first page. */
  cursor?: BoardPageCursor | null | undefined;
  // The board route forwards the parsed `BoardQuerySchema` object, whose
  // absent filters are explicit `undefined`s.
  sprintId?: string | undefined;
  assigneeId?: string | undefined;
  priorityLevel?: number | undefined;
}

/** One board column page — fixed `BOARD_PAGE_SIZE`, probe-derived `hasMore`. */
export interface BoardPageResult {
  tasks: Task[];
  hasMore: boolean;
  nextCursor: BoardPageCursor | null;
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function toDomain(doc: TaskDocument): Task {
  return {
    id: doc.id,
    projectId: doc.projectId,
    number: doc.number,
    typeId: doc.typeId,
    title: doc.title,
    description: doc.description,
    statusId: doc.statusId,
    statusName: doc.statusName ?? null,
    sprintName: doc.sprintName ?? null,
    priorityLevel: doc.priorityLevel,
    reporterId: doc.reporterId,
    reporterSnapshot: doc.reporterSnapshot,
    assigneeId: doc.assigneeId,
    assigneeSnapshot: doc.assigneeSnapshot,
    sprintId: doc.sprintId,
    labelIds: doc.labelIds,
    createdById: doc.createdById,
    createdBySnapshot: doc.createdBySnapshot,
    version: doc.version,
    // Board-view projections omit the timestamps (never read by a card) —
    // they are spread conditionally so projected documents map without
    // crashing; board consumers receive the dedicated BoardTask DTO instead
    // of this Task mapping, so the absent keys are unreachable there.
    ...(doc.createdAt ? { createdAt: doc.createdAt.toISOString() } : {}),
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt.toISOString() } : {}),
  } as Task;
}

// ─── Task Repository ─────────────────────────────────────────────────────────

export class TaskRepository extends BaseRepository<TaskDocument, Task> {
  protected toDomain(doc: TaskDocument): Task {
    return toDomain(doc);
  }

  /**
   * Tasks assigned to a user across all projects, newest update first.
   *
   * Audit #3: the only consumer is the tenant-home "My Tasks" widget, which
   * renders `id`, `number`, `title`, `priorityLevel` and resolves the project via
   * `projectId`. An inclusion projection keeps the payload minimal (description
   * and snapshots are the bulk of a full task document); the server-side sort
   * by `updatedAt` is unchanged. Requires the `{ assigneeId: 1, updatedAt: -1 }`
   * index (see migrations) — without it this query is a COLLSCAN.
   *
   * `projectIds` is REQUIRED and is the membership scope: the caller may
   * only see tasks in projects of tenants they currently hold an ACTIVE
   * membership in. Passing an empty array returns nothing — there is no call
   * shape in which a user id alone reaches a task.
   */
  async findAssignedTo(userId: string, projectIds: readonly string[], limit = 50): Promise<Task[]> {
    // The query is scoped by the caller's MEMBERSHIP, not by the user id
    // alone. `projectIds` is the set the caller may currently read, resolved by
    // the service from their tenant memberships; an empty set is a closed door
    // (`$in: []` matches nothing), so a caller with no membership cannot reach a
    // document through this method at all. The `{assigneeId, updatedAt}` index
    // still applies — `assigneeId` remains the equality prefix.
    const docs = await this.collection
      // createdAt/updatedAt are required by toDomain (toISOString) — and
      // updatedAt is the sort key anyway.
      .find(
        { assigneeId: userId, projectId: { $in: projectIds } },
        {
          projection: {
            id: 1,
            projectId: 1,
            number: 1,
            title: 1,
            priorityLevel: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          // Cross-project — the range grows with every assignment the user
          // ever has, so the query is not bounded by any single project's size.
          maxTimeMS: QUERY_MAX_TIME_MS_LIST,
        },
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(toDomain);
  }

  async findByProjectAndNumber(projectId: string, number: number): Promise<Task | null> {
    const doc = await this.collection.findOne({ projectId, number });

    return doc ? toDomain(doc) : null;
  }

  /**
   * Find tasks by project with optional filters, pagination, and sort.
   */
  async findByProject(projectId: string, options: TaskQueryOptions = {}): Promise<PaginatedResult<Task>> {
    const {
      page = 1,
      limit = 20,
      sort,
      statusId,
      priorityLevel,
      typeId,
      assigneeId,
      reporterId,
      sprintId,
      hasSprint,
      labelId,
      search,
      createdFrom,
      createdTo,
      updatedFrom,
      updatedTo,
      excludeDescription,
      view,
    } = options;
    const query: Record<string, unknown> = { projectId };

    if (statusId) query.statusId = statusId;
    if (priorityLevel) query.priorityLevel = priorityLevel;
    if (typeId) query.typeId = typeId;
    if (assigneeId) query.assigneeId = assigneeId;
    if (reporterId) query.reporterId = reporterId;
    // The sprint filter has two mutually exclusive shapes — an exact sprint
    // id, or the tri-state "has a sprint" flag. `sprintId: null` is the equality
    // match on the stored null and is served by the existing
    // `{projectId, sprintId, number}` index, so the backlog query stays indexed.
    if (sprintId) query.sprintId = sprintId;
    else if (hasSprint === false) query.sprintId = null;
    else if (hasSprint === true) query.sprintId = { $ne: null };
    if (labelId) query.labelIds = labelId;

    // Inclusive date-range filters (ISO dates → Date boundaries).
    // `{ projectId, createdAt: -1 }` / `{ projectId, updatedAt: -1 }` indexes cover these.
    if (createdFrom || createdTo) {
      query.createdAt = {
        ...(createdFrom ? { $gte: new Date(`${createdFrom}T00:00:00.000Z`) } : {}),
        ...(createdTo ? { $lte: new Date(`${createdTo}T23:59:59.999Z`) } : {}),
      };
    }

    if (updatedFrom || updatedTo) {
      query.updatedAt = {
        ...(updatedFrom ? { $gte: new Date(`${updatedFrom}T00:00:00.000Z`) } : {}),
        ...(updatedTo ? { $lte: new Date(`${updatedTo}T23:59:59.999Z`) } : {}),
      };
    }
    if (search) {
      // Escape user input — raw input is compiled as a regex (ReDoS / 500 on invalid patterns)
      const regex = { $regex: escapeRegExp(search), $options: 'i' };

      // The description branch matches the PLAIN-TEXT PROJECTION, not
      // the Markdown source. `description` is still Markdown (the editor's
      // contract), so matching it made `**bold**` findable and `bold text` — the
      // phrase on screen — not; the Markdown punctuation was itself matchable
      // content. A hit is now always text a reader can see.
      //
      // The second description branch is a TRANSITIONAL safety net, not a second
      // contract: a document written before the projection existed carries no
      // `descriptionText`, and `backfillTaskDescriptionText` (db/migrations.ts)
      // fills those in before the next deploy. Matching a missing projection on
      // the source is strictly better than a task that became unsearchable in the
      // window between the code shipping and the backfill running, and it is
      // bounded by that backfill. Delete this branch when the backfill has run
      // everywhere; the guardrail in `task-search-projection.guardrail.test.ts`
      // is what keeps the primary branch honest in the meantime.
      query.$or = [
        { title: regex },
        { descriptionText: regex },
        { description: regex, descriptionText: { $exists: false } },
        { 'createdBySnapshot.displayName': regex },
        { 'assigneeSnapshot.displayName': regex },
        { 'reporterSnapshot.displayName': regex },
      ];
    }

    const sortField = sort?.field ?? 'number';
    const sortDir = sort?.direction === 'asc' ? 1 : -1;
    const skip = (page - 1) * limit;

    // Semantic sorts resolve relation names instead of raw ids.
    if (sort && SEMANTIC_SORT_FIELDS.has(sort.field)) {
      const pipeline = this.buildSemanticSortPipeline(query, sort.field, sortDir, skip, limit);

      if (view === 'board') {
        pipeline.push({ $unset: [...BOARD_VIEW_EXCLUDED_FIELDS] } as unknown as Document);
      } else if (excludeDescription) {
        // The projection is excluded with the description — omitting it here
        // would ship the whole body to a caller that asked not to receive it.
        pipeline.push({ $unset: ['description', 'descriptionText'] });
      }

      // The `labelIds` semantic sort is an unavoidable blocking SORT over
      // the whole project — the one pipeline here with no index
      // that can serve it, so it carries the same generous budget as the find.
      const [docs, total] = await Promise.all([
        this.collection.aggregate<TaskDocument>(pipeline, { maxTimeMS: QUERY_MAX_TIME_MS_LIST }).toArray(),
        this.collection.countDocuments(query, { maxTimeMS: QUERY_MAX_TIME_MS_LIST }),
      ]);

      return {
        data: docs.map(toDomain),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    let findOptions: { projection: Record<string, 0> } | undefined;

    if (view === 'board') {
      findOptions = { projection: Object.fromEntries(BOARD_VIEW_EXCLUDED_FIELDS.map((field) => [field, 0])) };
    } else if (excludeDescription) {
      // The projection travels with the description out of the response.
      findOptions = { projection: { description: 0, descriptionText: 0 } };
    }

    // statusId/sprintId sorts map to their denormalized name fields —
    // plain indexed sorts, no aggregation pipeline.
    // `priority` remains the public sort key (URL state / saved filters);
    // it maps to the numeric `priorityLevel` document field.
    const docSortKey = sortField === 'priority' ? 'priorityLevel' : (SEMANTIC_TO_DOC_KEY[sortField] ?? sortField);
    // Plain-field sort indexes use an ALIGNED tiebreaker (`number: sortDir`):
    // `number` is unique within a project, so the tiebreaker direction does not
    // change which documents come first — only the order WITHIN groups of equal
    // field values — and one `{projectId, field, number: 1}` index then serves
    // BOTH sort directions via reverse traversal (4 indexes instead of 8).
    // All other sorts keep the legacy `number: -1` tiebreaker, which their
    // existing `… number: -1` indexes are built to match; flipping those would
    // break index-supported sorting for createdAt/updatedAt/title/statusName.
    const sortSpec: Record<string, 1 | -1> = ALIGNED_TIEBREAKER_FIELDS.has(sortField)
      ? { [docSortKey]: sortDir, number: sortDir }
      : { [docSortKey]: sortDir, number: -1 };
    // `maxTimeMS` on BOTH halves of the pair. The `search` shape ($or of
    // five regexes over the whole {projectId} range) is the single most
    // expensive query in the app (measured 728–766 ms + 351 ms count on a
    // 25k-task project); the budget aborts it server-side instead of letting it
    // burn the Worker's CPU. See db/query-timeout.ts for the value rationale.
    const [docs, total] = await Promise.all([
      this.collection
        .find(query, { ...findOptions, maxTimeMS: QUERY_MAX_TIME_MS_LIST })
        .sort(sortSpec)
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.collection.countDocuments(query, { maxTimeMS: QUERY_MAX_TIME_MS_LIST }),
    ]);

    return {
      data: docs.map(toDomain),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * One board column page: keyset pagination over the column's statuses.
   *
   * Fixed contract — `BOARD_PAGE_SIZE` cards per call, no client-controlled
   * limit, no `skip`, no `countDocuments`. The query fetches one probe
   * document past the page (`BOARD_PAGE_SIZE + 1`): a 51st document means
   * `hasMore`, and `nextCursor` is built from the last returned card.
   * Sort is `{ priorityLevel: -1, number: 1 }`, served by the
   * `{ projectId, statusId, priorityLevel: -1, number: 1 }` compound index
   * (see migrations) — no blocking SORT stage.
   */
  async findBoardPage(projectId: string, options: BoardPageOptions): Promise<BoardPageResult> {
    const { statusIds, cursor, sprintId, assigneeId, priorityLevel } = options;

    // `$in: []` never matches — skip the round-trip entirely.
    if (statusIds.length === 0) {
      return { tasks: [], hasMore: false, nextCursor: null };
    }

    const query: Record<string, unknown> = { projectId, statusId: { $in: statusIds } };

    if (cursor) {
      query.$or = [
        { priorityLevel: { $lt: cursor.priorityLevel } },
        { priorityLevel: cursor.priorityLevel, number: { $gt: cursor.number } },
      ];
    }

    if (sprintId) query.sprintId = sprintId;
    if (assigneeId) query.assigneeId = assigneeId;
    if (priorityLevel !== undefined) query.priorityLevel = priorityLevel;

    // Keyset pagination bounds `keysExamined` by the COLUMN size rather
    // than by scroll depth, so this path is cheap by construction — it gets the
    // tighter board budget as a backstop, not as a fix.
    const docs = await this.collection
      .find(query, {
        projection: Object.fromEntries(BOARD_VIEW_EXCLUDED_FIELDS.map((field) => [field, 0])),
        maxTimeMS: QUERY_MAX_TIME_MS_BOARD,
      })
      .sort({ priorityLevel: -1, number: 1 })
      .limit(BOARD_PAGE_SIZE + 1)
      .toArray();
    const hasMore = docs.length > BOARD_PAGE_SIZE;
    const page = hasMore ? docs.slice(0, BOARD_PAGE_SIZE) : docs;
    const last = page[page.length - 1];

    return {
      tasks: page.map(toDomain),
      hasMore,
      // Levels reach the document only through the validated write schema, so
      // the narrow cursor level type holds at this boundary.
      nextCursor: last ? { priorityLevel: last.priorityLevel as TaskPriorityLevel, number: last.number } : null,
    };
  }

  /**
   * Aggregation pipeline for sorts that cannot be expressed as a plain field sort:
   * - `statusId` / `sprintId` → sort by the related status/sprint **name**
   * - `labelIds` → sort by the alphabetically-first label name (tasks without labels last)
   *
   * (`priority` no longer needs this pipeline: it is the numeric `priorityLevel`
   * document field since the priority model migration.)
   */
  private buildSemanticSortPipeline(
    query: Record<string, unknown>,
    field: string,
    dir: 1 | -1,
    skip: number,
    limit: number,
  ): Document[] {
    const NO_VALUE = '\uffff'; // sorts after any real name
    let addSortKey: Document;

    if (field === 'labelIds') {
      addSortKey = {
        $addFields: {
          __sort: {
            $cond: [{ $gt: [{ $size: '$__refs' }, 0] }, { $min: '$__refs.name' }, NO_VALUE],
          },
        },
      };
    } else if (field === 'assigneeId' || field === 'reporterId') {
      // Denormalized display-name snapshot is embedded in the task document — no lookup needed.
      const snapshotField = field === 'assigneeId' ? 'assigneeSnapshot.displayName' : 'reporterSnapshot.displayName';

      addSortKey = {
        $addFields: { __sort: { $ifNull: [`$${snapshotField}`, NO_VALUE] } },
      };
    } else {
      // statusId | sprintId — single reference, sort by its name
      addSortKey = {
        $addFields: { __sort: { $ifNull: [{ $first: '$__refs.name' }, NO_VALUE] } },
      };
    }

    let lookup: Document[] = [];

    if (field === 'labelIds') {
      lookup = [{ $lookup: { from: 'labels', localField: 'labelIds', foreignField: 'id', as: '__refs' } }];
    } else if (field === 'statusId' || field === 'sprintId') {
      lookup = [
        {
          $lookup: {
            from: field === 'statusId' ? 'statuses' : 'sprints',
            localField: field,
            foreignField: 'id',
            as: '__refs',
          },
        },
      ];
    }

    return [
      { $match: query },
      ...lookup,
      addSortKey,
      { $sort: { __sort: dir, number: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];
  }

  async create(input: {
    projectId: string;
    number: number;
    typeId: string;
    title: string;
    // `| undefined` on every optional field — the service forwards the
    // validated `CreateTask` body plus server-resolved snapshots, and
    // `exactOptionalPropertyTypes` requires the distinction to be explicit.
    description?: string | undefined;
    statusId: string;
    statusName?: string | null | undefined;
    sprintName?: string | null | undefined;
    priorityLevel: number;
    reporterId?: string | undefined;
    reporterSnapshot?: IdentitySnapshot | undefined;
    assigneeId?: string | undefined;
    assigneeSnapshot?: IdentitySnapshot | undefined;
    sprintId?: string | undefined;
    labelIds?: string[] | undefined;
    createdById: string;
    createdBySnapshot: IdentitySnapshot;
  }): Promise<Task> {
    const now = new Date();
    const doc: TaskDocument = {
      id: randomUUID(),
      projectId: input.projectId,
      number: input.number,
      typeId: input.typeId,
      title: input.title,
      description: input.description ?? null,
      // The plain-text projection is derived HERE, in the repository, not in
      // the service — so no create path (including the numbering-retry loop, which
      // re-enters this method) can produce a task that search cannot read.
      descriptionText: toPlainText(input.description),
      statusId: input.statusId,
      statusName: input.statusName ?? null,
      sprintName: input.sprintName ?? null,
      priorityLevel: input.priorityLevel,
      reporterId: input.reporterId ?? null,
      reporterSnapshot: input.reporterSnapshot ?? null,
      assigneeId: input.assigneeId ?? null,
      assigneeSnapshot: input.assigneeSnapshot ?? null,
      sprintId: input.sprintId ?? null,
      labelIds: input.labelIds ?? [],
      createdById: input.createdById,
      createdBySnapshot: input.createdBySnapshot,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return toDomain(doc);
  }

  /**
   * Atomic update with optimistic concurrency check.
   * Uses findOneAndUpdate with version check + $inc.
   * Returns null if version mismatch (concurrent modification).
   *
   * When the payload carries a `description`, the plain-text projection is
   * re-derived HERE rather than by the caller. The rule "the projection is a
   * function of the description, never a separate user input" is what makes the
   * two fields unable to drift: a service that forgets to set the projection
   * cannot leave a stale one behind, because this method overwrites it from the
   * only source of truth. A payload WITHOUT a description leaves the stored
   * projection untouched, exactly as it leaves the description untouched.
   */
  async updateWithVersion(id: string, currentVersion: number, update: TaskUpdatePayload): Promise<Task | null> {
    const $set: Record<string, unknown> = { ...update };

    if (update.description !== undefined) {
      $set.descriptionText = toPlainText(update.description);
    }

    const result = await this.collection.findOneAndUpdate(
      { id, version: currentVersion },
      {
        $set: { ...$set, updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );

    return result ? toDomain(result) : null;
  }

  /**
   * Count tasks with a given status in a project.
   */
  async countByStatus(projectId: string, statusId: string): Promise<number> {
    return this.collection.countDocuments({ projectId, statusId }, { maxTimeMS: QUERY_MAX_TIME_MS_LIST });
  }

  /**
   * Per-status task counts in ONE `$match` + `$group` aggregation
   * (used by the project-overview status summary — replaces one
   * `countDocuments` per status).
   */
  async countByStatusGrouped(projectId: string): Promise<{ statusId: string; count: number }[]> {
    const rows = await this.collection
      .aggregate<{ _id: string; count: number }>(
        [{ $match: { projectId } }, { $group: { _id: '$statusId', count: { $sum: 1 } } }],
        // The group produces one key per status in the project — 25,250
        // keys on the audit's skew project — so this is a full-range read.
        { maxTimeMS: QUERY_MAX_TIME_MS_LIST },
      )
      .toArray();

    return rows.map((row) => ({ statusId: row._id, count: row.count }));
  }

  /**
   * Bulk update all tasks with a given status to a new status
   * (status delete/replacement — carries the replacement's denormalized name).
   */
  async updateManyByStatus(
    projectId: string,
    oldStatusId: string,
    newStatusId: string,
    newStatusName?: string | null,
  ): Promise<void> {
    await this.collection.updateMany(
      { projectId, statusId: oldStatusId },
      { $set: { statusId: newStatusId, statusName: newStatusName ?? null, updatedAt: new Date() } },
    );
  }

  /**
   * TOP-3 №1: bulk optimistic-concurrency update in ONE `bulkWrite`.
   *
   * Every task gets an individual filter `{ id, version }` — an operation
   * applies only when the task's version still matches, and `$inc` bumps it,
   * exactly like the per-task `updateWithVersion`. `ordered: false` keeps the
   * per-task independence of the former sequential loop (a conflict on one
   * task never blocks the others).
   *
   * Returns the tasks that were ACTUALLY updated (version = entry.version+1);
   * entries missing from the result are version conflicts. One round-trip for
   * the writes + one for the result mapping — independent of batch size.
   */
  async bulkUpdateWithVersion(entries: { id: string; version: number }[], update: TaskUpdatePayload): Promise<Task[]> {
    if (entries.length === 0) return [];

    const now = new Date();
    // The same rule as `updateWithVersion` — a payload carrying a
    // `description` re-derives the projection. Today's bulk schema admits only
    // status/assignee/sprint, so this is defensive rather than load-bearing; it is
    // here so widening that schema cannot silently produce a task whose stored
    // description and search index disagree.
    const $set: Record<string, unknown> = { ...update };

    if (update.description !== undefined) {
      $set.descriptionText = toPlainText(update.description);
    }

    const ops = entries.map((entry) => ({
      updateOne: {
        filter: { id: entry.id, version: entry.version },
        update: { $set: { ...$set, updatedAt: now }, $inc: { version: 1 } },
      },
    }));

    await this.collection.bulkWrite(ops, { ordered: false });

    const updatedDocs = await this.collection
      .find({ $or: entries.map((entry) => ({ id: entry.id, version: entry.version + 1 })) })
      .toArray();

    return updatedDocs.map(toDomain);
  }

  /** Propagate a status rename to all tasks holding the status. */
  async setStatusNameForTasks(projectId: string, statusId: string, statusName: string): Promise<void> {
    await this.collection.updateMany({ projectId, statusId }, { $set: { statusName, updatedAt: new Date() } });
  }

  /** Propagate a sprint rename to all tasks holding the sprint. */
  async setSprintNameForTasks(projectId: string, sprintId: string, sprintName: string): Promise<void> {
    await this.collection.updateMany({ projectId, sprintId }, { $set: { sprintName, updatedAt: new Date() } });
  }

  /**
   * Count tasks with a given type in a project.
   */
  async countByType(projectId: string, typeId: string): Promise<number> {
    return this.collection.countDocuments({ projectId, typeId }, { maxTimeMS: QUERY_MAX_TIME_MS_LIST });
  }

  /**
   * Bulk update all tasks with a given type to a new type.
   */
  async updateManyByType(projectId: string, oldTypeId: string, newTypeId: string): Promise<void> {
    await this.collection.updateMany(
      { projectId, typeId: oldTypeId },
      { $set: { typeId: newTypeId, updatedAt: new Date() } },
    );
  }

  /**
   * Remove a label ID from all tasks in a project.
   */
  async removeLabelFromAll(projectId: string, labelId: string): Promise<void> {
    await this.collection.updateMany(
      { projectId, labelIds: labelId },
      { $pull: { labelIds: labelId }, $set: { updatedAt: new Date() } },
    );
  }

  /**
   * Unassign sprint from all tasks with a given sprint.
   */
  async clearSprintFromTasks(projectId: string, sprintId: string): Promise<void> {
    await this.collection.updateMany(
      { projectId, sprintId },
      { $set: { sprintId: null, sprintName: null, updatedAt: new Date() } },
    );
  }

  /**
   * Delete all entities belonging to a project. Used for cascade delete.
   */
  /**
   * Lightweight id-only lookup for a project's tasks — used by the project
   * cascade to delete comments (keyed by `taskId`, not `projectId`) BEFORE
   * the tasks themselves are removed.
   */
  async findIdsByProject(projectId: string): Promise<string[]> {
    // Unbounded id-only scan of the whole project (25,250 keys on the
    // audit's skew project) feeding the cascade-delete $in.
    const docs = await this.collection
      .find({ projectId }, { projection: { id: 1, _id: 0 }, maxTimeMS: QUERY_MAX_TIME_MS_LIST })
      .toArray();

    return docs.map((doc) => doc.id);
  }

  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ projectId });
  }
}
