/**
 * THE cross-tenant regression net: every row below is a vector a route once got wrong.
 *
 * ⚠️ READ THIS BEFORE ADDING A TENANT-SCOPED ROUTE.
 * Every route that takes a project or entity id and is mounted inside the
 * tenant-scoped sub-app MUST appear in {@link ROUTE_TABLE} below. Adding a route
 * without adding it here is a silent omission — the suite cannot know about a
 * route it was never told about, and the past audit findings
 * (container wiring, the project route, addMember escalation, the audit route,
 * filters, and project preferences) were each exactly such an
 * omission. The table is the conscious decision point.
 *
 * ── What is real here, and what is not ───────────────────────────────────────
 * REAL: the `app.ts` middleware chain (error handler, request auth, the tenant
 * context middleware including the GET `projectRole` resolution, the RBAC
 * `requireRole`/`requirePermission` matrix), the Zod request validation, the real
 * route modules, and the `{ data }` / `{ error }` envelopes.
 * FAKE: the service graph (`c.set('svc', …)` — the documented route-test
 * pattern from AGENTS.md) and the Mongo collections behind the tenant-context
 * middleware.
 *
 * The fake service is a MODEL of the service contract, not a stub that always
 * answers 200: every method resolves the addressed entity through the seeded
 * two-tenant world and raises the same errors the real services raise —
 * 401 when the caller context is missing (a route that forgot to forward
 * `callerContext(c)`), 404 when the entity does not exist or belongs to another
 * tenant, 403 when the tenant role is insufficient. So this suite proves the
 * ROUTE layer cannot be talked into supplying the wrong tenant, omitting the
 * context, or trusting a path/body value — which is the class of defect behind
 * every row in this table. The per-service specs keep the service-internal asserts.
 *
 * The negative direction is asserted for every row: the SAME request against the
 * caller's own tenant must succeed, so the suite cannot be satisfied by a
 * service that rejects everything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { NotFoundError, UnauthorizedError, ForbiddenError } from './errors/app-error.js';
import { errorHandler } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantContextMiddleware } from './middleware/tenant-context.js';
import { projectTenantGuard, projectIdFromPath } from './middleware/project-tenant-guard.js';
import { routeRegistry } from './routes/index.js';
import { createProjectPreferencesRoutes } from './routes/user-preferences.js';
import { createCrossTenantTaskRoutes } from './routes/tasks.js';
import { assertCorrespondence } from './testing/correspondence.js';
import type { AppEnv } from './types/context.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` clash
// that `fileURLToPath(new URL(...))` runs into under @cloudflare/workers-types.
const SRC_DIR = dirname(import.meta.filename);
const ROUTES_DIR = join(SRC_DIR, 'routes');

// ─── In-memory Mongo double (tenant context middleware only) ───────────────────

type Doc = Record<string, unknown>;

/** Seeded documents per collection, consulted by the tenant-context middleware. */
const COLLECTIONS: Record<string, Doc[]> = {
  tenants: [],
  tenant_members: [],
  project_members: [],
};

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) => doc[key] === value);
}

/**
 * The two lookups `tenantContextMiddleware` performs: an exact-match `findOne`
 * and the DEC-055 lazy-revoke `updateOne`. No other collection method is
 * reached on the tenant-scoped path.
 */
function stubCollection(name: string) {
  return {
    findOne: async (filter: Doc) => COLLECTIONS[name]?.find((doc) => matches(doc, filter)) ?? null,
    updateOne: async (filter: Doc, update: Doc) => {
      const doc = COLLECTIONS[name]?.find((entry) => matches(entry, filter));

      if (doc) Object.assign(doc, (update.$set ?? {}) as Doc);

      return { modifiedCount: doc ? 1 : 0 };
    },
  };
}

vi.mock('./db/mongo.js', () => ({
  getCollection: vi.fn((name: string) => stubCollection(name)),
}));

// ─── Seeded two-tenant world ──────────────────────────────────────────────────

/** Deterministic, well-formed UUIDs (several Zod schemas demand `uuid()`). */
function id(suffix: string): string {
  return `550e8400-e29b-41d4-a716-${suffix.padStart(12, '0')}`;
}

const TENANT_A = id('aaaaaaaaaaa1');
const TENANT_B = id('bbbbbbbbbbb1');
/** OWNER of tenant A — the production attacker: RBAC bypasses every project gate. */
const USER_A = id('aaaaaaaaaaa2');
/** Plain MEMBER of tenant A and PROJECT_ADMIN of project A. */
const USER_A_MEMBER = id('aaaaaaaaaaa3');
/** OWNER of tenant B — the victim. */
const USER_B = id('bbbbbbbbbbb2');
const PROJECT_A = id('aaaaaaaaaaa4');
const PROJECT_B = id('bbbbbbbbbbb4');
/** Owning tenant per project — the root of every entity chain. */
const PROJECT_TENANT: Record<string, string> = {
  [PROJECT_A]: TENANT_A,
  [PROJECT_B]: TENANT_B,
};
/**
 * The project `key` each project is stored under. `GET /projects/by-key/:key`
 * looks a project up by `{ tenantId, key }`, so the two tenants need keys that
 * are distinguishable: a caller in tenant A asking for tenant B's key is the
 * cross-tenant case. Shapes: `projectKey()` in `schemas/project.ts`
 * (2-10 chars, uppercase letter then uppercase letters/digits).
 */
const PROJECT_KEYS: Record<string, string> = {
  [PROJECT_A]: 'PROJA',
  [PROJECT_B]: 'PROJB',
};
/**
 * Every seeded entity of tenant B carries this marker in its payload. A
 * cross-tenant response that contains it has LEAKED tenant B's data, which is a
 * stronger assertion than "the status code was 4xx".
 */
const SECRET_B = 'TENANT_B_SECRET_DO_NOT_LEAK';

interface Entity {
  id: string;
  projectId: string;
  tenantId: string;
  label: string;
}

const ENTITIES = new Map<string, Entity>();

function seed(kind: string, entityId: string, projectId: string, tenantId: string): Entity {
  const entity = { id: entityId, projectId, tenantId, label: kind };

  ENTITIES.set(entityId, entity);

  return entity;
}

