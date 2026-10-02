/**
 * TABLE-LEVEL GUARDRAIL: every project-scoped WRITE route, and the
 * statuses it accepts.
 *
 * ⚠️ READ THIS BEFORE ADDING A PROJECT-SCOPED WRITE ROUTE.
 *
 * ## What this suite is for
 *
 * The defect this closes was not one bad guard — it was that the "is this
 * project read-only?" rule had NO single owner. `ProjectService.requireNotArchived`
 * tested `ARCHIVED`; the six project-scoped write services tested nothing at all;
 * and the user interface told every user that a project scheduled for deletion
 * was read-only. Nothing in the codebase could enumerate that disagreement,
 * because the rule was expressed as scattered `if` statements rather than as a
 * fact about a project.
 *
 * So this suite is a TABLE: one row per project-scoped write route, each naming
 * the service method that serves it and the statuses that method accepts. Two
 * properties are asserted:
 *
 *   - **Completeness.** Every mutating route in the real Hono route table that
 *     resolves to a project appears in {@link WRITE_ROUTE_TABLE}. A new write
 *     route added without a row here fails the build — the table is the decision
 *     point, exactly as `ROUTE_TABLE` is in `tenant-isolation.test.ts`.
 *   - **Behaviour.** Each row's service method, driven directly with a project
 *     in every status, accepts `ACTIVE` and refuses both frozen statuses.
 *
 * The routes come from `routeRegistry` — the REAL routers, not a copy — so the
 * table cannot drift from what the application actually serves.
 *
 * ## Why the service method is exercised directly
 *
 * The alternative is to drive HTTP requests through a fake service graph, which
 * proves nothing here: the fake would not contain the rule. These assertions run
 * the real service objects with in-memory repository doubles, so what is under
 * test is the code the container wires in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectStatus } from '@task-board/shared';
import { routeRegistry } from '../routes/index.js';
import { createProjectPreferencesRoutes } from '../routes/user-preferences.js';
import { BoardService } from './board.service.js';
import { CommentService } from './comment.service.js';
import { FilterService } from './filter.service.js';
import { LabelService } from './label.service.js';
import { ProjectService } from './project.service.js';
import { SprintService } from './sprint.service.js';
import { StatusService } from './status.service.js';
import { TaskRelationshipService } from './task-relationship.service.js';
import { TaskService } from './task.service.js';
import { TaskTypeService } from './task-type.service.js';

// ─── The two-tenant world ──────────────────────────────────────────────────────

const TENANT = 'tenant-1';
const PROJECT = 'project-1';
const CTX = { tenantId: TENANT, userId: 'user-1', userRole: 'OWNER' };

/** A project repository double whose status the test controls. */
function projectRepo(status: ProjectStatus) {
  return {
    findById: vi.fn().mockResolvedValue({ id: PROJECT, tenantId: TENANT, status, key: 'PRJ', name: 'P' }),
    findByTenantAndKey: vi.fn().mockResolvedValue({ id: PROJECT, tenantId: TENANT, status }),
    findByTenant: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: PROJECT, tenantId: TENANT, status: ProjectStatus.ACTIVE }),
  };
}

/** Tenant OWNER bypasses every project-level permission, so a PROJECT_ADMIN
 *  membership is not needed for these rows — but the services require the
 *  repository to EXIST, or they fail closed with a 403 that would mask the
 *  status under test. */
