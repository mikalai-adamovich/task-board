import { MemberStatus, ProjectStatus, encodeBoardCursor } from '@task-board/shared';
import { ensurePermission } from './rbac.service.js';
import type {
  Task,
  BoardTask,
  BoardPage,
  BoardColumnPage,
  BoardPageCursor,
  BoardColumn,
  BoardConfig,
  CreateTask,
  UpdateTask,
  IdentitySnapshot,
  AuditChange,
  BulkUpdateTasksResult,
  BulkUpdateTaskFailure,
} from '@task-board/shared';
import { AppError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../errors/app-error.js';
import { isTaskNumberConflict } from '../db/duplicate-key.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';
import {
  TaskRepository,
  type TaskQueryOptions,
  type PaginatedResult,
  type TaskUpdatePayload,
} from '../repositories/task.repository.js';
import { parseTaskRef } from '../validators/task-ref.js';
import { CounterService } from './counter.service.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { ProjectMemberRepository } from '../repositories/project-member.repository.js';
import { StatusRepository } from '../repositories/status.repository.js';
import { TaskTypeRepository } from '../repositories/task-type.repository.js';
import type { AuditService } from './audit.service.js';

/**
 * How many insert attempts a single `createTask` may spend on the task
 * number.
 *
 * The number comes from an atomic counter, so a conflict is already the
 * exceptional case (see {@link isTaskNumberConflict}); three attempts is a
 * generous bound for a counter that is merely behind, and still small enough
 * that a genuinely stuck counter fails the request instead of spinning.
 */
const MAX_TASK_NUMBER_ATTEMPTS = 3;

/**
 * `TaskRepository.create`'s payload minus the server-allocated `number`.
 *
 * Derived from the repository signature rather than re-declared, so the retry
 * loop cannot drift from the insert it feeds.
 */
type TaskInsertDraft = Omit<Parameters<TaskRepository['create']>[0], 'number'>;

// ─── Interfaces for cross-repository dependencies ────────────────────────────

export interface TaskServiceUserRepo {
  findById(id: string): Promise<{ id: string; displayName?: string; name?: string; email: string } | null>;
}

export interface TaskServiceSprintRepo {
  findById(id: string): Promise<{ id: string; projectId: string; name?: string | null } | null>;
  /** Batched lookup used by validateCrossProjectRefs */
  findByIds(ids: string[]): Promise<{ id: string; projectId: string; name?: string | null }[]>;
}

export interface TaskServiceCommentRepo {
  deleteByTask(taskId: string): Promise<void>;
}

export interface TaskServiceRelationshipRepo {
  deleteByTask(taskId: string): Promise<void>;
}

export interface TaskServiceBoardRepo {
  findByProject(projectId: string): Promise<BoardConfig | null>;
}

/** The label seam `validateCrossProjectRefs` checks `labelIds` against. */
export interface TaskServiceLabelRepo {
  findByProject(projectId: string): Promise<{ id: string }[]>;
}

/**
 * The repositories {@link validateCrossProjectRefs} reads through.
 *
 * Declared as the minimum surface the check needs rather than as the concrete
 * repositories, so the check is one independently testable function instead of
 * a method only reachable through a fully wired `TaskService`.
 */
export interface TaskRefDeps {
  taskTypeRepo: { findByIds(ids: string[]): Promise<{ id: string; projectId: string }[]> };
  statusRepo: {
    findByIds(ids: string[]): Promise<{ id: string; projectId: string; name?: string | null }[]>;
  };
  sprintRepo: {
    findByIds(ids: string[]): Promise<{ id: string; projectId: string; name?: string | null }[]>;
  };
  labelRepo: TaskServiceLabelRepo;
  /**
   * The assignee seam. It resolves an identity THROUGH the project membership,
   * never from the global users collection, so a display name can only be read
   * for someone the caller's own project can already name.
   */
  projectMemberRepo: {
    findUserIdentityByProject(
      userId: string,
      projectId: string,
    ): Promise<{ userId: string; displayName: string } | null>;
  };
}

/**
 * The task references a write may carry. `assigneeId`/`sprintId` are nullable
 * in the request schemas because `null` is how a client CLEARS them — a clear
 * is not a reference and is never validated as one.
 */
export interface TaskCrossRefs {
  typeId?: string | undefined;
  statusId?: string | undefined;
  assigneeId?: string | null | undefined;
  sprintId?: string | null | undefined;
  labelIds?: string[] | undefined;
}

/** What the caller writes alongside the ids, resolved by the check itself. */
export interface ValidatedTaskRefs {
  statusName: string | null;
  sprintName: string | null;
  assigneeSnapshot: IdentitySnapshot | null;
}

/**
 * Validate that every reference a task write carries belongs to `projectId`,
 * and resolve the values that travel with those ids.
 *
 * This is the single gate every task write passes through — create, single
 * update and bulk update alike. A reference that does not resolve inside the
 * project is a 404, never a 403 and never a 400, so an id belonging to another
 * project or another tenant is indistinguishable from one that does not exist:
 * the error text names the id the caller already supplied and nothing else.
 *
 * The denormalized `statusName`/`sprintName` and the assignee's
 * {@link IdentitySnapshot} come from the SAME lookups that prove ownership.
 * Resolving them any other way — a global `findById` on the status, sprint or
 * user — returns a real name for an id that failed no check at all, which is
 * how a cross-project write came to disclose a foreign entity's name in its
 * response and audit trail.
 *
 * Each reference kind is read with ONE batched `findByIds`, and the lookups run
 * concurrently; the assignee rides the membership row, which is both the
 * ownership proof and the identity source, so it costs no extra query.
 */
export async function validateCrossProjectRefs(
  deps: TaskRefDeps,
  projectId: string,
  refs: TaskCrossRefs,
): Promise<ValidatedTaskRefs> {
  const labelIds = refs.labelIds ?? [];
  const [taskTypes, statuses, sprints, labels] = await Promise.all([
    refs.typeId ? deps.taskTypeRepo.findByIds([refs.typeId]) : Promise.resolve([]),
    refs.statusId ? deps.statusRepo.findByIds([refs.statusId]) : Promise.resolve([]),
    refs.sprintId ? deps.sprintRepo.findByIds([refs.sprintId]) : Promise.resolve([]),
    // Labels are validated by reading the PROJECT's labels rather than the
    // submitted ids: a label that is not in this set is by definition not this
    // project's, and the check needs no second round-trip to learn that.
    labelIds.length > 0 ? deps.labelRepo.findByProject(projectId) : Promise.resolve([]),
  ]);

  if (refs.typeId) {
    const taskType = taskTypes.find((t) => t.id === refs.typeId);

    if (!taskType || taskType.projectId !== projectId) {
      throw new NotFoundError(`Task type ${refs.typeId} not found in project ${projectId}`);
    }
  }

  if (refs.statusId) {
    const status = statuses.find((s) => s.id === refs.statusId);

    if (!status || status.projectId !== projectId) {
      throw new NotFoundError(`Status ${refs.statusId} not found in project ${projectId}`);
    }
  }

  if (refs.sprintId) {
    const sprint = sprints.find((s) => s.id === refs.sprintId);

    if (!sprint || sprint.projectId !== projectId) {
      throw new NotFoundError(`Sprint ${refs.sprintId} not found in project ${projectId}`);
    }
  }

  // The assignee is proved AND named by one membership lookup. A user outside
  // this project has no membership row, so this 404 also covers a user who
  // exists in another tenant — the caller cannot tell the two apart, and no
  // name of theirs was ever read.
  let assigneeSnapshot: IdentitySnapshot | null = null;

  if (refs.assigneeId) {
    const member = await deps.projectMemberRepo.findUserIdentityByProject(refs.assigneeId, projectId);

    if (!member) {
      throw new NotFoundError(`User ${refs.assigneeId} is not a member of project ${projectId}`);
    }

    assigneeSnapshot = { displayName: member.displayName };
  }

  // Every label id must resolve to a label OF THIS PROJECT.
  if (labelIds.length > 0) {
    const own = new Set(labels.map((label) => label.id));
    const foreign = labelIds.find((id) => !own.has(id));

    if (foreign !== undefined) {
      throw new NotFoundError(`Label ${foreign} not found in project ${projectId}`);
    }
  }

  return {
    statusName: refs.statusId ? (statuses.find((s) => s.id === refs.statusId)?.name ?? null) : null,
    sprintName: refs.sprintId ? (sprints.find((s) => s.id === refs.sprintId)?.name ?? null) : null,
    assigneeSnapshot,
  };
}

/**
 * The minimum membership surface `getMyTasks` needs to decide what the
 * caller may read. Declared here (rather than importing `TenantMemberRepository`)
 * so the service states the property it needs, not the collection behind it —
 * and so a test can model it without a database.
 */
export interface TaskServiceTenantMemberRepo {
  /** Every membership the user holds, in any state. */
  findByUser(userId: string): Promise<{ tenantId: string; status: string; expiresAt: string | null }[]>;
}

/**
 * The caller identity a CROSS-TENANT read is scoped by.
 *
 * `GET /api/tasks/my` is deliberately mounted OUTSIDE the tenant-scoped sub-app
 * (`app.ts`: "auth only — no tenant context needed"), so there is no tenant in
 * the request context to forward and `requireCallerContext` cannot apply: it
 * demands a `tenantId` that by construction does not exist on this path, and
 * using it would 401 every legitimate request. This is the fail-closed
 * counterpart for the cross-tenant seam — a REQUIRED object, missing identity
 * throws 401 rather than degrading to "no scope, return everything".
 */
export interface TaskReadCaller {
  /** Acting user id — from the request context (`c.get('userId')`). */
  userId: string;
}

/**
 * Fail-closed counterpart of the old bare `userId: string` parameter: a caller
 * that reaches a cross-tenant read without an identity is a bug in the call
 * chain, not a licence to widen the query, so it throws 401.
 */
function requireTaskReadCaller(caller: TaskReadCaller): string {
  if (!caller || !caller.userId) {
    throw new UnauthorizedError('Caller context is required');
  }

  return caller.userId;
}

/**
 * How many board column queries one board page request may have in flight.
 *
 * A board can hold up to `MAX_IDS_PER_DOCUMENT` (500) columns, and an initial
 * load — no `cursor.<columnId>` params — fetches EVERY one of them. Issued as an
 * unbounded `Promise.all`, one HTTP request therefore asks the driver for up to
 * ~500 concurrent connections while the pool holds `maxPoolSize: 5`. The pool
 * QUEUES rather than fails, so nothing breaks — but every queued checkout sits
 * behind the slowest of the first five, and a board request becomes a head-of-
 * line blocker for every OTHER request sharing the Worker's pool.
 *
 * 5 matches `maxPoolSize` exactly: the board keeps the pool fully busy (the
 * queries are keyset-bounded and cheap, so throughput is what matters) while
 * never asking for a connection the pool cannot hand out. A smaller width would
 * idle the pool; a larger one would only deepen the queue.
 */
export const BOARD_COLUMN_CONCURRENCY = 5;

/**
 * `items.map(fn)` with at most `width` calls in flight, results in input order.
 *
 * Deliberately NOT `$facet`: the board's per-column cursors are independent
 * keyset queries, and folding them into one aggregation would collapse that
 * paging model. The bound is applied here, above the unchanged queries.
 */
async function mapWithConcurrency<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // `next` only advances while a slot is free, so every index is claimed
      // exactly once and no index is left unfilled.
      const item = items[index] as T;

      results[index] = await fn(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));

  return results;
}