const IDS = {
  A: {
    tenant: TENANT_A,
    project: PROJECT_A,
    projectKey: PROJECT_KEYS[PROJECT_A] as string,
    task: seed('task', id('aaaaaaaaaaa5'), PROJECT_A, TENANT_A).id,
    label: seed('label', id('aaaaaaaaaaa6'), PROJECT_A, TENANT_A).id,
    status: seed('status', id('aaaaaaaaaaa7'), PROJECT_A, TENANT_A).id,
    status2: seed('status', id('aaaaaaaaaaa8'), PROJECT_A, TENANT_A).id,
    sprint: seed('sprint', id('aaaaaaaaaaa9'), PROJECT_A, TENANT_A).id,
    taskType: seed('taskType', id('aaaaaaaaaa10'), PROJECT_A, TENANT_A).id,
    taskType2: seed('taskType', id('aaaaaaaaaa11'), PROJECT_A, TENANT_A).id,
    comment: seed('comment', id('aaaaaaaaaa12'), PROJECT_A, TENANT_A).id,
    relationship: seed('relationship', id('aaaaaaaaaa13'), PROJECT_A, TENANT_A).id,
    filter: seed('filter', id('aaaaaaaaaa14'), PROJECT_A, TENANT_A).id,
    /** Target for `POST /projects/:id/members` — an ACTIVE member of tenant A. */
    addMemberTarget: USER_A_MEMBER,
    /** `memberUserId` in the member sub-routes. */
    memberUser: USER_A_MEMBER,
  },
  B: {
    tenant: TENANT_B,
    project: PROJECT_B,
    projectKey: PROJECT_KEYS[PROJECT_B] as string,
    task: seed('task', id('bbbbbbbbbbb5'), PROJECT_B, TENANT_B).id,
    label: seed('label', id('bbbbbbbbbbb6'), PROJECT_B, TENANT_B).id,
    status: seed('status', id('bbbbbbbbbbb7'), PROJECT_B, TENANT_B).id,
    status2: seed('status', id('bbbbbbbbbbb8'), PROJECT_B, TENANT_B).id,
    sprint: seed('sprint', id('bbbbbbbbbbb9'), PROJECT_B, TENANT_B).id,
    taskType: seed('taskType', id('bbbbbbbbbb10'), PROJECT_B, TENANT_B).id,
    taskType2: seed('taskType', id('bbbbbbbbbb11'), PROJECT_B, TENANT_B).id,
    comment: seed('comment', id('bbbbbbbbbb12'), PROJECT_B, TENANT_B).id,
    relationship: seed('relationship', id('bbbbbbbbbb13'), PROJECT_B, TENANT_B).id,
    filter: seed('filter', id('bbbbbbbbbb14'), PROJECT_B, TENANT_B).id,
    /** Foreign target for `POST /projects/:id/members` — ACTIVE in tenant B only. */
    addMemberTarget: USER_B,
    memberUser: USER_B,
  },
} as const;

/** Payload every read returns; tenant-B entities are stamped with SECRET_B. */
function payload(entity: Entity): Record<string, unknown> {
  return {
    id: entity.id,
    projectId: entity.projectId,
    tenantId: entity.tenantId,
    kind: entity.label,
    title: entity.tenantId === TENANT_B ? SECRET_B : `${entity.label} of ${entity.tenantId}`,
  };
}

/** Tenant → its seeded project, so the cross-tenant membership model can answer. */
const PROJECT_FOR_TENANT: Record<string, string> = {};

function seedCollections(): void {
  PROJECT_FOR_TENANT[TENANT_A] = PROJECT_A;
  PROJECT_FOR_TENANT[TENANT_B] = PROJECT_B;
  COLLECTIONS.tenants = [
    { id: TENANT_A, slug: 'tenant-a' },
    { id: TENANT_B, slug: 'tenant-b' },
  ];
  COLLECTIONS.tenant_members = [
    { id: 'm1', userId: USER_A, tenantId: TENANT_A, role: 'OWNER', status: 'ACTIVE', expiresAt: null },
    { id: 'm2', userId: USER_A_MEMBER, tenantId: TENANT_A, role: 'MEMBER', status: 'ACTIVE', expiresAt: null },
    { id: 'm3', userId: USER_B, tenantId: TENANT_B, role: 'OWNER', status: 'ACTIVE', expiresAt: null },
  ];
  COLLECTIONS.project_members = [
    { id: 'pm1', userId: USER_A, projectId: PROJECT_A, role: 'PROJECT_ADMIN' },
    { id: 'pm2', userId: USER_A_MEMBER, projectId: PROJECT_A, role: 'PROJECT_ADMIN' },
    { id: 'pm3', userId: USER_B, projectId: PROJECT_B, role: 'PROJECT_ADMIN' },
  ];
}

// ─── The fake service graph ───────────────────────────────────────────────────

/**
 * Models the service contract over the seeded world. Every project- or
 * entity-scoped method funnels through {@link assertProject} /
 * {@link assertEntity}, which reproduce the real services' answers:
 * missing context → 401, unknown or foreign entity → 404, wrong role → 403.
 */
class FakeServices {
  /** Tenant-scoped audit reads are answered by the route's own path/context check. */
  readonly auditCalls: { byProject: string[]; byTenant: string[] } = { byProject: [], byTenant: [] };

  private assertContext(context: { tenantId: string; userId: string; userRole: string } | undefined): void {
    if (!context?.tenantId || !context.userId || !context.userRole) {
      throw new UnauthorizedError('Caller context is required');
    }
  }

  private assertProject(projectId: string, context: { tenantId: string } | undefined): Entity {
    this.assertContext(context as { tenantId: string; userId: string; userRole: string });

    const tenantId = PROJECT_TENANT[projectId];

    if (!tenantId || tenantId !== context?.tenantId) {
      throw new NotFoundError('Project not found');
    }

    return { id: projectId, projectId, tenantId, label: 'project' };
  }

  private assertEntity(entityId: string, context: { tenantId: string } | undefined, label: string): Entity {
    const entity = ENTITIES.get(entityId);

    if (!entity) {
      throw new NotFoundError(`${label} not found`);
    }

    this.assertProject(entity.projectId, context);

    return entity;
  }

  private list(entityIds: readonly string[], context: { tenantId: string } | undefined) {
    return entityIds.map((entityId) => payload(this.assertEntity(entityId, context, 'Entity')));
  }

  private page(data: unknown[]): { data: unknown[]; pagination: unknown } {
    return { data, pagination: { page: 1, limit: 20, total: data.length, totalPages: 1 } };
  }

  private tenantAdmin(context: { userRole: string }): void {
    if (context.userRole !== 'OWNER' && context.userRole !== 'ADMIN') {
      throw new ForbiddenError('Only owner or admin can perform this action');
    }
  }

  private allIds(projectId: string): string[] {
    return [...ENTITIES.values()].filter((entity) => entity.projectId === projectId).map((entity) => entity.id);
  }