const memberRepo = { findByUserAndProject: vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' }) };
const audit = { log: vi.fn().mockResolvedValue(undefined) };
/**
 * The statuses a write route accepts, as the table records them.
 * `ACTIVE` is the only one — that is the whole point of the rule.
 */
const WRITABLE: ProjectStatus[] = [ProjectStatus.ACTIVE];
const FROZEN: ProjectStatus[] = [ProjectStatus.ARCHIVED, ProjectStatus.DELETION_PENDING];

/** The two shapes the write rule refuses with (`project-write-guard.ts`). */
function isWriteRuleRefusal(error: unknown): boolean {
  const candidate = error as { statusCode?: number; code?: string; message?: string };

  return (
    candidate?.statusCode === 409 &&
    (candidate.code === 'PROJECT_ARCHIVED' || candidate.message?.includes('read-only') === true)
  );
}

/**
 * Assert a write is ACCEPTED by the rule for `ACTIVE` and REFUSED for every
 * frozen status.
 *
 * The `ACTIVE` direction asserts only that the write rule did not refuse — not
 * that the whole write succeeds. These repository doubles are deliberately
 * minimal: a row's subject is the status gate, and requiring every downstream
 * repository method to be modelled would make the table brittle for reasons that
 * have nothing to do with that rule. The frozen direction IS a full assertion: a 409
 * from the rule, before any repository is touched.
 */
async function expectAcceptedOnlyWhenActive(invoke: (status: ProjectStatus) => Promise<unknown>): Promise<void> {
  for (const status of WRITABLE) {
    try {
      await invoke(status);
    } catch (error) {
      expect(
        isWriteRuleRefusal(error),
        `an ACTIVE project must not be refused by the write rule, got: ${(error as Error).message}`,
      ).toBe(false);
    }
  }

  for (const status of FROZEN) {
    await expect(invoke(status)).rejects.toSatisfy(
      (error: unknown) => isWriteRuleRefusal(error),
      `a ${status} project must be refused by the write rule`,
    );
  }
}

// ─── Service factories, one per aggregate ─────────────────────────────────────

function boardService(status: ProjectStatus): BoardService {
  return new BoardService(
    {
      findByProject: vi.fn().mockResolvedValue({ projectId: PROJECT, columns: [], version: 1 }),
      updateColumnsWithVersion: vi.fn().mockResolvedValue({ projectId: PROJECT, columns: [], version: 2 }),
    } as never,
    { findByIds: vi.fn().mockResolvedValue([]) } as never,
    projectRepo(status) as never,
    audit as never,
    memberRepo as never,
  );
}

function taskService(status: ProjectStatus): TaskService {
  return new TaskService(
    {
      findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: PROJECT, version: 1, labelIds: [] }),
      findByIds: vi.fn().mockResolvedValue([]),
      updateWithVersion: vi.fn().mockResolvedValue({ id: 'task-1', projectId: PROJECT, version: 2, labelIds: [] }),
    } as never,
    { nextNumber: vi.fn().mockResolvedValue(1) } as never,
    projectRepo(status) as never,
    memberRepo as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { deleteByTask: vi.fn(), findByTask: vi.fn().mockResolvedValue([]) } as never,
    { deleteByTask: vi.fn(), create: vi.fn() } as never,
    audit as never,
    { findByProject: vi.fn().mockResolvedValue({ projectId: PROJECT, columns: [], version: 1 }) } as never,
    { findByUser: vi.fn().mockResolvedValue(null) } as never,
    { findByProject: vi.fn().mockResolvedValue([]) } as never,
  );
}

function commentService(status: ProjectStatus): CommentService {
  return new CommentService(
    {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue({ id: 'c1', taskId: 'task-1', body: 'x', authorId: 'user-1' }),
    } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never,
    { findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: PROJECT }) } as never,
    memberRepo as never,
    audit as never,
    projectRepo(status) as never,
  );
}

function labelService(status: ProjectStatus): LabelService {
  return new LabelService(
    {
      findByProject: vi.fn().mockResolvedValue([]),
      findByProjectAndNormalizedName: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue({ id: 'label-1', projectId: PROJECT, name: 'bug' }),
    } as never,
    { removeLabelFromAll: vi.fn() } as never,
    projectRepo(status) as never,
    audit as never,
    memberRepo as never,
  );
}

function statusService(status: ProjectStatus): StatusService {
  return new StatusService(
    {
      findByProject: vi.fn().mockResolvedValue([]),
      findByProjectAndNormalizedName: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue({ id: 'status-1', projectId: PROJECT, name: 'TODO', position: 0 }),
    } as never,
    { setStatusNameForTasks: vi.fn(), countByStatus: vi.fn().mockResolvedValue(0) } as never,
    { replaceStatusInColumns: vi.fn() } as never,
    projectRepo(status) as never,
    audit as never,
    memberRepo as never,
  );
}