export interface BoardPagesOptions {
  /**
   * Decoded resume cursors by board column id. Entries that are absent load
   * the first page; an empty map is the initial load of every column.
   */
  // `| undefined` — the board route forwards the parsed `BoardQuerySchema`
  // object, whose absent filters are explicit `undefined`s.
  cursors?: Record<string, BoardPageCursor> | undefined;
  sprintId?: string | undefined;
  assigneeId?: string | undefined;
  priorityLevel?: number | undefined;
}

// ─── Task Service ────────────────────────────────────────────────────────────

export class TaskService {
  constructor(
    private readonly taskRepo: TaskRepository,
    private readonly counterService: CounterService,
    private readonly projectRepo: ProjectRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly statusRepo: StatusRepository,
    private readonly taskTypeRepo: TaskTypeRepository,
    private readonly userRepo: TaskServiceUserRepo,
    private readonly sprintRepo: TaskServiceSprintRepo,
    private readonly commentRepo: TaskServiceCommentRepo,
    private readonly relationshipRepo: TaskServiceRelationshipRepo,
    private readonly auditService: AuditService | undefined,
    private readonly boardRepo: TaskServiceBoardRepo | undefined,
    private readonly tenantMemberRepo: TaskServiceTenantMemberRepo,
    private readonly labelRepo: TaskServiceLabelRepo,
  ) {}