  get projects() {
    const assertProject = (projectId: string, context: { tenantId: string }) => this.assertProject(projectId, context);
    const assertEntity = (entityId: string, context: { tenantId: string }, label: string) =>
      this.assertEntity(entityId, context, label);

    return {
      listProjects: async (tenantId: string) => [{ id: PROJECT_A, tenantId }],
      getProject: async (projectId: string, context: { tenantId: string }) =>
        payload(assertProject(projectId, context)),
      // The project-scoped PATCH resolves the project through the WRITE
      // seam. It runs the SAME tenant assertion as `getProject`, which is the
      // point: a foreign project is a 404 here too, so this table's negative
      // direction keeps covering that route.
      assertProjectWritable: async (projectId: string, context: { tenantId: string }) =>
        payload(assertProject(projectId, context)),
      getProjectByKey: async (tenantId: string, key: string) => {
        // Models `ProjectRepository.findByTenantAndKey`: the query carries the
        // caller's tenant, so a foreign key simply matches no document — the
        // route's own tenant context is the only thing that can widen it.
        if (!tenantId) throw new UnauthorizedError('Caller context is required');

        const owned = Object.entries(PROJECT_KEYS).find(
          ([projectId, projectKey]) => projectKey === key && PROJECT_TENANT[projectId] === tenantId,
        );

        if (owned === undefined) throw new NotFoundError('Project not found');

        return { id: owned[0], tenantId, key };
      },
      updateProject: async (projectId: string, _input: unknown, context: { tenantId: string; userRole: string }) => {
        this.tenantAdmin(context);

        return payload(assertProject(projectId, context));
      },
      deleteProject: async (projectId: string, context: { tenantId: string; userRole: string }) => {
        this.tenantAdmin(context);
        assertProject(projectId, context);
      },
      archiveProject: async (projectId: string, context: { tenantId: string; userRole: string }) => {
        this.tenantAdmin(context);
        assertProject(projectId, context);
      },
      restoreProject: async (projectId: string, context: { tenantId: string; userRole: string }) => {
        this.tenantAdmin(context);
        assertProject(projectId, context);
      },
      cancelDeletion: async (projectId: string, context: { tenantId: string; userRole: string }) => {
        this.tenantAdmin(context);
        assertProject(projectId, context);
      },
      getProjectMembers: async (projectId: string, context: { tenantId: string }) => {
        assertProject(projectId, context);

        return [{ id: 'pm1', projectId, userId: USER_A, role: 'PROJECT_ADMIN' }];
      },
      addMember: async (
        projectId: string,
        input: { userId: string; role: string },
        context: { tenantId: string; userRole: string },
      ) => {
        const project = assertProject(projectId, context);
        // The ACTIVE-membership requirement of the caller's tenant.
        const membership = (COLLECTIONS.tenant_members ?? []).find(
          (doc) => doc.userId === input.userId && doc.tenantId === context.tenantId && doc.status === 'ACTIVE',
        );

        if (!membership) {
          throw new NotFoundError('User is not a member of this tenant');
        }

        this.tenantAdmin(context);

        return { id: 'new-pm', projectId: project.id, userId: input.userId, role: input.role };
      },
      updateMemberRole: async (
        projectId: string,
        memberUserId: string,
        role: string,
        context: { tenantId: string; userRole: string },
      ) => {
        assertProject(projectId, context);
        this.tenantAdmin(context);

        return { id: 'pm1', projectId, userId: memberUserId, role };
      },
      removeMember: async (
        projectId: string,
        memberUserId: string,
        context: { tenantId: string; userRole: string },
      ) => {
        assertProject(projectId, context);
        this.tenantAdmin(context);

        return memberUserId;
      },
      // Referenced by the entity helpers above (kept for readability).
      __assertEntity: assertEntity,
    };
  }

