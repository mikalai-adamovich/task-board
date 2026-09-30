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
   * column running its own keyset query in parallel (`Promise.all` — no
   * `$facet`, no `skip`, no `countDocuments` on this path).
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

    const entries = await Promise.all(
      wanted.map(async (column) => {
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
      }),
    );

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
   * Tenant-scoped KEY-NUMBER lookup. The project key is only unique
   * within a tenant, so the project MUST be resolved through
   * `findByTenantAndKey` — a global key lookup let callers read tasks of
   * another tenant that happened to use the same project key.
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

    // Validate cross-project references — returns the denormalized sort names
    // resolved from the SAME batched lookups (no extra findById).
    const { statusName, sprintName } = await this.validateCrossProjectRefs(projectId, {
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
    let assigneeSnapshot: IdentitySnapshot | undefined;

    if (input.assigneeId) {
      assigneeSnapshot = await this.captureIdentitySnapshot(input.assigneeId);
    }

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
      assigneeSnapshot,
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

    // Build update payload for changed fields only
    const update: Record<string, unknown> = {};

    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.statusId !== undefined) {
      update.statusId = input.statusId;
      // Keep the denormalized sort name in sync with the status change
      update.statusName = (await this.statusRepo.findById(input.statusId))?.name ?? null;
    }
    if (input.priorityLevel !== undefined) update.priorityLevel = input.priorityLevel;
    if (input.typeId !== undefined) update.typeId = input.typeId;
    if (input.sprintId !== undefined) {
      update.sprintId = input.sprintId;
      // Keep the denormalized sort name in sync with the sprint change
      update.sprintName = input.sprintId ? ((await this.sprintRepo.findById(input.sprintId))?.name ?? null) : null;
    }
    if (input.labelIds !== undefined) {
      // The update path persisted `labelIds` unvalidated, so the project
      // check that `createTask` performs was bypassable by PATCHing a task
      // instead of POSTing one. Both writes now go through the same assert.
      await this.validateCrossProjectRefs(task.projectId, { labelIds: input.labelIds });
      update.labelIds = input.labelIds;
    }

    // Handle assignee change with snapshot
    if (input.assigneeId !== undefined) {
      update.assigneeId = input.assigneeId;
      if (input.assigneeId) {
        update.assigneeSnapshot = await this.captureIdentitySnapshot(input.assigneeId);
      } else {
        update.assigneeSnapshot = null;
      }
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

    // Build the shared update payload once (single-field contract is enforced by Zod)
    const update: TaskUpdatePayload = {};

    if (data.statusId !== undefined) {
      update.statusId = data.statusId;
      // Keep the denormalized sort name in sync with the status change
      update.statusName = (await this.statusRepo.findById(data.statusId))?.name ?? null;
    }
    if (data.sprintId !== undefined) {
      update.sprintId = data.sprintId;
      // Keep the denormalized sort name in sync with the sprint change
      update.sprintName = data.sprintId ? ((await this.sprintRepo.findById(data.sprintId))?.name ?? null) : null;
    }
    if (data.assigneeId !== undefined) {
      update.assigneeId = data.assigneeId;
      update.assigneeSnapshot = data.assigneeId ? await this.captureIdentitySnapshot(data.assigneeId) : null;
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
   * Capture an identity snapshot for a user.
   */
  private async captureIdentitySnapshot(userId: string): Promise<IdentitySnapshot> {
    const user = await this.userRepo.findById(userId);

    return {
      displayName: user?.displayName ?? user?.name ?? user?.email ?? 'Unknown User',
    };
  }

  /**
   * Validate that all referenced entities belong to the same project.
   *
   * Each reference kind is resolved with ONE batched `findByIds` query
   * and the three lookups run concurrently — the previous implementation
   * awaited a sequential `findById` per ref (up to 4 round-trips per
   * create/update). `projectId` ownership is validated in code afterwards.
   */
  private async validateCrossProjectRefs(
    projectId: string,
    refs: {
      typeId?: string | undefined;
      statusId?: string | undefined;
      assigneeId?: string | undefined;
      sprintId?: string | undefined;
      labelIds?: string[] | undefined;
    },
  ): Promise<{ statusName: string | null; sprintName: string | null }> {
    const labelIds = refs.labelIds ?? [];
    const [taskTypes, statuses, sprints, labels] = await Promise.all([
      refs.typeId ? this.taskTypeRepo.findByIds([refs.typeId]) : Promise.resolve([]),
      refs.statusId ? this.statusRepo.findByIds([refs.statusId]) : Promise.resolve([]),
      refs.sprintId ? this.sprintRepo.findByIds([refs.sprintId]) : Promise.resolve([]),
      // Labels were the one reference `labelIds` accepted WITHOUT a
      // project check, so a task could carry a label id from another project —
      // and from another tenant, since nothing ever compared the two. Read the
      // PROJECT's labels (not the ids) so the check needs no second round-trip.
      labelIds.length > 0 ? this.labelRepo.findByProject(projectId) : Promise.resolve([]),
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

    // The denormalized sort names come from the SAME batched lookups —
    // no additional round-trips.
    const statusName = refs.statusId ? (statuses.find((s) => s.id === refs.statusId)?.name ?? null) : null;
    const sprintName = refs.sprintId ? (sprints.find((s) => s.id === refs.sprintId)?.name ?? null) : null;

    if (refs.assigneeId) {
      const member = await this.projectMemberRepo.findByUserAndProject(refs.assigneeId, projectId);

      if (!member) {
        throw new NotFoundError(`User ${refs.assigneeId} is not a member of project ${projectId}`);
      }
    }

    // Every label id must resolve to a label OF THIS PROJECT. 404 (not
    // 400/403) so a foreign label id is indistinguishable from a nonexistent one
    // — the same indistinguishability rule the project-scope asserts follow.
    if (labelIds.length > 0) {
      const own = new Set(labels.map((label) => label.id));
      const foreign = labelIds.find((id) => !own.has(id));

      if (foreign !== undefined) {
        throw new NotFoundError(`Label ${foreign} not found in project ${projectId}`);
      }
    }

    return { statusName, sprintName };
  }
}