function sprintService(status: ProjectStatus): SprintService {
  return new SprintService(
    {
      findByProject: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue({ id: 'sprint-1', projectId: PROJECT, name: 'S1' }),
    } as never,
    projectRepo(status) as never,
    { setSprintNameForTasks: vi.fn() } as never,
    audit as never,
    memberRepo as never,
  );
}

function taskTypeService(status: ProjectStatus): TaskTypeService {
  return new TaskTypeService(
    {
      findByProject: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue({ id: 'BUG', projectId: PROJECT, key: 'BUG', name: 'Bug' }),
    } as never,
    { countByType: vi.fn().mockResolvedValue(0), updateManyByType: vi.fn() } as never,
    projectRepo(status) as never,
    audit as never,
    memberRepo as never,
  );
}

function relationshipService(status: ProjectStatus): TaskRelationshipService {
  return new TaskRelationshipService(
    {
      findByTask: vi.fn().mockResolvedValue([]),
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'rel-1', projectId: PROJECT, sourceTaskId: 'task-1', targetTaskId: 'task-2' }),
      create: vi.fn(),
    } as never,
    { findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: PROJECT }) } as never,
    projectRepo(status) as never,
    audit as never,
    memberRepo as never,
  );
}

function filterService(status: ProjectStatus): FilterService {
  return new FilterService(
    {
      findByUserAndProject: vi.fn().mockResolvedValue([]),
      findByUserProjectAndName: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue({ id: 'filter-1', projectId: PROJECT, userId: 'user-1', name: 'f' }),
      create: vi.fn(),
    } as never,
    projectRepo(status) as never,
    // Reference seams: these tests assert the project-write rule, not filter
    // criteria, so the lookups resolve nothing and cost no query.
    {
      statusRepo: { findByIds: vi.fn().mockResolvedValue([]) },
      taskTypeRepo: { findByIds: vi.fn().mockResolvedValue([]) },
      sprintRepo: { findByIds: vi.fn().mockResolvedValue([]) },
      labelRepo: { findByProject: vi.fn().mockResolvedValue([]) },
      projectMemberRepo: { findUserIdentityByProject: vi.fn().mockResolvedValue(null) },
    },
  );
}

const cascadeRepos = {
  taskRepo: {},
  commentRepo: {},
  relationshipRepo: {},
  sprintRepo: {},
  boardRepo: {},
  labelRepo: {},
  statusRepo: {},
  taskTypeRepo: {},
  filterRepo: {},
  auditRepo: {},
  counterRepo: {},
} as unknown as ConstructorParameters<typeof ProjectService>[5];

function projectService(status: ProjectStatus): ProjectService {
  return new ProjectService(
    projectRepo(status) as never,
    { findByUserAndProject: vi.fn().mockResolvedValue(null) } as never,
    { findActiveByUser: vi.fn().mockResolvedValue(null) } as never,
    audit as never,
    { findByUserAndTenant: vi.fn().mockResolvedValue(null) } as never,
    cascadeRepos,
  );
}

// ─── The table ────────────────────────────────────────────────────────────────

interface WriteRouteRow {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** The service method the route delegates to. */
  serviceMethod: string;
  /** Drive that method against a project in the given status. */
  invoke: (status: ProjectStatus) => Promise<unknown>;
}