  get tasks() {
    return {
      // `GET /api/tasks/my` is mounted OUTSIDE the tenant-scoped sub-app,
      // so it takes no tenant from the request. The real service resolves the
      // caller's own ACTIVE, unexpired memberships; the model does the same over
      // the seeded `tenant_members`, which is what gives this suite the
      // "the caller used to be allowed" vocabulary it lacked.
      getMyTasks: async (caller: { userId: string }) => {
        if (!caller?.userId) throw new UnauthorizedError('Caller context is required');

        const now = Date.now();
        const readable = (COLLECTIONS.tenant_members ?? []).filter(
          (doc) =>
            doc.userId === caller.userId &&
            doc.status === 'ACTIVE' &&
            (doc.expiresAt === null ||
              doc.expiresAt === undefined ||
              new Date(doc.expiresAt as string).getTime() > now),
        );
        const tasks: { id: string; title: string }[] = [];

        for (const membership of readable) {
          for (const entity of ENTITIES.values()) {
            if (entity.projectId === PROJECT_FOR_TENANT[membership.tenantId as string] && entity.label === 'task') {
              tasks.push({ id: entity.id, title: `task of ${entity.tenantId}` });
            }
          }
        }

        return tasks;
      },
      getTasksByProject: async (projectId: string, _options: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.page(this.list(this.allIds(project.id), context));
      },
      getBoardTasks: async (projectId: string, _options: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.page(this.list(this.allIds(project.id), context));
      },
      getBoardPages: async (projectId: string, _options: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { columns: [], projectId: project.id };
      },
      getStatusSummary: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return [{ statusId: project.id, count: 0 }];
      },
      createTask: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-task', projectId: project.id };
      },
      getTask: async (taskId: string, context: { tenantId: string }) =>
        payload(this.assertEntity(taskId, context, 'Task')),
      getTaskByKey: async (context: { tenantId: string }) => ({
        id: 'task-by-key',
        tenantId: context.tenantId,
      }),
      updateTask: async (taskId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(taskId, context, 'Task')),
      deleteTask: async (taskId: string, context: { tenantId: string }) => this.assertEntity(taskId, context, 'Task'),
      bulkUpdateTasks: async (projectId: string, taskIds: string[], _data: unknown, context: { tenantId: string }) => {
        this.assertProject(projectId, context);
        taskIds.forEach((taskId) => this.assertEntity(taskId, context, 'Task'));

        return { updated: taskIds.length, failed: [] };
      },
    };
  }

  get labels() {
    return {
      getLabelsByProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.labelOf(project.id)], context);
      },
      createLabel: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-label', projectId: project.id };
      },
      updateLabel: async (labelId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(labelId, context, 'Label')),
      deleteLabel: async (labelId: string, context: { tenantId: string }) =>
        this.assertEntity(labelId, context, 'Label'),
    };
  }

  get statuses() {
    return {
      getStatusesByProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.statusOf(project.id)], context);
      },
      createStatus: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-status', projectId: project.id };
      },
      reorder: async (projectId: string, _items: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.statusOf(project.id)], context);
      },
      updateStatus: async (statusId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(statusId, context, 'Status')),
      deleteStatus: async (statusId: string, _replacement: unknown, context: { tenantId: string }) =>
        this.assertEntity(statusId, context, 'Status'),
    };
  }

  get sprints() {
    return {
      getSprintsByProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.sprintOf(project.id)], context);
      },
      createSprint: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-sprint', projectId: project.id };
      },
      getSprint: async (sprintId: string, context: { tenantId: string }) =>
        payload(this.assertEntity(sprintId, context, 'Sprint')),
      updateSprint: async (sprintId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(sprintId, context, 'Sprint')),
      deleteSprint: async (sprintId: string, context: { tenantId: string }) =>
        this.assertEntity(sprintId, context, 'Sprint'),
    };
  }

  get taskTypes() {
    return {
      getTaskTypesByProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.taskTypeOf(project.id)], context);
      },
      createTaskType: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-task-type', projectId: project.id };
      },
      reorder: async (projectId: string, _items: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.taskTypeOf(project.id)], context);
      },
      updateTaskType: async (taskTypeId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(taskTypeId, context, 'Task type')),
      deleteTaskType: async (taskTypeId: string, _replacement: unknown, context: { tenantId: string }) =>
        this.assertEntity(taskTypeId, context, 'Task type'),
    };
  }

  get boards() {
    return {
      getBoardByProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { projectId: project.id, columns: [] };
      },
      updateColumns: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { projectId: project.id, columns: [] };
      },
    };
  }

  get comments() {
    return {
      getCommentsByTask: async (taskId: string, context: { tenantId: string }) => {
        this.assertEntity(taskId, context, 'Task');

        return [payload(this.assertEntity(taskId, context, 'Task'))];
      },
      createComment: async (taskId: string, _input: unknown, context: { tenantId: string }) => {
        const task = this.assertEntity(taskId, context, 'Task');

        return { id: 'new-comment', taskId: task.id };
      },
      updateComment: async (commentId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(commentId, context, 'Comment')),
      deleteComment: async (commentId: string, context: { tenantId: string }) =>
        this.assertEntity(commentId, context, 'Comment'),
    };
  }

  get relationships() {
    return {
      getRelationshipsByTask: async (taskId: string, context: { tenantId: string }) => {
        this.assertEntity(taskId, context, 'Task');

        return [];
      },
      createRelationship: async (
        sourceTaskId: string,
        input: { targetTaskId: string },
        context: { tenantId: string },
      ) => {
        const source = this.assertEntity(sourceTaskId, context, 'Task');

        this.assertEntity(input.targetTaskId, context, 'Task');

        return { id: 'new-relationship', sourceTaskId: source.id, targetTaskId: input.targetTaskId };
      },
      deleteRelationship: async (relationshipId: string, context: { tenantId: string }) =>
        this.assertEntity(relationshipId, context, 'Task relationship'),
    };
  }

  get filters() {
    return {
      getFiltersByUserAndProject: async (projectId: string, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return this.list([this.filterOf(project.id)], context);
      },
      createFilter: async (projectId: string, _input: unknown, context: { tenantId: string }) => {
        const project = this.assertProject(projectId, context);

        return { id: 'new-filter', projectId: project.id };
      },
      updateFilter: async (filterId: string, _input: unknown, context: { tenantId: string }) =>
        payload(this.assertEntity(filterId, context, 'Filter')),
      deleteFilter: async (filterId: string, context: { tenantId: string }) =>
        this.assertEntity(filterId, context, 'Filter'),
    };
  }

  get audit() {
    return {
      // The journal is tenant data: the fake answers with the OWNING tenant's
      // marker, so a leak of tenant B would be visible in the response body.
      queryByProject: async (projectId: string) => {
        this.auditCalls.byProject.push(projectId);

        const owner = PROJECT_TENANT[projectId] ?? '';

        return this.page([
          {
            id: `audit-${projectId}`,
            projectId,
            tenantId: owner,
            note: owner === TENANT_B ? SECRET_B : 'tenant A event',
          },
        ]);
      },
      queryByTenant: async (tenantId: string) => {
        this.auditCalls.byTenant.push(tenantId);

        return this.page([
          { id: `audit-${tenantId}`, tenantId, note: tenantId === TENANT_B ? SECRET_B : 'tenant A event' },
        ]);
      },
      log: async () => undefined,
      logMany: async () => undefined,
    };
  }

  get preferences() {
    return {
      getPreferences: async (userId: string, projectId: string) => ({ userId, projectId, taskTableColumns: [] }),
      updatePreferences: async (userId: string, projectId: string, patch: unknown) => ({
        userId,
        projectId,
        ...(patch as object),
      }),
      getGlobalSettings: async () => ({}),
      updateGlobalSettings: async () => ({}),
    };
  }

  get tenantMembers() {
    return {
      getTenantMembers: async (_requesterId: string, tenantId: string) =>
        (COLLECTIONS.tenant_members ?? []).filter((doc) => doc.tenantId === tenantId),
    };
  }

  get auth() {
    return {
      findActiveUser: async (userId: string) =>
        [USER_A, USER_A_MEMBER, USER_B].includes(userId)
          ? { id: userId, email: `${userId}@example.test`, displayName: 'Test', deletedAt: null }
          : null,
    };
  }

  // ── Per-kind lookups over the seeded world ─────────────────────────────────

  private ofKind(projectId: string, kind: string): string {
    const entity = [...ENTITIES.values()].find((entry) => entry.projectId === projectId && entry.label === kind);

    if (!entity) {
      throw new NotFoundError(`${kind} not found`);
    }

    return entity.id;
  }

  private labelOf(projectId: string): string {
    return this.ofKind(projectId, 'label');
  }

  private statusOf(projectId: string): string {
    return this.ofKind(projectId, 'status');
  }

  private sprintOf(projectId: string): string {
    return this.ofKind(projectId, 'sprint');
  }

  private taskTypeOf(projectId: string): string {
    return this.ofKind(projectId, 'taskType');
  }

  private filterOf(projectId: string): string {
    return this.ofKind(projectId, 'filter');
  }
}

// ─── App under test — mirrors the tenant-scoped part of app.ts ────────────────

const JWT_SECRET = 'isolation-suite-secret';

function buildApp(services: FakeServices) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  // Stand-in for `provideServices` (AGENTS.md: route tests inject a fake `svc`
  // via middleware). Mounted before auth because `authMiddleware` reads
  // `svc.auth.findActiveUser`.
  app.use('/api/*', async (c, next) => {
    c.set('svc', services as never);
    await next();
  });

  app.use('/api/*', authMiddleware);

  // Same composition as `app.ts`: a sub-app so the tenant context middleware
  // applies ONLY to the tenant-scoped routes.
  // The SAME composition as `app.ts` — the tenant context, then the
  // project-tenant guard, then the routes. The order is the rule under test: the
  // tenant check must be able to answer 404 before any route's role gate can
  // answer 403. This suite builds its own app, so mirroring the order here is
  // what makes the assertion below a statement about the shipped pipeline rather
  // than about a test-only arrangement.
  const tenantScoped = new Hono<AppEnv>();

  tenantScoped.use('*', tenantContextMiddleware);
  tenantScoped.use('*', projectTenantGuard);
  tenantScoped.route('/projects', routeRegistry.projects);
  tenantScoped.route('/', routeRegistry.boards);
  tenantScoped.route('/', routeRegistry.tasks);
  tenantScoped.route('/', routeRegistry.sprints);
  tenantScoped.route('/', routeRegistry.statuses);
  tenantScoped.route('/', routeRegistry.taskTypes);
  tenantScoped.route('/', routeRegistry.labels);
  tenantScoped.route('/', routeRegistry.comments);
  tenantScoped.route('/', routeRegistry.taskRelationships);
  tenantScoped.route('/', routeRegistry.filters);
  tenantScoped.route('/', routeRegistry.audit);
  tenantScoped.route('/', createProjectPreferencesRoutes());

  // The cross-tenant "My Tasks" route, mounted on the PARENT app exactly
  // as `app.ts` does (auth only, no tenant context) and — as there — BEFORE the
  // tenant-scoped sub-app, so `/tasks/my` is not swallowed by `/tasks/:taskId`.
  // It is deliberately NOT in `ROUTE_TABLE` — that table enumerates tenant-scoped
  // id-bearing routes, and this one addresses no tenant id.
  app.route('/api', createCrossTenantTaskRoutes());

  app.route('/api', tenantScoped);

  return app;
}