  // ─── Tenant / project scope ───────────────────────────────────────────────

  /**
   * (read path): the project must belong to the caller's
   * tenant, otherwise 404 — never 403, so a foreign project id looks exactly
   * like a nonexistent one. The caller context is REQUIRED; a missing one
   * throws (401) instead of silently skipping the check (fail closed).
   */
  private async assertProjectScope(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId } = requireCallerContext(context);

    return assertProjectInTenant(this.projectRepo, projectId, tenantId);
  }

  /**
   * (write path): tenant scope FIRST (404 on a foreign
   * project), then the RBAC matrix via {@link ensurePermission} — no ad-hoc
   * role strings, no fail-open early return.
   *
   * @returns the resolved project so callers can audit-log without a second lookup.
   */
  private async assertTaskPermission(
    action: 'create_task' | 'edit_task' | 'delete_task',
    projectId: string,
    context: CallerContext,
  ): Promise<{ tenantId: string }> {
    const { tenantId, userId, userRole } = requireCallerContext(context);
    // The WRITABLE seam — tenant scope first (404 on a foreign project),
    // then the single server-owned rule that a project scheduled for deletion is
    // read-only, then the RBAC matrix. One seam covers create, update, delete
    // and the bulk update, so a task can no longer be added to (or removed from)
    // a project whose data is about to be purged.
    const project = await assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);
    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    ensurePermission(action, userRole, membership?.role ?? null);

    return project;
  }

  // ─── Task CRUD ────────────────────────────────────────────────────────────

  /**
   * List tasks of a project. `options` (including the F7 `hasSprint` filter) is
   * forwarded to the repository UNCHANGED — the sprint-filter semantics live
   * entirely in `TaskQuerySchema` + `TaskRepository.findByProject`.
   */
  async getTasksByProject(
    projectId: string,
    options: TaskQueryOptions,
    context: CallerContext,
  ): Promise<PaginatedResult<Task>> {
    await this.assertProjectScope(projectId, context);

    return this.taskRepo.findByProject(projectId, options);
  }

  /**
   * Board view: lightweight card projection. The repository applies the
   * exclusion projection server-side; this mapper guarantees the exact
   * BoardTask DTO shape (no description/reporter/timestamp leakage) while the
   * generic list response contract stays untouched.
   */
  async getBoardTasks(
    projectId: string,
    options: TaskQueryOptions,
    context: CallerContext,
  ): Promise<PaginatedResult<BoardTask>> {
    await this.assertProjectScope(projectId, context);

    const result = await this.taskRepo.findByProject(projectId, { ...options, view: 'board' });

    return {
      ...result,
      data: result.data.map((task) => ({
        id: task.id,
        number: task.number,
        title: task.title,
        typeId: task.typeId,
        statusId: task.statusId,
        priorityLevel: task.priorityLevel,
        assigneeId: task.assigneeId,
        assigneeSnapshot: task.assigneeSnapshot,
        version: task.version,
      })),
    };
  }

  /**
   * Board column pages: one HTTP request serves every requested column, each
   * column running its own keyset query — in parallel, but through a bounded
   * worker pool (see {@link BOARD_COLUMN_CONCURRENCY}) rather than an unbounded
   * `Promise.all`. No `$facet`, no `skip`, no `countDocuments` on this path: the
   * per-column keyset paging the board depends on is unchanged, only the number
   * of queries in flight at once is capped.
   *
   * Columns resolve server-side from the project's `BoardConfig` — callers
   * pass opaque cursors by column id and can never inject arbitrary
   * `statusIds`. An empty cursor map is the initial load (first page of every
   * column); a non-empty map loads only the listed columns. Overlapping
   * `statusIds` across columns resolve to a single owner column (most
   * specific, then lowest position) — the same V4-12 semantics the board UI
   * applies client-side, so no card renders twice.
   */
  async getBoardPages(projectId: string, options: BoardPagesOptions, context: CallerContext): Promise<BoardPage> {
    await this.assertProjectScope(projectId, context);

    if (!this.boardRepo) {
      throw new Error('Board repository is not configured');
    }

    const board = await this.boardRepo.findByProject(projectId);

    if (!board) {
      throw new NotFoundError('Board not found');
    }

    const { cursors = {}, sprintId, assigneeId, priorityLevel } = options;
    const cursorIds = new Set(Object.keys(cursors));

    for (const columnId of cursorIds) {
      if (!board.columns.some((column) => column.id === columnId)) {
        throw new ValidationError(`Unknown board column: ${columnId}`);
      }
    }

    const wanted = cursorIds.size === 0 ? board.columns : board.columns.filter((column) => cursorIds.has(column.id));
    const ownerByStatusId = new Map<string, BoardColumn>();

    for (const column of [...board.columns].sort(
      (a, z) => a.statusIds.length - z.statusIds.length || a.position - z.position,
    )) {
      for (const statusId of column.statusIds) {
        if (!ownerByStatusId.has(statusId)) ownerByStatusId.set(statusId, column);
      }
    }

    const entries = await mapWithConcurrency(wanted, BOARD_COLUMN_CONCURRENCY, async (column) => {
      const exclusiveStatusIds = column.statusIds.filter((statusId) => ownerByStatusId.get(statusId) === column);
      const result = await this.taskRepo.findBoardPage(projectId, {
        statusIds: exclusiveStatusIds,
        cursor: cursors[column.id] ?? null,
        sprintId,
        assigneeId,
        priorityLevel,
      });
      const page: BoardColumnPage = {
        tasks: result.tasks.map((task) => ({
          id: task.id,
          number: task.number,
          title: task.title,
          typeId: task.typeId,
          statusId: task.statusId,
          priorityLevel: task.priorityLevel,
          assigneeId: task.assigneeId,
          assigneeSnapshot: task.assigneeSnapshot,
          version: task.version,
        })),
        hasMore: result.hasMore,
        nextCursor: result.hasMore && result.nextCursor ? encodeBoardCursor(result.nextCursor) : null,
      };

      return [column.id, page] as const;
    });

    return Object.fromEntries(entries);
  }

  /**
   * Per-status task counts for the project overview — a single
   * `$match` + `$group` aggregation instead of one count per status.
   */
  async getStatusSummary(projectId: string, context: CallerContext): Promise<{ statusId: string; count: number }[]> {
    await this.assertProjectScope(projectId, context);

    return this.taskRepo.countByStatusGrouped(projectId);
  }

  /**
   * Tasks assigned to the user ("My Tasks"), scoped to the tenants they may
   * currently read.
   *
   * The caller identity is REQUIRED and the query is membership-scoped.
   * Before, this method took a bare `userId` and the repository filtered
   * `{ assigneeId: userId }` alone, so a REVOKED or EXPIRED member kept a read
   * channel into every task ever assigned to them, in every tenant. The
   * membership seam (`tenant_members`) already existed — it was simply not on
   * this path.
   *
   * "Active" follows the DEC-055 lazy-expiry rule the rest of the codebase uses
   * (see `isMembershipExpired`): an ACTIVE membership past its `expiresAt` is
   * treated as ACCESS_REVOKED. A caller with no readable tenant gets `[]`
   * without a query — the empty scope is the closed door, not an error.
   */
  async getMyTasks(caller: TaskReadCaller, limit = 50): Promise<Task[]> {
    const userId = requireTaskReadCaller(caller);
    const tenantIds = await this.readableTenantIds(userId);

    if (tenantIds.length === 0) {
      return [];
    }

    const projects = await Promise.all(tenantIds.map((tenantId) => this.projectRepo.findByTenant(tenantId)));
    const projectIds = projects.flat().map((project) => project.id);

    if (projectIds.length === 0) {
      return [];
    }

    return this.taskRepo.findAssignedTo(userId, projectIds, limit);
  }

  /** The tenants whose ACTIVE, unexpired membership the caller still holds. */
  private async readableTenantIds(userId: string): Promise<string[]> {
    const memberships = await this.tenantMemberRepo.findByUser(userId);
    const now = Date.now();

    return memberships
      .filter(
        (membership) =>
          membership.status === MemberStatus.ACTIVE &&
          (membership.expiresAt === null || new Date(membership.expiresAt).getTime() > now),
      )
      .map((membership) => membership.tenantId);
  }

  async getTask(id: string, context: CallerContext): Promise<Task> {
    const { tenantId } = requireCallerContext(context);
    const task = await this.taskRepo.findById(id);

    if (!task) {
      throw new NotFoundError('Task not found');
    }

    // Resolve the owning project's tenant — a bare task id must never
    // cross tenant boundaries (404, not 403, to avoid existence leaks).
    // This resolves the OWNING project of a task addressed by a bare id and
    // is shared by reads and writes, so it stays the tenant-only variant; the
    // write methods assert the write rule through `assertTaskPermission`.
    await assertProjectInTenant(this.projectRepo, task.projectId, tenantId, 'Task');

    return task;
  }

  /**
   * The ONE resolution of a `:taskId` path value, whichever of the two accepted
   * forms it takes.
   *
   * `PATH_PARAM_SCHEMAS.taskId` accepts a bare UUID OR `KEY-NUMBER`, so every
   * route holding a `:taskId` MUST honour both — otherwise the schema promises a
   * form the route silently 404s. That was the state of the API: only
   * `GET /tasks/:taskId` branched on the key, while PATCH, DELETE and the two
   * comment routes passed the same string to `findById`. Resolving here, once,
   * is what keeps the accepted form and the honoured form from drifting again.
   *
   * Resolution is tenant-scoped, not merely "does this key exist": the project
   * key is only unique WITHIN a tenant, so the project is resolved through
   * `findByTenantAndKey` — a global key lookup would let a caller act on a task
   * of another tenant that happened to use the same project key. A key that does
   * not resolve inside the caller's tenant is a 404, identical to a key that
   * does not exist, so this is not an existence oracle.
   *
   * A bare UUID is returned unchanged: it is resolved (and tenant-asserted) by
   * the operation that acts on it, which must do so anyway.
   */
  async resolveTaskId(ref: string, context: CallerContext): Promise<string> {
    const parsed = parseTaskRef(ref);

    if (parsed.kind === 'uuid') {
      return parsed.taskId;
    }

    const task = await this.getTaskByKey(context, parsed.projectKey, parsed.number);

    return task.id;
  }

  /**
   * Tenant-scoped KEY-NUMBER lookup behind {@link resolveTaskId}. The project
   * key is only unique within a tenant, so the project MUST be resolved through
   * `findByTenantAndKey`.
   */
  async getTaskByKey(context: CallerContext, projectKey: string, number: number): Promise<Task> {
    const { tenantId } = requireCallerContext(context);
    const project = await this.projectRepo.findByTenantAndKey(tenantId, projectKey);

    if (!project) {
      throw new NotFoundError('Project not found');
    }

    const task = await this.taskRepo.findByProjectAndNumber(project.id, number);

    if (!task) {
      throw new NotFoundError('Task not found');
    }
    return task;
  }
  // `getTaskByNumber(projectId, number, context)` was removed as dead code.
  // No route exposes it — the canonical task route is `/tasks/:taskId`, resolved
  // through `getTaskById`. The `ABC-123` numbering stays in the domain (the task
  // table renders it and the board sorts by it), it just has no lookup endpoint.

  async createTask(projectId: string, input: CreateTask, context: CallerContext): Promise<Task> {
    const { userId } = requireCallerContext(context);

    // Tenant scope FIRST (404 on a foreign project), then the RBAC matrix.
    await this.assertTaskPermission('create_task', projectId, context);

    // Validate project exists and is ACTIVE
    const project = await this.projectRepo.findById(projectId);

    if (!project) {
      throw new NotFoundError('Project not found');
    }

    if (project.status !== ProjectStatus.ACTIVE) {
      throw new AppError(400, 'PROJECT_ARCHIVED', 'Cannot create tasks in an archived project');
    }

    // Every reference is validated together, BEFORE anything is written, and
    // the denormalized names + the assignee snapshot come back from that same
    // check — no second, unscoped lookup to name a foreign entity.
    const { statusName, sprintName, assigneeSnapshot } = await validateCrossProjectRefs(this.refDeps, projectId, {
      typeId: input.typeId,
      statusId: input.statusId,
      assigneeId: input.assigneeId,
      sprintId: input.sprintId,
      labelIds: input.labelIds,
    });
    // Capture identity snapshots (pure reads — deliberately OUTSIDE the numbering
    // retry below, so a retried insert does not re-read them).
    const createdBySnapshot = await this.captureIdentitySnapshot(userId);
    const reporterSnapshot = createdBySnapshot; // reporter is the creator at creation time
    // Allocate the number and insert, retrying ONLY a lost numbering race.
    const task = await this.createWithAllocatedNumber({
      projectId,
      typeId: input.typeId,
      title: input.title,
      description: input.description,
      statusId: input.statusId,
      statusName,
      sprintName,
      priorityLevel: input.priorityLevel,
      reporterId: userId,
      reporterSnapshot,
      assigneeId: input.assigneeId,
      ...(assigneeSnapshot ? { assigneeSnapshot } : {}),
      sprintId: input.sprintId,
      labelIds: input.labelIds,
      createdById: userId,
      createdBySnapshot,
    });

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: project.tenantId,
        projectId,
        entityType: 'TASK',
        entityId: task.id,
        action: 'CREATED',
        actorId: userId,
      });
    }

    return task;
  }

  /**
   * Allocate a task number and insert, retrying ONLY a lost numbering race.
   *
   * The number is allocated by an ATOMIC counter
   * (`CounterRepository.getNextValue` → `findOneAndUpdate` `$inc` + upsert), so
   * two concurrent creates normally receive different numbers and never collide
   * on the unique `tasks {projectId, number}` index. This loop therefore
   * does not exist to make ordinary concurrency safe — it is the recovery path
   * for the case the counter alone cannot cover: the counter document sits
   * BEHIND the highest `number` actually stored (a restored backup, a migrated
   * or hand-written row, a wiped `counters` collection), so the freshly
   * allocated number is already taken. Re-allocating is the correct fix: the
   * counter advances past the collision and the insert succeeds.
   *
   * Three properties are load-bearing:
   *
   * - **Only the numbering index is retried** ({@link isTaskNumberConflict}). Any
   *   other `E11000` — a duplicate `tasks.id`, a duplicate member pair, a
   *   duplicate slug — is a real conflict that must reach the mapping that turns
   *   it into a domain 409, not be swallowed by a retry.
   * - **The attempt re-allocates.** Retrying the same number would collide again
   *   by construction, so the counter call is INSIDE the loop.
   * - **Exhaustion is a domain error, never a driver error.** A 503
   *   (`TASK_NUMBER_UNAVAILABLE`) tells the client this is transient and
   *   retryable, which is what a stuck counter is; 409 would claim the client
   *   caused a conflict, and letting the raw `E11000` through would surface the
   *   index name and the collection name in a 500.
   */
  private async createWithAllocatedNumber(draft: TaskInsertDraft): Promise<Task> {
    for (let attempt = 1; attempt <= MAX_TASK_NUMBER_ATTEMPTS; attempt += 1) {
      const number = await this.counterService.getNextTaskNumber(draft.projectId);

      try {
        return await this.taskRepo.create({ ...draft, number });
      } catch (err) {
        if (!isTaskNumberConflict(err)) throw err;

        if (attempt === MAX_TASK_NUMBER_ATTEMPTS) {
          throw new AppError(
            503,
            'TASK_NUMBER_UNAVAILABLE',
            'Could not allocate a task number for this project — please try again',
          );
        }
      }
    }

    // Unreachable: the loop either returns or throws on its last iteration.
    throw new AppError(503, 'TASK_NUMBER_UNAVAILABLE', 'Could not allocate a task number for this project');
  }

  async updateTask(taskId: string, input: UpdateTask, context: CallerContext): Promise<Task> {
    const { userId } = requireCallerContext(context);
    const task = await this.taskRepo.findById(taskId);

    if (!task) {
      throw new NotFoundError('Task not found');
    }

    // V2-4: the route path carries no projectId, so authorization is enforced
    // here — the owning project is tenant-asserted FIRST (404 on a foreign
    // task), then the RBAC matrix is applied (tenant Owner/Admin bypass is
    // handled inside the matrix). No fail-open early return.
    await this.assertTaskPermission('edit_task', task.projectId, context);

    // Optimistic concurrency check
    if (task.version !== input.version) {
      throw new ConflictError(
        `Task was modified concurrently. Current version: ${task.version}, provided version: ${input.version}`,
        'TASK_VERSION_CONFLICT',
      );
    }

    // ONE validation of every reference the caller supplied, before a single
    // field is written. It used to cover `labelIds` only: `statusId`, `typeId`,
    // `sprintId` and `assigneeId` were written unchecked and their denormalized
    // names were read from unscoped `findById`s, so a PATCH could attach another
    // tenant's status, sprint or user to a task and return that entity's name in
    // the response and the audit trail. A foreign reference is now a 404 —
    // indistinguishable from a nonexistent one, matching the project-scope asserts.
    const { statusName, sprintName, assigneeSnapshot } = await validateCrossProjectRefs(this.refDeps, task.projectId, {
      typeId: input.typeId,
      statusId: input.statusId,
      assigneeId: input.assigneeId,
      sprintId: input.sprintId,
      labelIds: input.labelIds,
    });
    // Build update payload for changed fields only
    const update: Record<string, unknown> = {};

    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.statusId !== undefined) {
      update.statusId = input.statusId;
      // Keep the denormalized sort name in sync with the status change
      update.statusName = statusName;
    }
    if (input.priorityLevel !== undefined) update.priorityLevel = input.priorityLevel;
    if (input.typeId !== undefined) update.typeId = input.typeId;
    if (input.sprintId !== undefined) {
      update.sprintId = input.sprintId;
      // Keep the denormalized sort name in sync with the sprint change
      update.sprintName = sprintName;
    }
    if (input.labelIds !== undefined) update.labelIds = input.labelIds;

    // `assigneeId: null` is UNASSIGN, not a reference — the schema uses null to
    // clear the field, so it clears the snapshot with it instead of being sent
    // through the ownership check as if it named someone.
    if (input.assigneeId !== undefined) {
      update.assigneeId = input.assigneeId;
      update.assigneeSnapshot = assigneeSnapshot;
    }

    const updated = await this.taskRepo.updateWithVersion(
      taskId,
      input.version,
      update as Parameters<TaskRepository['updateWithVersion']>[2],
    );

    if (!updated) {
      throw new ConflictError('Task was modified concurrently', 'TASK_VERSION_CONFLICT');
    }

    // Audit side effect
    if (this.auditService) {
      const project = await this.projectRepo.findById(updated.projectId);
      const changes: AuditChange[] = [];

      if (input.title !== undefined) changes.push({ field: 'title', oldValue: task.title, newValue: input.title });
      if (input.statusId !== undefined)
        changes.push({ field: 'statusId', oldValue: task.statusId, newValue: input.statusId });
      if (input.priorityLevel !== undefined)
        changes.push({ field: 'priorityLevel', oldValue: task.priorityLevel, newValue: input.priorityLevel });
      if (input.assigneeId !== undefined)
        changes.push({ field: 'assigneeId', oldValue: task.assigneeId, newValue: input.assigneeId });
      if (input.typeId !== undefined) changes.push({ field: 'typeId', oldValue: task.typeId, newValue: input.typeId });
      if (input.sprintId !== undefined)
        changes.push({ field: 'sprintId', oldValue: task.sprintId, newValue: input.sprintId });
      if (input.description !== undefined)
        changes.push({ field: 'description', oldValue: task.description, newValue: input.description });
      if (input.labelIds !== undefined)
        changes.push({ field: 'labelIds', oldValue: task.labelIds, newValue: input.labelIds });
      await this.auditService.log({
        tenantId: project?.tenantId ?? '',
        projectId: updated.projectId,
        entityType: 'TASK',
        entityId: updated.id,
        action: 'UPDATED',
        actorId: userId,
        changes,
      });
    }

    return updated;
  }

  async deleteTask(taskId: string, context: CallerContext): Promise<void> {
    const { userId } = requireCallerContext(context);
    const task = await this.taskRepo.findById(taskId);

    if (!task) {
      throw new NotFoundError('Task not found');
    }

    // V2-4: see updateTask — tenant scope first (404), then the RBAC matrix.
    await this.assertTaskPermission('delete_task', task.projectId, context);

    // Cascade delete: comments, relationships, label associations
    await this.commentRepo.deleteByTask(taskId);
    await this.relationshipRepo.deleteByTask(taskId);

    // Audit side effect (before hard delete)
    if (this.auditService && userId) {
      const project = await this.projectRepo.findById(task.projectId);

      await this.auditService.log({
        tenantId: project?.tenantId ?? '',
        projectId: task.projectId,
        entityType: 'TASK',
        entityId: task.id,
        action: 'DELETED',
        actorId: userId,
      });
    }

    // Hard delete the task
    await this.taskRepo.delete(taskId);
  }

  /**
   * Bulk status/assignee/sprint update.
   * Authorization mirrors single-task `updateTask` (`edit_task` via
   * `ensurePermission`, project role resolved server-side). Tasks that do not
   * exist or belong to another project are reported per-id in `failed` —
   * they never throw. Each task is updated with the same optimistic-concurrency
   * semantics as the single update (`updateWithVersion`: `$inc version`,
   * `updatedAt` bump) and gets its own audit event.
   */
  async bulkUpdateTasks(
    projectId: string,
    taskIds: string[],
    // The bulk PATCH body is validated but every field is optional, so the
    // route forwards explicit `undefined`s for the ones the client omitted.
    data: {
      statusId?: string | undefined;
      assigneeId?: string | null | undefined;
      sprintId?: string | null | undefined;
    },
    context: CallerContext,
  ): Promise<BulkUpdateTasksResult> {
    const { userId } = requireCallerContext(context);

    // Tenant scope FIRST (404 on a foreign project), then the RBAC matrix —
    // same action as the single-task update.
    await this.assertTaskPermission('edit_task', projectId, context);

    // The bulk path had the same hole as the single update and reached the same
    // unscoped `findById`s, so it goes through the SAME check rather than a
    // second copy of it. One validation rejects the WHOLE request: a bulk patch
    // applies one payload to many tasks, so a reference that is not this
    // project's is refused before any task is touched rather than being skipped
    // per id, which would leave the caller believing a subset had been updated.
    const { statusName, sprintName, assigneeSnapshot } = await validateCrossProjectRefs(this.refDeps, projectId, {
      statusId: data.statusId,
      sprintId: data.sprintId,
      assigneeId: data.assigneeId,
    });
    // Build the shared update payload once (single-field contract is enforced by Zod)
    const update: TaskUpdatePayload = {};

    if (data.statusId !== undefined) {
      update.statusId = data.statusId;
      // Keep the denormalized sort name in sync with the status change
      update.statusName = statusName;
    }
    if (data.sprintId !== undefined) {
      update.sprintId = data.sprintId;
      // Keep the denormalized sort name in sync with the sprint change
      update.sprintName = sprintName;
    }
    if (data.assigneeId !== undefined) {
      update.assigneeId = data.assigneeId;
      // `null` clears the assignment, so it clears the snapshot too.
      update.assigneeSnapshot = assigneeSnapshot;
    }

    // Resolve all requested tasks in one query; missing/wrong-project ids → failed
    const found = await this.taskRepo.findByIds(taskIds);
    const failed: BulkUpdateTaskFailure[] = [];
    const valid: Task[] = [];
    const seen = new Set<string>();

    for (const id of taskIds) {
      const task = found.find((t) => t.id === id);

      if (!task) {
        failed.push({ taskId: id, reason: 'TASK_NOT_FOUND' });
      } else if (task.projectId !== projectId) {
        failed.push({ taskId: id, reason: 'TASK_NOT_IN_PROJECT' });
      } else if (seen.has(id)) {
        continue; // duplicate id — apply once
      } else {
        seen.add(id);
        valid.push(task);
      }
    }

    // TOP-3 №1: ONE bulkWrite with per-task `{ id, version }` filters — per-task
    // optimistic concurrency and per-task failures preserved without N
    // sequential round-trips. Returns only the tasks whose version matched
    // (and was incremented); the rest are conflicts.
    const updatedTasks = await this.taskRepo.bulkUpdateWithVersion(
      valid.map((task) => ({ id: task.id, version: task.version })),
      update,
    );
    const updatedIds = new Set(updatedTasks.map((t) => t.id));
    // Hoisted: one project lookup serves the audit events of every updated task.
    let project: Awaited<ReturnType<ProjectRepository['findById']>> | null = null;

    if (this.auditService && userId) {
      project = await this.projectRepo.findById(projectId);
    }

    let updated = 0;
    const auditEvents: {
      tenantId: string;
      projectId: string | null;
      entityType: 'TASK';
      entityId: string;
      action: 'UPDATED';
      changes: AuditChange[];
    }[] = [];

    for (const task of valid) {
      if (!updatedIds.has(task.id)) {
        failed.push({ taskId: task.id, reason: 'VERSION_CONFLICT' });
        continue;
      }
      updated++;

      // Per-task audit event — persisted as ONE batch after the loop (TOP-3 №2)
      if (this.auditService && userId) {
        const changes: AuditChange[] = [];

        if (data.statusId !== undefined)
          changes.push({ field: 'statusId', oldValue: task.statusId, newValue: data.statusId });
        if (data.assigneeId !== undefined)
          changes.push({ field: 'assigneeId', oldValue: task.assigneeId, newValue: data.assigneeId });
        if (data.sprintId !== undefined)
          changes.push({ field: 'sprintId', oldValue: task.sprintId, newValue: data.sprintId });

        auditEvents.push({
          tenantId: project?.tenantId ?? '',
          projectId,
          entityType: 'TASK',
          entityId: task.id,
          action: 'UPDATED',
          changes,
        });
      }
    }

    // One batched audit write instead of N sequential inserts.
    if (this.auditService && userId && auditEvents.length > 0) {
      await this.auditService.logMany(userId, auditEvents);
    }

    return { updated, ...(failed.length > 0 ? { failed } : {}) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * The repositories {@link validateCrossProjectRefs} reads through.
   *
   * Assembled per call from the injected graph so the check always reads the
   * same repositories the service owns — the function has no state of its own
   * and cannot drift onto a different seam than the one wired here.
   */
  private get refDeps(): TaskRefDeps {
    return {
      taskTypeRepo: this.taskTypeRepo,
      statusRepo: this.statusRepo,
      sprintRepo: this.sprintRepo,
      labelRepo: this.labelRepo,
      projectMemberRepo: this.projectMemberRepo,
    };
  }

  /**
   * Capture an identity snapshot for the CALLER.
   *
   * Only ever applied to the acting user, whose id came from the verified
   * token. An assignee's identity is not read here: it is resolved through
   * their project membership by {@link validateCrossProjectRefs}, so a
   * caller can never use this to name a user outside their own project.
   */
  private async captureIdentitySnapshot(userId: string): Promise<IdentitySnapshot> {
    const user = await this.userRepo.findById(userId);

    return {
      displayName: user?.displayName ?? user?.name ?? user?.email ?? 'Unknown User',
    };
  }
}