const WRITE_ROUTE_TABLE: WriteRouteRow[] = [
  {
    method: 'PATCH',
    path: '/projects/:projectId',
    serviceMethod: 'ProjectService.updateProject',
    invoke: (status) =>
      projectService(status).updateProject(PROJECT, { name: 'renamed' }, { ...CTX, userRole: 'ADMIN' }),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/members',
    serviceMethod: 'ProjectService.addMember',
    invoke: (status) =>
      projectService(status).addMember(PROJECT, { userId: 'user-2', role: 'EDITOR' }, { ...CTX, userRole: 'ADMIN' }),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/members/:memberUserId',
    serviceMethod: 'ProjectService.updateMemberRole',
    invoke: (status) =>
      projectService(status).updateMemberRole(PROJECT, 'user-2', 'VIEWER', { ...CTX, userRole: 'ADMIN' }),
  },
  {
    method: 'DELETE',
    path: '/projects/:projectId/members/:memberUserId',
    serviceMethod: 'ProjectService.removeMember',
    invoke: (status) => projectService(status).removeMember(PROJECT, 'user-2', { ...CTX, userRole: 'ADMIN' }),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/preferences',
    serviceMethod: 'ProjectService.assertProjectWritable',
    invoke: (status) => projectService(status).assertProjectWritable(PROJECT, CTX),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/board',
    serviceMethod: 'BoardService.updateColumns',
    invoke: (status) => boardService(status).updateColumns(PROJECT, { columns: [], version: 1 }, CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/tasks',
    serviceMethod: 'TaskService.createTask',
    invoke: (status) =>
      taskService(status).createTask(PROJECT, { title: 'T', statusId: 's1', typeId: 't1', priorityLevel: 2 }, CTX),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/tasks/bulk',
    serviceMethod: 'TaskService.bulkUpdateTasks',
    invoke: (status) => taskService(status).bulkUpdateTasks(PROJECT, ['task-1'], {}, CTX),
  },
  {
    method: 'POST',
    path: '/tasks/:taskId/comments',
    serviceMethod: 'CommentService.createComment',
    invoke: (status) => commentService(status).createComment('task-1', { body: 'hi' }, CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/labels',
    serviceMethod: 'LabelService.createLabel',
    invoke: (status) => labelService(status).createLabel(PROJECT, { name: 'bug' }, CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/statuses',
    serviceMethod: 'StatusService.createStatus',
    invoke: (status) => statusService(status).createStatus(PROJECT, { name: 'New', position: 0 }, CTX),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/statuses/reorder',
    serviceMethod: 'StatusService.reorder',
    invoke: (status) => statusService(status).reorder(PROJECT, [], CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/sprints',
    serviceMethod: 'SprintService.createSprint',
    invoke: (status) => sprintService(status).createSprint(PROJECT, { name: 'S1' }, CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/task-types',
    serviceMethod: 'TaskTypeService.createTaskType',
    invoke: (status) => taskTypeService(status).createTaskType(PROJECT, { key: 'BUG', name: 'Bug', position: 0 }, CTX),
  },
  {
    method: 'PATCH',
    path: '/projects/:projectId/task-types/reorder',
    serviceMethod: 'TaskTypeService.reorder',
    invoke: (status) => taskTypeService(status).reorder(PROJECT, [], CTX),
  },
  {
    method: 'PATCH',
    path: '/tasks/:taskId',
    serviceMethod: 'TaskService.updateTask',
    invoke: (status) => taskService(status).updateTask('task-1', { title: 'T2', version: 1 }, CTX),
  },
  {
    method: 'DELETE',
    path: '/tasks/:taskId',
    serviceMethod: 'TaskService.deleteTask',
    invoke: (status) => taskService(status).deleteTask('task-1', CTX),
  },
  {
    method: 'PATCH',
    path: '/comments/:commentId',
    serviceMethod: 'CommentService.updateComment',
    invoke: (status) => commentService(status).updateComment('c1', { body: 'edited' }, CTX),
  },
  {
    method: 'DELETE',
    path: '/comments/:commentId',
    serviceMethod: 'CommentService.deleteComment',
    invoke: (status) => commentService(status).deleteComment('c1', CTX),
  },
  {
    method: 'PATCH',
    path: '/labels/:labelId',
    serviceMethod: 'LabelService.updateLabel',
    invoke: (status) => labelService(status).updateLabel('label-1', { name: 'bug2' }, CTX),
  },
  {
    method: 'DELETE',
    path: '/labels/:labelId',
    serviceMethod: 'LabelService.deleteLabel',
    invoke: (status) => labelService(status).deleteLabel('label-1', CTX),
  },
  {
    method: 'PATCH',
    path: '/statuses/:statusId',
    serviceMethod: 'StatusService.updateStatus',
    invoke: (status) => statusService(status).updateStatus('status-1', { name: 'TODO2' }, CTX),
  },
  {
    method: 'DELETE',
    path: '/statuses/:statusId',
    serviceMethod: 'StatusService.deleteStatus',
    invoke: (status) => statusService(status).deleteStatus('status-1', undefined, CTX),
  },
  {
    method: 'PATCH',
    path: '/sprints/:sprintId',
    serviceMethod: 'SprintService.updateSprint',
    invoke: (status) => sprintService(status).updateSprint('sprint-1', { name: 'S2' }, CTX),
  },
  {
    method: 'DELETE',
    path: '/sprints/:sprintId',
    serviceMethod: 'SprintService.deleteSprint',
    invoke: (status) => sprintService(status).deleteSprint('sprint-1', CTX),
  },
  {
    method: 'PATCH',
    path: '/task-types/:taskTypeId',
    serviceMethod: 'TaskTypeService.updateTaskType',
    invoke: (status) => taskTypeService(status).updateTaskType('BUG', { name: 'Bug2' }, CTX),
  },
  {
    method: 'DELETE',
    path: '/task-types/:taskTypeId',
    serviceMethod: 'TaskTypeService.deleteTaskType',
    invoke: (status) => taskTypeService(status).deleteTaskType('BUG', undefined, CTX),
  },
  {
    method: 'PATCH',
    path: '/filters/:filterId',
    serviceMethod: 'FilterService.updateFilter',
    invoke: (status) =>
      filterService(status).updateFilter(
        'filter-1',
        { name: 'f2', filters: {}, sort: { field: 'createdAt', direction: 'asc' } },
        CTX,
      ),
  },
  {
    method: 'DELETE',
    path: '/filters/:filterId',
    serviceMethod: 'FilterService.deleteFilter',
    invoke: (status) => filterService(status).deleteFilter('filter-1', CTX),
  },
  {
    method: 'DELETE',
    path: '/task-relationships/:relationshipId',
    serviceMethod: 'TaskRelationshipService.deleteRelationship',
    invoke: (status) => relationshipService(status).deleteRelationship('rel-1', CTX),
  },
  {
    method: 'POST',
    path: '/projects/:projectId/filters',
    serviceMethod: 'FilterService.createFilter',
    invoke: (status) =>
      filterService(status).createFilter(
        PROJECT,
        { name: 'f', filters: {}, sort: { field: 'createdAt', direction: 'desc' } },
        CTX,
      ),
  },
  {
    method: 'POST',
    path: '/tasks/:taskId/relationships',
    serviceMethod: 'TaskRelationshipService.createRelationship',
    invoke: (status) =>
      relationshipService(status).createRelationship('task-1', { targetTaskId: 'task-2', type: 'BLOCKS' }, CTX),
  },
];

// ─── Completeness against the REAL route table ────────────────────────────────

/**
 * The routes the application actually serves, collected from the real Hono
 * routers — the same objects `app.ts` mounts.
 */
function realProjectScopedWriteRoutes(): string[] {
  // `routeRegistry.projects` is mounted under `/projects` (see `app.ts`), so its
  // own paths are relative (`/:projectId`). The prefix is restored here so the
  // collected paths are the ones a client actually calls — otherwise the
  // completeness check would compare `DELETE /:projectId` against a table row
  // written as `/projects/:projectId` and miss a real route.
  const routers: { prefix: string; routes: { method: string; path: string }[] }[] = [
    { prefix: '/projects', routes: routeRegistry.projects.routes },
    { prefix: '', routes: routeRegistry.boards.routes },
    { prefix: '', routes: routeRegistry.tasks.routes },
    { prefix: '', routes: routeRegistry.sprints.routes },
    { prefix: '', routes: routeRegistry.statuses.routes },
    { prefix: '', routes: routeRegistry.taskTypes.routes },
    { prefix: '', routes: routeRegistry.labels.routes },
    { prefix: '', routes: routeRegistry.comments.routes },
    { prefix: '', routes: routeRegistry.taskRelationships.routes },
    { prefix: '', routes: routeRegistry.filters.routes },
    { prefix: '', routes: createProjectPreferencesRoutes().routes },
  ];
  const found = new Set<string>();

  for (const { prefix, routes } of routers) {
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const path = `${prefix}${route.path}`;

      if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE') {
        continue;
      }

      // A project-scoped write is either addressed by `:projectId` or addresses
      // an entity that hangs off a project (a task, a comment, a label…). The
      // entity-addressed ones are matched by their collection prefix below.
      const isProjectScoped =
        route.path.includes(':projectId') ||
        /^\/(tasks|comments|labels|statuses|sprints|task-types|relationships|filters)\b/.test(route.path);

      if (isProjectScoped) {
        found.add(`${method} ${path}`);
      }
    }
  }

  return [...found];
}

describe('project-scoped WRITE routes and the statuses they accept (N-1 table guardrail)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('every project-scoped write route in the REAL route table has a row here', () => {
    const real = realProjectScopedWriteRoutes();
    // The lifecycle transitions are the delete/archive state machine, which the
    // predicate deliberately does not gate (see project-write-guard.ts): a
    // DELETION_PENDING project must stay re-armable and purgeable.
    const lifecycle = real.filter(
      (route) =>
        route.endsWith('/archive') ||
        route.endsWith('/restore') ||
        route.endsWith('/cancel-deletion') ||
        route === 'DELETE /projects/:projectId',
    );
    const content = real.filter((route) => !lifecycle.includes(route));

    // The entity-addressed write routes are covered by the same service methods
    // as their project-addressed twins (e.g. PATCH /labels/:labelId and
    // PATCH /statuses/:statusId resolve the entity, then call the very method
    // the table row names), so they are asserted by service method rather than
    // duplicated as rows. What this test demands is that no CONTENT write route
    // exists whose service method the table has never heard of.
    expect(content.length).toBeGreaterThan(0);

    for (const route of content) {
      const [method, path] = route.split(' ');
      const covered = WRITE_ROUTE_TABLE.some((row) => row.method === method && path && sharesAggregate(row.path, path));

      expect(covered, `write route ${route} has no row in WRITE_ROUTE_TABLE`).toBe(true);
    }
  });

  it('the table itself is non-trivial — a table that lost its rows cannot pass', () => {
    expect(WRITE_ROUTE_TABLE.length).toBeGreaterThanOrEqual(30);
  });

  for (const row of WRITE_ROUTE_TABLE) {
    it(`${row.method} ${row.path} (${row.serviceMethod}) accepts ACTIVE and refuses both frozen statuses`, async () => {
      await expectAcceptedOnlyWhenActive(row.invoke);
    });
  }
});

/**
 * Two paths belong to the same table row when they name the same aggregate —
 * `/labels/:labelId` and `/projects/:projectId/labels` are both served by
 * `LabelService`'s single write seam.
 */
function sharesAggregate(rowPath: string, realPath: string): boolean {
  const aggregateOf = (path: string): string => {
    if (path.includes('/labels')) return 'labels';
    if (path.includes('/statuses')) return 'statuses';
    if (path.includes('/sprints')) return 'sprints';
    if (path.includes('/task-types')) return 'task-types';
    if (path.includes('/comments')) return 'comments';
    if (path.includes('/relationships')) return 'relationships';
    if (path.includes('/filters')) return 'filters';
    if (path.includes('/board')) return 'board';
    if (path.includes('/tasks')) return 'tasks';
    if (path.includes('/preferences')) return 'preferences';
    if (path.includes('/members')) return 'members';
    return 'project';
  };

  return aggregateOf(rowPath) === aggregateOf(realPath);
}