interface Caller {
  userId: string;
  tenantId: string;
  token: string;
}

async function caller(userId: string, tenantId: string): Promise<Caller> {
  return {
    userId,
    tenantId,
    token: await sign({ sub: userId, email: `${userId}@example.test` }, JWT_SECRET, 'HS256'),
  };
}

const ENV = { JWT_SECRET, MONGODB_URI: 'mongodb://unused/isolation' } as never;

async function send(
  app: Hono<AppEnv>,
  who: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${who.token}`,
        'X-Tenant-Id': who.tenantId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV,
  );

  return { status: res.status, text: await res.text() };
}

// ─── The route table ──────────────────────────────────────────────────────────

interface RouteCase {
  /** Which past finding this vector came from, or 'baseline' for a row added with the suite. */
  finding: string;
  method: string;
  /** Path built from the id set of the scope under test. */
  path: (ids: (typeof IDS)['A']) => string;
  body?: (ids: (typeof IDS)['A']) => unknown;
  /** Status a same-tenant (tenant A) request must answer. */
  successStatus: number;
}

const A = IDS.A;
const B = IDS.B;
/**
 * ⚠️ THE TABLE. Every tenant-scoped route that takes a project or entity id.
 * A new such route must be added here — see the file header.
 */
const ROUTE_TABLE: RouteCase[] = [
  // ── projects ───────────────────────────────────────────────────────────────
  { finding: 'M-002', method: 'GET', path: (i) => `/api/projects/${i.project}`, successStatus: 200 },
  // `GET /by-key/:key` is addressed by a PROJECT KEY, not by an id — the table
  // used to skip it, which is exactly the drift the correspondence test below
  // now makes impossible: the row was added because the derived registration
  // list demanded one.
  { finding: 'M-002', method: 'GET', path: (i) => `/api/projects/by-key/${i.projectKey}`, successStatus: 200 },
  {
    finding: 'M-002',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  { finding: 'M-002', method: 'DELETE', path: (i) => `/api/projects/${i.project}`, successStatus: 200 },
  { finding: 'M-002', method: 'POST', path: (i) => `/api/projects/${i.project}/archive`, successStatus: 200 },
  { finding: 'M-002', method: 'POST', path: (i) => `/api/projects/${i.project}/restore`, successStatus: 200 },
  { finding: 'M-002', method: 'POST', path: (i) => `/api/projects/${i.project}/cancel-deletion`, successStatus: 200 },
  { finding: 'M-002', method: 'GET', path: (i) => `/api/projects/${i.project}/members`, successStatus: 200 },
  // The target userId must hold an ACTIVE membership in the CALLER's tenant.
  {
    finding: 'M-003',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/members`,
    body: (i) => ({ userId: i.addMemberTarget, role: 'PROJECT_ADMIN' }),
    successStatus: 201,
  },
  {
    finding: 'M-003',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/members/${i.memberUser}`,
    body: () => ({ role: 'VIEWER' }),
    successStatus: 200,
  },
  {
    finding: 'M-003',
    method: 'DELETE',
    path: (i) => `/api/projects/${i.project}/members/${i.memberUser}`,
    successStatus: 200,
  },

  // ── tasks ──────────────────────────────────────────────────────────────────
  // F7 note: the task LIST route gained a `hasSprint` query parameter (the
  // "no sprint"/backlog filter). The row below is unchanged on purpose — the
  // fake `tasks` service models the tenant contract and ignores filter options
  // entirely, so the new param cannot relax the cross-tenant 404 this table
  // pins. No row added, removed or re-pointed by F7.
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/tasks`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'GET',
    path: (i) => `/api/projects/${i.project}/tasks/status-summary`,
    successStatus: 200,
  },
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/tasks/board`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/tasks`,
    body: (i) => ({ typeId: i.taskType, title: 'Cross-tenant task', statusId: i.status, priorityLevel: 1 }),
    successStatus: 201,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/tasks/bulk`,
    body: (i) => ({ taskIds: [i.task], data: { statusId: i.status2 } }),
    successStatus: 200,
  },
  { finding: 'M-001', method: 'GET', path: (i) => `/api/tasks/${i.task}`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/tasks/${i.task}`,
    body: () => ({ title: 'PWNED', version: 1 }),
    successStatus: 200,
  },
  { finding: 'M-001', method: 'DELETE', path: (i) => `/api/tasks/${i.task}`, successStatus: 200 },

  // ── labels ─────────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/labels`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/labels`,
    body: () => ({ name: 'injected' }),
    successStatus: 201,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/labels/${i.label}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  { finding: 'M-001', method: 'DELETE', path: (i) => `/api/labels/${i.label}`, successStatus: 200 },

  // ── statuses ───────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/statuses`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/statuses`,
    body: () => ({ name: 'injected', position: 9 }),
    successStatus: 201,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/statuses/reorder`,
    body: (i) => ({ items: [{ id: i.status, position: 1 }] }),
    successStatus: 200,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/statuses/${i.status}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  {
    finding: 'M-001',
    method: 'DELETE',
    path: (i) => `/api/statuses/${i.status}`,
    body: (i) => ({ replacementStatusId: i.status2 }),
    successStatus: 200,
  },

  // ── sprints ────────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/sprints`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/sprints`,
    body: () => ({ name: 'injected' }),
    successStatus: 201,
  },
  { finding: 'M-001', method: 'GET', path: (i) => `/api/sprints/${i.sprint}`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/sprints/${i.sprint}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  { finding: 'M-001', method: 'DELETE', path: (i) => `/api/sprints/${i.sprint}`, successStatus: 200 },

  // ── task types ─────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/task-types`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/task-types`,
    body: () => ({ key: 'INJ', name: 'injected', icon: 'x', position: 9 }),
    successStatus: 201,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/task-types/reorder`,
    body: (i) => ({ items: [{ id: i.taskType, position: 1 }] }),
    successStatus: 200,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/task-types/${i.taskType}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  {
    finding: 'M-001',
    method: 'DELETE',
    path: (i) => `/api/task-types/${i.taskType}`,
    body: (i) => ({ replacementTypeId: i.taskType2 }),
    successStatus: 200,
  },

  // ── board ──────────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/projects/${i.project}/board`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/board`,
    // The board save carries the version it read (the fake service
    // models the contract, so any positive version is accepted).
    body: (i) => ({ columns: [{ statusIds: [i.status], position: 0 }], version: 1 }),
    successStatus: 200,
  },

  // ── comments ───────────────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/tasks/${i.task}/comments`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/tasks/${i.task}/comments`,
    body: () => ({ body: 'injected' }),
    successStatus: 201,
  },
  {
    finding: 'M-001',
    method: 'PATCH',
    path: (i) => `/api/comments/${i.comment}`,
    body: () => ({ body: 'PWNED' }),
    successStatus: 200,
  },
  { finding: 'M-001', method: 'DELETE', path: (i) => `/api/comments/${i.comment}`, successStatus: 200 },

  // ── task relationships ─────────────────────────────────────────────────────
  { finding: 'M-001', method: 'GET', path: (i) => `/api/tasks/${i.task}/relationships`, successStatus: 200 },
  {
    finding: 'M-001',
    method: 'POST',
    path: (i) => `/api/tasks/${i.task}/relationships`,
    body: (i) => ({ targetTaskId: i.task, type: 'BLOCKS' }),
    successStatus: 201,
  },
  { finding: 'M-001', method: 'DELETE', path: (i) => `/api/task-relationships/${i.relationship}`, successStatus: 200 },

  // ── filters ────────────────────────────────────────────────────────────────
  { finding: 'M-005', method: 'GET', path: (i) => `/api/projects/${i.project}/filters`, successStatus: 200 },
  {
    finding: 'M-005',
    method: 'POST',
    path: (i) => `/api/projects/${i.project}/filters`,
    body: () => ({ name: 'injected', filters: {}, sort: { field: 'createdAt', direction: 'desc' } }),
    successStatus: 201,
  },
  {
    finding: 'M-005',
    method: 'PATCH',
    path: (i) => `/api/filters/${i.filter}`,
    body: () => ({ name: 'PWNED' }),
    successStatus: 200,
  },
  { finding: 'M-005', method: 'DELETE', path: (i) => `/api/filters/${i.filter}`, successStatus: 200 },

  // ── audit ──────────────────────────────────────────────────────────────────
  { finding: 'M-004', method: 'GET', path: (i) => `/api/projects/${i.project}/audit`, successStatus: 200 },
  { finding: 'M-004', method: 'GET', path: (i) => `/api/tenants/${i.tenant}/audit`, successStatus: 200 },

  // ── project preferences ────────────────────────────────────────────────────
  { finding: 'M-506', method: 'GET', path: (i) => `/api/projects/${i.project}/preferences`, successStatus: 200 },
  {
    finding: 'M-506',
    method: 'PATCH',
    path: (i) => `/api/projects/${i.project}/preferences`,
    body: () => ({ taskTableColumns: ['key', 'title'] }),
    successStatus: 200,
  },
];

