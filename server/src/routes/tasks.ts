import { Hono } from 'hono';
import type { Context } from 'hono';
import { decodeBoardCursor, InvalidBoardCursorError } from '@task-board/shared';
import type { BoardPageCursor } from '@task-board/shared';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody, validateQuery } from '../middleware/validation.js';
import { requirePermission } from '../middleware/rbac.js';
import { ValidationError } from '../errors/app-error.js';
import { uuid } from '../validators/common.js';
import type { TaskQueryOptions } from '../repositories/task.repository.js';
import {
  BoardPageQuerySchema,
  BulkUpdateTasksSchema,
  CreateTaskSchema,
  TaskQuerySchema,
  UpdateTaskSchema,
} from '../schemas/task.js';
import type { CallerContext } from '../services/tenant-assert.js';

/** Prefix for per-column resume cursors (`cursor.<columnId>=<opaque>`). */
const BOARD_CURSOR_PREFIX = 'cursor.';

/**
 * The caller context is ALWAYS forwarded to the service
 * layer. It is taken from the request context set by the auth /
 * tenant-context middleware — never from the path or the body — and the
 * service treats it as required (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

// ─── Task Routes ─────────────────────────────────────────────────────────────

export function createTaskRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /projects/:projectId/tasks — List tasks with filters, pagination, sort.
   * Query is validated via Zod (bounded page/limit, whitelisted sort fields,
   * ISO date ranges) — invalid input → 400 instead of NaN reaching MongoDB.
   */
  router.get('/projects/:projectId/tasks', validateQuery(TaskQuerySchema), async (c) => {
    const projectId = param(c, 'projectId');
    const q = c.req.valid('query');
    const [sortField, sortDirection] = q.sort ? q.sort.split(':') : [];
    const options: TaskQueryOptions = {
      page: q.page,
      limit: q.limit,
      // Tables/widgets omit the (potentially large) markdown description
      excludeDescription: q.excludeDescription,
      view: q.view,
      search: q.search,
      statusId: q.statusId,
      priorityLevel: q.priorityLevel,
      typeId: q.typeId,
      assigneeId: q.assigneeId,
      reporterId: q.reporterId,
      sprintId: q.sprintId,
      // Tri-state "has a sprint" filter (`hasSprint=false` = the backlog)
      hasSprint: q.hasSprint,
      labelId: q.labelId,
      createdFrom: q.createdFrom,
      createdTo: q.createdTo,
      updatedFrom: q.updatedFrom,
      updatedTo: q.updatedTo,
      sort: sortField && sortDirection ? { field: sortField, direction: sortDirection as 'asc' | 'desc' } : undefined,
    };
    // Board view: dedicated lightweight BoardTask projection (no description/
    // reporter/timestamp fields) — the generic list contract is untouched.
    const result =
      q.view === 'board'
        ? await c.get('svc').tasks.getBoardTasks(projectId, options, callerContext(c))
        : await c.get('svc').tasks.getTasksByProject(projectId, options, callerContext(c));

    return c.json({ data: result.data, pagination: result.pagination });
  });

  /**
   * GET /projects/:projectId/tasks/status-summary — per-status task
   * counts in one server-side aggregation (the project overview previously
   * issued one list request per status). Same read pattern as the list route:
   * tenant context resolves the project role, no coarse route gate.
   */
  router.get('/projects/:projectId/tasks/status-summary', async (c) => {
    const projectId = param(c, 'projectId');
    const summary = await c.get('svc').tasks.getStatusSummary(projectId, callerContext(c));

    return c.json({ data: summary });
  });

  /**
   * GET /projects/:projectId/tasks/board — board column pages (cursor/keyset
   * pagination, fixed `BOARD_PAGE_SIZE` cards per column).
   *
   * No `cursor.<columnId>` params is the initial load (first page of every
   * column); listed cursors load only those columns. Columns resolve
   * server-side from the project's `BoardConfig`, so callers can never inject
   * arbitrary `statusIds`. Malformed cursors and unknown column ids → 400.
   * Same read pattern as the list route: tenant context resolves the project
   * role, no coarse route gate.
   */
  router.get('/projects/:projectId/tasks/board', validateQuery(BoardPageQuerySchema), async (c) => {
    const projectId = param(c, 'projectId');
    const q = c.req.valid('query');
    const cursors: Record<string, BoardPageCursor> = {};

    for (const [key, value] of Object.entries(q)) {
      if (!key.startsWith(BOARD_CURSOR_PREFIX)) continue;

      const columnId = key.slice(BOARD_CURSOR_PREFIX.length);

      if (!uuid().safeParse(columnId).success) {
        throw new ValidationError(`Unknown board column: ${columnId}`);
      }

      try {
        cursors[columnId] = decodeBoardCursor(value);
      } catch (err) {
        if (err instanceof InvalidBoardCursorError) {
          throw new ValidationError(`Invalid cursor for board column ${columnId}`);
        }

        throw err;
      }
    }

    const page = await c.get('svc').tasks.getBoardPages(
      projectId,
      {
        cursors,
        sprintId: q.sprintId,
        assigneeId: q.assigneeId,
        priorityLevel: q.priorityLevel,
      },
      callerContext(c),
    );

    return c.json({ data: page });
  });

  /**
   * POST /projects/:projectId/tasks — Create a task.
   * Coarse gate at the route (projectRole resolved by tenantContextMiddleware),
   * fine-grained re-check inside the service.
   */
  router.post(
    '/projects/:projectId/tasks',
    requirePermission('create_task', true),
    validateBody(CreateTaskSchema),
    async (c) => {
      const projectId = param(c, 'projectId');
      const body = c.req.valid('json');
      const task = await c.get('svc').tasks.createTask(projectId, body, callerContext(c));

      return c.json({ data: task }, 201);
    },
  );

  /**
   * GET /tasks/:taskId — Get a single task by UUID or KEY-NUMBER (e.g. PRO-42).
   */
  router.get('/tasks/:taskId', async (c) => {
    // The path parameter accepts BOTH forms, so it is resolved through the one
    // shared resolver before it reaches a repository lookup — the route no
    // longer carries its own copy of the KEY-NUMBER rule.
    const taskId = await c.get('svc').tasks.resolveTaskId(param(c, 'taskId'), callerContext(c));
    // Bare ids are tenant-asserted inside the service
    const task = await c.get('svc').tasks.getTask(taskId, callerContext(c));

    return c.json({ data: task });
  });

  /**
   * PATCH /tasks/:taskId — Update task (with optimistic concurrency).
   */
  router.patch('/tasks/:taskId', validateBody(UpdateTaskSchema), async (c) => {
    // Both accepted `:taskId` forms resolve to the same task; see GET above.
    const taskId = await c.get('svc').tasks.resolveTaskId(param(c, 'taskId'), callerContext(c));
    const body = c.req.valid('json');
    // Authorization (edit_task) is enforced inside the service after the task's
    // project is resolved — the route path carries no projectId. The service
    // tenant-asserts that project first (404 on a foreign task).
    const task = await c.get('svc').tasks.updateTask(taskId, body, callerContext(c));

    return c.json({ data: task });
  });

  /**
   * PATCH /projects/:projectId/tasks/bulk — bulk status/assignee/sprint update.
   * Body contract (exactly one `data` field) is enforced by Zod; per-task
   * failures (unknown id, wrong project, version conflict) are reported in the
   * response instead of failing the whole request. Authorization (`edit_task`)
   * is enforced inside the service, same as single-task update.
   */
  router.patch('/projects/:projectId/tasks/bulk', validateBody(BulkUpdateTasksSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const body = c.req.valid('json');
    const result = await c.get('svc').tasks.bulkUpdateTasks(projectId, body.taskIds, body.data, callerContext(c));

    return c.json({ data: result });
  });

  /**
   * DELETE /tasks/:taskId — Delete task (cascade).
   */
  router.delete('/tasks/:taskId', async (c) => {
    // Both accepted `:taskId` forms resolve to the same task; see GET above.
    const taskId = await c.get('svc').tasks.resolveTaskId(param(c, 'taskId'), callerContext(c));

    await c.get('svc').tasks.deleteTask(taskId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}

// ─── Cross-Tenant Routes (auth only — no tenant context) ─────────────────────

/**
 * Routes that must be mounted outside the tenant-scoped sub-app:
 * "My Tasks" spans all tenants of the user.
 */
export function createCrossTenantTaskRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  /**
   * GET /tasks/my — Tasks assigned to the current user, in the workspaces they
   * may currently read.
   *
   * This route is mounted OUTSIDE the tenant-scoped sub-app, so it takes
   * no tenant from the request; the scope is resolved by the service from the
   * caller's own ACTIVE, unexpired memberships. Forwarding the caller OBJECT
   * (not a bare id) keeps the "missing identity fails closed" rule on the
   * service boundary.
   */
  router.get('/tasks/my', async (c) => {
    const tasks = await c.get('svc').tasks.getMyTasks({ userId: c.get('userId') });

    return c.json({ data: tasks });
  });

  return router;
}