// ─── The table's own correspondence to the routes it enumerates ───────────────

/**
 * The table above is only worth something if it covers every id-bearing route
 * mounted behind the tenant context. It did not: `GET /api/projects/by-key/:key`
 * had no row, so it was asserted neither cross-tenant nor same-tenant, and
 * nothing was red.
 *
 * So the registrations are DERIVED from the two artefacts that define them —
 * the `tenantScoped.route(…)` mounts in `app.ts` and the route registrations in
 * the mounted modules — and checked against the table in both directions. A new
 * tenant-scoped id-bearing route with no row fails; a row for a route that no
 * longer exists fails; editing the content of a row never does.
 */

/** Symbol → module, from `app.ts`'s own imports (`./x.js` → `x.ts`). */
function appImports(source: string): Map<string, string> {
  const symbols = new Map<string, string>();

  for (const statement of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)'/g)) {
    for (const symbol of (statement[1] ?? '').split(',')) {
      const name = symbol.trim();

      if (name) symbols.set(name, (statement[2] ?? '').replace(/\.js$/, '.ts'));
    }
  }

  return symbols;
}

/**
 * Every module mounted inside the tenant-scoped sub-app, with the prefix it is
 * mounted at. Derived from `app.ts` so a module added to (or removed from) the
 * tenant-scoped set is picked up with no edit here.
 */
function tenantScopedMounts(appSource: string): { prefix: string; file: string }[] {
  const start = appSource.indexOf('const tenantScoped');
  const end = appSource.indexOf("app.route('/api', tenantScoped)");

  if (start < 0 || end < 0) throw new Error('app.ts no longer mounts a tenant-scoped sub-app at /api');

  const block = appSource.slice(start, end);
  const imports = appImports(appSource);
  const mounts: { prefix: string; file: string }[] = [];

  for (const mount of block.matchAll(/tenantScoped\.route\(\s*'([^']*)'\s*,\s*([\w.]+(?:\(\))?)/g)) {
    const prefix = mount[1] ?? '';
    const target = (mount[2] ?? '').replace(/\(\)$/, '');
    const registry = target.match(/^routeRegistry\.(\w+)$/);
    const file = registry ? `${registry[1]?.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.ts` : imports.get(target);

    if (!file) throw new Error(`cannot resolve the route module mounted as ${target}`);

    mounts.push({ prefix, file: file.replace(/^(?:routes\/)/, '') });
  }

  return mounts;
}

const ROUTE_REGISTRATION = /\b(?:router|app)\.(get|post|put|patch|delete|options|head|all)\(\s*'([^']*)'/g;

/** `GET /projects/:projectId/tasks` → `GET /api/projects/:id/tasks` (id shape only). */
function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/{2,}/g, '/')}`;
}

/**
 * The concrete id a table row interpolates and the `:name` in a registration are
 * the same position in the same route, so every seeded id (and project key) is
 * folded to a placeholder and the parameter NAMES are then dropped:
 * `assertCorrespondence` compares ROUTES, not identifiers. Renaming
 * `:projectId` to `:id` does not break the correspondence; moving, adding or
 * removing a route does.
 */
const SEEDED_IDS: readonly (readonly [string, string])[] = [
  ...Object.keys(PROJECT_TENANT).map((projectId) => [projectId, ':projectId'] as const),
  ...Object.values(PROJECT_KEYS).map((key) => [key, ':key'] as const),
  [TENANT_A, ':tenantId'],
  [TENANT_B, ':tenantId'],
  [USER_A, ':userId'],
  [USER_A_MEMBER, ':userId'],
  [USER_B, ':userId'],
  ...[...ENTITIES.values()].map((entity) => [entity.id, `:${entity.label}Id`] as const),
];
const PARAM_SHAPE = (path: string): string => path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':id');
const SEEDED_SHAPE = (path: string): string =>
  SEEDED_IDS.reduce((shaped, [value, placeholder]) => shaped.split(value).join(placeholder), path);
const APP_SOURCE = readFileSync(join(SRC_DIR, 'app.ts'), 'utf8');
/** Every `METHOD /api<path>` the tenant-scoped sub-app registers with an id in it. */
const DERIVED_ROUTE_KEYS = tenantScopedMounts(APP_SOURCE)
  .flatMap(({ prefix, file }) => {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');

    return [...source.matchAll(ROUTE_REGISTRATION)]
      .filter((registration) => (registration[2] ?? '').includes(':'))
      .map((registration) => routeKey(registration[1] ?? '', `/api${prefix}${registration[2] ?? ''}`));
  })
  .map((key) => PARAM_SHAPE(key));

describe('cross-tenant isolation — route table (W-10 / G-02)', () => {
  let services: FakeServices;
  let app: Hono<AppEnv>;
  let ownerA: Caller;

  beforeEach(async () => {
    seedCollections();
    services = new FakeServices();
    app = buildApp(services);
    ownerA = await caller(USER_A, TENANT_A);
  });

  /**
   * THE UNIFORM RULE, asserted per row.
   *
   * The outcome table this replaces accepted 401, 403 and 404 alike, which is
   * exactly why the ordering could drift in either direction with nothing to
   * catch it. The rule is now one line:
   *
   *   A request that NAMES A PROJECT is answered by the TENANT check first.
   *   A foreign or unknown project is 404 — never 403, whatever the caller's
   *   role, because the role gate runs after the tenant check and therefore
   *   never gets to speak about a project the caller does not have.
   *
   * Two consequences the assertion encodes, and both are needed:
   *   • 403 is REJECTED for a project-scoped row. If the guard were removed (or
   *     mounted after the routes), `requirePermission` would throw 403 first on
   *     the permission-gated rows and this assertion fails — that is the
   *     fail-proof for the ordering, not a stylistic preference.
   *   • 401 is still allowed everywhere, because it means the route dropped the
   *     caller context (the dropped-context defect this suite was built for) and is a
   *     different failure with a different cause.
   *
   * A row that addresses an ENTITY by its own id (`/tasks/:taskId`, …) has no
   * project in its path; its service resolves the owning project and asserts the
   * tenant before its own role check, so it is held to the same 404 outcome.
   */
  describe('tenant A acting on tenant B ids is rejected and never returns B data', () => {
    it.each(ROUTE_TABLE.map((route) => [`${route.method} ${route.path(B)} [${route.finding}]`, route] as const))(
      '%s',
      async (_name, route) => {
        const { status, text } = await send(app, ownerA, route.method, route.path(B), route.body?.(B));

        // 401 = the route dropped the caller context. 404 = the tenant check,
        // which is the ONLY outcome a project-scoped route may produce here.
        // 403 is excluded on purpose: it would mean a role gate answered for a
        // project the caller does not have, which is the ordering the tenant seam forbids.
        expect([401, 404], `expected the tenant check to answer, got ${status}: ${text}`).toContain(status);
        expect(text).not.toContain(SECRET_B);
        expect(text).not.toContain(TENANT_B);
      },
    );
  });

  /**
   * The rule's coverage, asserted structurally rather than only through the
   * running app: EVERY project-scoped row of the table is one the guard must
   * cover. If a future row added a project-scoped route the guard's path
   * pattern stopped matching, this fails — the regression the behavioural rows
   * above cannot see, because a route the pattern misses still 404s (via the
   * service) and therefore still passes them.
   */
  it('the tenant check covers every project-scoped row of the table (N-3)', () => {
    const uncovered = ROUTE_TABLE.map((route) => route.path(A))
      .filter(
        (path) => path.includes('/projects/') && path !== `/api/projects/${A.projectKey}` && !path.includes('/by-key/'),
      )
      .filter((path) => projectIdFromPath(path) === null);

    expect(uncovered, `rows the guard does not recognise as project-scoped: ${uncovered.join(', ')}`).toEqual([]);
  });

  /**
   * The rule stated as a property of the PIPELINE, not of a route: on a
   * project-scoped path the tenant check is mounted before the routes, so no
   * route's own role gate can be reached first. Read from `app.ts` so the
   * assertion is about the shipped composition.
   */
  it('the tenant check is mounted BEFORE the routes in app.ts (N-3 ordering)', () => {
    const contextAt = APP_SOURCE.indexOf("tenantScoped.use('*', tenantContextMiddleware)");
    const guardAt = APP_SOURCE.indexOf("tenantScoped.use('*', projectTenantGuard)");
    const routesAt = APP_SOURCE.indexOf('tenantScoped.route(');

    expect(contextAt, 'app.ts must mount the tenant context on the tenant-scoped sub-app').toBeGreaterThan(-1);
    expect(guardAt, 'app.ts must mount projectTenantGuard on the tenant-scoped sub-app').toBeGreaterThan(-1);
    // The whole rule, in one comparison: the guard is registered after the
    // tenant context (it needs tenantId) and before the first route (so no role
    // gate can answer first). Mounting it after the routes is the exact
    // regression this fails on.
    expect(guardAt).toBeGreaterThan(contextAt);
    expect(
      guardAt,
      'projectTenantGuard must be mounted before the first tenantScoped.route() so the tenant check precedes every role gate',
    ).toBeLessThan(routesAt);
  });

  describe('the same request inside the caller tenant still succeeds', () => {
    it.each(ROUTE_TABLE.map((route) => [`${route.method} ${route.path(A)} [${route.finding}]`, route] as const))(
      '%s',
      async (_name, route) => {
        const { status, text } = await send(app, ownerA, route.method, route.path(A), route.body?.(A));

        expect(status, `expected ${route.successStatus}, got ${status}: ${text}`).toBe(route.successStatus);
        expect(text).not.toContain(SECRET_B);
      },
    );
  });

  /**
   * `GET /api/tasks/my` is membership-scoped.
   *
   * The unit this suite lacked: **the caller used to be allowed**. Every other
   * row asks "can tenant A reach tenant B's id"; this one asks "does losing
   * access actually remove the read", which is a different question and the one
   * the defect lived in. Both directions are asserted — the same request while
   * the membership holds must still return data, so the suite cannot be
   * satisfied by a service that always returns nothing.
   */
  describe('GET /api/tasks/my is scoped to the caller CURRENT memberships (D-17)', () => {
    function membershipsOf(userId: string) {
      return (COLLECTIONS.tenant_members ?? []).filter((doc) => doc.userId === userId);
    }

    it('returns the caller their own tasks while the membership is ACTIVE', async () => {
      const { status, text } = await send(app, ownerA, 'GET', '/api/tasks/my');

      expect(status, text).toBe(200);
      expect(JSON.parse(text).data.length).toBeGreaterThan(0);
    });

    it('yields no task once the membership is REVOKED — the caller used to be allowed', async () => {
      const before = await send(app, ownerA, 'GET', '/api/tasks/my');

      expect(JSON.parse(before.text).data.length).toBeGreaterThan(0);

      membershipsOf(USER_A).forEach((membership) => Object.assign(membership, { status: 'ACCESS_REVOKED' }));

      const after = await send(app, ownerA, 'GET', '/api/tasks/my');

      // Losing access must remove the READ, wherever it is removed. The tenant
      // middleware refuses a non-ACTIVE membership before the route runs, so
      // this suite asserts the property ("no task content comes back") rather
      // than one status code — the service-level block in `task.service.test.ts`
      // pins the route's own behaviour separately.
      expect(after.text, after.text).not.toContain(`task of ${TENANT_A}`);
      expect(JSON.parse(after.text).data ?? []).toEqual([]);
    });

    it('yields no task once the membership has EXPIRED (DEC-055 lazy expiry)', async () => {
      membershipsOf(USER_A).forEach((membership) =>
        Object.assign(membership, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      );

      const { text } = await send(app, ownerA, 'GET', '/api/tasks/my');

      expect(text, text).not.toContain(`task of ${TENANT_A}`);
      expect(JSON.parse(text).data ?? []).toEqual([]);
    });

    it('never returns another tenant task, whatever the caller holds', async () => {
      // The same-tenant half of the invariant: adding a membership in tenant B
      // brings B's own task into scope, and nothing else.
      COLLECTIONS.tenant_members?.push({
        id: 'm4',
        userId: USER_A,
        tenantId: TENANT_B,
        role: 'MEMBER',
        status: 'ACTIVE',
        expiresAt: null,
      });

      const { status, text } = await send(app, ownerA, 'GET', '/api/tasks/my');
      const titles = JSON.parse(text).data.map((task: { title: string }) => task.title) as string[];

      expect(status, text).toBe(200);
      expect(titles).toContain(`task of ${TENANT_B}`);
      expect(titles.every((title) => title === `task of ${TENANT_A}` || title === `task of ${TENANT_B}`)).toBe(true);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await app.request('/api/tasks/my', { headers: { 'X-Tenant-Id': TENANT_A } }, ENV);

      expect(res.status).toBe(401);
    });
  });

  it('a cross-tenant request never reaches the audit repository', async () => {
    await send(app, ownerA, 'GET', `/api/projects/${B.project}/audit`);
    await send(app, ownerA, 'GET', `/api/tenants/${B.tenant}/audit`);

    expect(services.auditCalls.byProject).not.toContain(B.project);
    expect(services.auditCalls.byTenant).not.toContain(B.tenant);
  });

  it('0: the table covers exactly the id-bearing routes the tenant-scoped sub-app registers', () => {
    // Derivation, not restatement: the mounts come from `app.ts` and the
    // registrations from the mounted modules. `A` supplies the concrete ids the
    // table rows interpolate.
    const declared = ROUTE_TABLE.map((route) => PARAM_SHAPE(SEEDED_SHAPE(routeKey(route.method, route.path(A)))));

    assertCorrespondence('tenant-scoped route table', declared, DERIVED_ROUTE_KEYS);
  });

  it('an unauthenticated request is rejected on every id-bearing route', async () => {
    const res = await app.request(`/api/projects/${B.project}`, { headers: { 'X-Tenant-Id': TENANT_B } }, ENV);

    expect(res.status).toBe(401);
  });

  it('a tenant-A member cannot read the project audit of tenant B either', async () => {
    const member = await caller(USER_A_MEMBER, TENANT_A);
    const { status, text } = await send(app, member, 'GET', `/api/projects/${B.project}/audit`);

    // The ordering rule, and the case the OWNER-driven table above CANNOT see: a tenant MEMBER
    // holds no project role for tenant B, so without the ordering fix
    // `requirePermission` answers 403 here. This assertion is exactly 404, and
    // it is the behavioural fail-proof for "tenant check before role gate" —
    // remove the guard and this row flips to 403.
    expect(status, `expected 404 (the tenant check), got ${status}: ${text}`).toBe(404);
    expect(text).not.toContain(SECRET_B);
  });

  /**
   * The same rule, for a caller whose role is INSUFFICIENT, on every
   * project-scoped row of the table.
   *
   * Why this block exists SEPARATELY from the cross-tenant loop above: that
   * loop's caller is the tenant OWNER, and the RBAC matrix lets an admin bypass
   * every project-level check — so the OWNER reaches the service and receives
   * 404 even with the guard removed, and the loop cannot observe the ordering at
   * all. Only a caller the matrix actually DENIES makes the ordering visible.
   * This is why the loop had to be supplemented rather than merely tightened.
   */
  describe('N-3: an insufficient role never turns a foreign project into 403', () => {
    /** Every project-scoped row — the ones the guard is there to answer for. */
    const PROJECT_SCOPED = ROUTE_TABLE.filter((route) => route.path(A).includes(`/api/projects/${A.project}`));

    it('the project-scoped set is not empty — a vacuous filter would pass silently', () => {
      expect(PROJECT_SCOPED.length).toBeGreaterThan(5);
    });

    it.each(PROJECT_SCOPED.map((route) => [`${route.method} ${route.path(B)}`, route] as const))(
      '%s is 404, not 403',
      async (_name, route) => {
        const member = await caller(USER_A_MEMBER, TENANT_A);
        const { status, text } = await send(app, member, route.method, route.path(B), route.body?.(B));

        // 403 here would mean the role gate spoke about a project the caller
        // does not have. The tenant check owns that question, and it answers
        // 404 — for a foreign project and an unknown one identically.
        expect(status, `expected 404, got ${status}: ${text}`).toBe(404);
        expect(text).not.toContain(SECRET_B);
        expect(text).not.toContain(TENANT_B);
      },
    );

    it('and the SAME caller still succeeds on their OWN project — the guard is not a blanket 404', async () => {
      const member = await caller(USER_A_MEMBER, TENANT_A);
      const { status, text } = await send(app, member, 'GET', `/api/projects/${A.project}/audit`);

      // The negative direction. Without it, "always answer 404" would satisfy
      // every assertion above — and would be a worse product than the defect.
      expect(status, `expected 200, got ${status}: ${text}`).toBe(200);
    });
  });

  /**
   * `projectRole` is resolved for GET as well, so a tenant MEMBER who is a
   * PROJECT_ADMIN of their own project can read that project's audit log. This
   * is the behavioural effect of the tenant-context fix.
   */
  it('a project admin (tenant MEMBER) can read the audit of their OWN project on GET', async () => {
    const member = await caller(USER_A_MEMBER, TENANT_A);
    const { status, text } = await send(app, member, 'GET', `/api/projects/${A.project}/audit`);

    expect(status).toBe(200);
    expect(text).not.toContain(SECRET_B);
  });

  it('a tenant-A member who is not a project member gets 403 on the project audit', async () => {
    // Same user, a project they hold no membership in: the RBAC matrix denies.
    COLLECTIONS.project_members = (COLLECTIONS.project_members ?? []).filter(
      (doc) => !(doc.userId === USER_A_MEMBER && doc.projectId === A.project),
    );

    const member = await caller(USER_A_MEMBER, TENANT_A);
    const { status } = await send(app, member, 'GET', `/api/projects/${A.project}/audit`);

    expect(status).toBe(403);
  });
});
