/**
 * Request-scoped composition root.
 *
 * Builds the full repository/service graph once per request.
 * ⚠️ Must stay request-scoped: repositories capture MongoDB `Collection`
 * objects bound to the isolate-wide shared `MongoClient` (see db/mongo.ts) —
 * caching this graph at module level would leak request state across
 * requests on Cloudflare Workers. (The MongoClient itself IS cached per
 * isolate; only the service graph must stay per-request.)
 */

import type { Document } from 'mongodb';
import { getCollection } from './db/mongo.js';
import { AuthService } from './services/auth.service.js';
import { AuditEnrichmentService } from './services/audit-enrichment.service.js';
import { AuditService } from './services/audit.service.js';
import { BoardService } from './services/board.service.js';
import { CommentService } from './services/comment.service.js';
import { CounterService } from './services/counter.service.js';
import { EmailService, ConsoleEmailService } from './services/email.service.js';
import { FilterService } from './services/filter.service.js';
import { LabelService } from './services/label.service.js';
import { ProjectService } from './services/project.service.js';
import { SprintService } from './services/sprint.service.js';
import { StatusService } from './services/status.service.js';
import { TaskRelationshipService } from './services/task-relationship.service.js';
import { TaskService } from './services/task.service.js';
import { TaskTypeService } from './services/task-type.service.js';
import { PurgeService } from './services/purge.service.js';
import { TenantMemberService } from './services/tenant-member.service.js';
import { TenantService } from './services/tenant.service.js';
import { UserPreferencesService } from './services/user-preferences.service.js';

import { AuditEventRepository, type AuditEventDocument } from './repositories/audit-event.repository.js';
import { BoardRepository, type BoardDocument } from './repositories/board.repository.js';
import { CommentRepository, type CommentDocument } from './repositories/comment.repository.js';
import { CounterRepository, type CounterDocument } from './repositories/counter.repository.js';
import { FilterRepository, type FilterDocument } from './repositories/filter.repository.js';
import { LabelRepository, type LabelDocument } from './repositories/label.repository.js';
import { ProjectMemberRepository, type ProjectMemberDocument } from './repositories/project-member.repository.js';
import { ProjectRepository, type ProjectDocument } from './repositories/project.repository.js';
import { SprintRepository, type SprintDocument } from './repositories/sprint.repository.js';
import { StatusRepository, type StatusDocument } from './repositories/status.repository.js';
import {
  TaskRelationshipRepository,
  type TaskRelationshipDocument,
} from './repositories/task-relationship.repository.js';
import { TaskRepository, type TaskDocument } from './repositories/task.repository.js';
import { TaskTypeRepository, type TaskTypeDocument } from './repositories/task-type.repository.js';
import { TenantMemberRepository, type TenantMemberDocument } from './repositories/tenant-member.repository.js';
import { TenantRepository, type TenantDocument } from './repositories/tenant.repository.js';
import { UserPreferencesRepository, type UserPreferencesDocument } from './repositories/user-preferences.repository.js';
import { UserSettingsRepository } from './repositories/user-settings.repository.js';
import { UserRepository, type UserDocument } from './repositories/user.repository.js';

/** Environment values required to build the service graph */
export interface ContainerEnv {
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  FRONTEND_URL?: string;
  /**
   * The deployment mode, forwarded to `AuthService` so the login
   * limiter's CEILING can be mode-aware. Optional because the app's own default
   * when unset is `per-request` (see `app.ts`), and the limiter treats an unset
   * mode exactly as it treats that default — no behaviour is invented here.
   */
  DB_CLIENT_MODE?: string;
  /**
   * The operator-declared instance count used to keep the
   * deployment-wide login ceiling constant in a multi-instance mode. Unset in
   * `durable` (one instance, nothing to declare) and in a rollback where the
   * operator has not set it — see `utils/rate-limit-scope.ts` for the
   * fail-safe default.
   */
  RATE_LIMIT_INSTANCE_BUDGET?: string;
}

/** All application services, built once per request */
export interface Services {
  auth: AuthService;
  audit: AuditService;
  boards: BoardService;
  comments: CommentService;
  filters: FilterService;
  labels: LabelService;
  preferences: UserPreferencesService;
  projects: ProjectService;
  relationships: TaskRelationshipService;
  sprints: SprintService;
  statuses: StatusService;
  tasks: TaskService;
  taskTypes: TaskTypeService;
  tenantMembers: TenantMemberService;
  tenants: TenantService;
}

/**
 * Every repository the graph needs, built from the current request's `Db`.
 *
 * ONE builder, TWO graphs (the request graph and the scheduled purge's). Before
 * The purge needed no graph; giving it a hand-copied duplicate of this wiring
 * would be exactly the drift this file exists to prevent — a repository added
 * here and forgotten there is how `permanentDelete` came to delete a project
 * document and nothing else. `container.test.ts` asserts both graphs are built
 * from this one function.
 */
function buildRepositories() {
  return {
    auditRepo: new AuditEventRepository(getCollection<AuditEventDocument>('audit_events')),
    boardRepo: new BoardRepository(getCollection<BoardDocument>('boards')),
    commentRepo: new CommentRepository(getCollection<CommentDocument>('comments')),
    counterRepo: new CounterRepository(getCollection<CounterDocument>('counters')),
    filterRepo: new FilterRepository(getCollection<FilterDocument>('filters')),
    labelRepo: new LabelRepository(getCollection<LabelDocument>('labels')),
    projectMemberRepo: new ProjectMemberRepository(getCollection<ProjectMemberDocument>('project_members')),
    projectRepo: new ProjectRepository(getCollection<ProjectDocument>('projects')),
    relationshipRepo: new TaskRelationshipRepository(getCollection<TaskRelationshipDocument>('task_relationships')),
    sprintRepo: new SprintRepository(getCollection<SprintDocument>('sprints')),
    statusRepo: new StatusRepository(getCollection<StatusDocument>('statuses')),
    taskRepo: new TaskRepository(getCollection<TaskDocument>('tasks')),
    taskTypeRepo: new TaskTypeRepository(getCollection<TaskTypeDocument>('task_types')),
    tenantMemberRepo: new TenantMemberRepository(getCollection<TenantMemberDocument>('tenant_members')),
    tenantRepo: new TenantRepository(getCollection<TenantDocument>('tenants')),
    userRepo: new UserRepository(getCollection<UserDocument>('users')),
  };
}

/**
 * The project cascade service, wired to the repositories it owns.
 *
 * Shared by the request graph and the purge graph: a workspace purge purges
 * every project the workspace owns, and a second copy of this cascade could drift
 * from the standalone one with nothing to notice.
 */
function buildProjectService(repos: ReturnType<typeof buildRepositories>, auditService: AuditService): ProjectService {
  return new ProjectService(
    repos.projectRepo,
    repos.projectMemberRepo,
    {
      taskTypes: getCollection<Document>('task_types'),
      statuses: getCollection<Document>('statuses'),
      boards: getCollection<Document>('boards'),
    },
    {
      taskRepo: repos.taskRepo,
      sprintRepo: repos.sprintRepo,
      boardRepo: repos.boardRepo,
      labelRepo: repos.labelRepo,
      statusRepo: repos.statusRepo,
      taskTypeRepo: repos.taskTypeRepo,
      relationshipRepo: repos.relationshipRepo,
      commentRepo: repos.commentRepo,
      filterRepo: repos.filterRepo,
      // NO audit repository here, deliberately. The purge appends its record
      // rather than deleting audit rows — the retention window is a TTL index, so
      // the log leaves on a clock and a purge must not destroy the record of
      // itself. `container.test.ts` asserts this bundle carries exactly the
      // repositories the cascade calls, so a kept-but-unused entry cannot become
      // the thing somebody wires up next quarter.
      counterRepo: repos.counterRepo,
    },
    auditService,
    repos.tenantMemberRepo,
  );
}

/** Build the full service graph for the current request. */
export function buildServices(env: ContainerEnv): Services {
  // ── Repositories ──────────────────────────────────────────────────────────
  const {
    auditRepo,
    boardRepo,
    commentRepo,
    counterRepo,
    filterRepo,
    labelRepo,
    projectMemberRepo,
    projectRepo,
    relationshipRepo,
    sprintRepo,
    statusRepo,
    taskRepo,
    taskTypeRepo,
    tenantMemberRepo,
    tenantRepo,
    userRepo,
  } = buildRepositories();
  // ── Cross-cutting services ────────────────────────────────────────────────
  const counterService = new CounterService(counterRepo);
  const auditEnrichment = new AuditEnrichmentService({
    tasks: taskRepo,
    sprints: sprintRepo,
    statuses: statusRepo,
    labels: labelRepo,
    taskTypes: taskTypeRepo,
    projects: projectRepo,
    users: userRepo,
    comments: commentRepo,
    tenants: tenantRepo,
    tenantMembers: tenantMemberRepo,
  });
  const auditService = new AuditService(auditRepo, userRepo, auditEnrichment);
  // The project cascade is constructed ONCE here and shared, so
  // `TenantService` (which purges every project of a destroyed workspace) and the
  // standalone `ProjectService` cannot drift into two different cascades. It is a
  // local, not a module-level collaborator, so P-02 holds.
  // Built once and shared with `TenantService`, so the workspace
  // purge and the standalone project purge cannot drift into two cascades.
  const projectService = buildProjectService(
    {
      auditRepo,
      boardRepo,
      commentRepo,
      counterRepo,
      filterRepo,
      labelRepo,
      projectMemberRepo,
      projectRepo,
      relationshipRepo,
      sprintRepo,
      statusRepo,
      taskRepo,
      taskTypeRepo,
      tenantMemberRepo,
      tenantRepo,
      userRepo,
    },
    auditService,
  );
  let emailService: EmailService | ConsoleEmailService;

  if (env.RESEND_API_KEY) {
    emailService = new EmailService(env.RESEND_API_KEY, 'noreply@taskboard.app', env.FRONTEND_URL || '');
  } else {
    // Loud, per-request warning: without an API key emails are never delivered
    // and the console stub only logs masked tokens — invitation/reset flows
    // cannot complete. This must never silently "work" in production.
    console.warn(
      '[container] RESEND_API_KEY is not configured — falling back to ConsoleEmailService. ' +
        'Emails are NOT delivered; invitation/reset tokens are logged masked only.',
    );
    emailService = new ConsoleEmailService();
  }

  return {
    auth: new AuthService(
      userRepo,
      tenantRepo,
      tenantMemberRepo,
      env.JWT_SECRET,
      emailService,
      env.FRONTEND_URL || 'http://localhost:4200',
      // The mode-aware login ceiling.
      env.DB_CLIENT_MODE,
      env.RATE_LIMIT_INSTANCE_BUDGET,
    ),
    audit: auditService,
    boards: new BoardService(boardRepo, statusRepo, projectRepo, auditService, projectMemberRepo),
    // auditService + projectRepo let comment actions audit-log with the
    // tenant/project context and tenant-assert bare task ids.
    comments: new CommentService(commentRepo, userRepo, taskRepo, projectMemberRepo, auditService, projectRepo),
    filters: new FilterService(filterRepo, projectRepo),
    labels: new LabelService(labelRepo, taskRepo, projectRepo, auditService, projectMemberRepo),
    preferences: new UserPreferencesService(
      new UserPreferencesRepository(getCollection<UserPreferencesDocument>('user_preferences')),
      new UserSettingsRepository(getCollection('user_settings')),
    ),
    // The cascade repos and the audit service are REQUIRED constructor
    // params. Before this wiring they were `?`-optional and silently absent, so
    // `permanentDelete` deleted only the project document and every project-level
    // audit write was a no-op. Omitting an argument here
    // is now a compile error, and `container.test.ts` asserts each of the 11
    // cascade repos is a real repository instance.
    //
    // `tenantMemberRepo` closes the F4 residual hole — the "target user must
    // hold an ACTIVE membership in the caller's tenant" check moved from
    // `routes/projects.ts` into `ProjectService.addMember`, so a direct
    // service call can no longer bypass it. It is required, and the point lookup
    // `findByUserAndTenant` replaces the `$lookup` aggregate the route used.
    projects: projectService,
    relationships: new TaskRelationshipService(
      relationshipRepo,
      taskRepo,
      projectRepo,
      auditService,
      projectMemberRepo,
    ),
    sprints: new SprintService(sprintRepo, projectRepo, taskRepo, auditService, projectMemberRepo),
    statuses: new StatusService(statusRepo, taskRepo, boardRepo, projectRepo, auditService, projectMemberRepo),
    tasks: new TaskService(
      taskRepo,
      counterService,
      projectRepo,
      projectMemberRepo,
      statusRepo,
      taskTypeRepo,
      userRepo,
      sprintRepo,
      commentRepo,
      relationshipRepo,
      auditService,
      boardRepo,
      // `getMyTasks` resolves the caller's own ACTIVE memberships here
      // rather than trusting a user id alone. `labelIds` are checked
      // against the project through the label seam. Both are required deps —
      // `container.test.ts` fails if either is `undefined`.
      tenantMemberRepo,
      labelRepo,
    ),
    taskTypes: new TaskTypeService(taskTypeRepo, taskRepo, projectRepo, auditService, projectMemberRepo),
    // The fifth argument is the audit service, so every
    // membership transition (grant, revoke, expiry, role change) writes an
    // event. No package in the remediation plan owns `container.ts`; without
    // this line the service compiles with a REQUIRED dependency the real graph
    // never supplies, and the unit tests would pass over a production path that
    // writes nothing.
    tenantMembers: new TenantMemberService(tenantRepo, tenantMemberRepo, userRepo, emailService, auditService),
    // `undefined, undefined` placeholders used to disable the tenant →
    // project archive/restore cascade and every tenant audit write. Both are
    // required deps now. The project purge is a SEVENTH: without it the
    // workspace purge removed memberships and the workspace document and left
    // every project, task and comment behind.
    tenants: new TenantService(
      tenantRepo,
      tenantMemberRepo,
      userRepo,
      projectRepo,
      auditService,
      projectMemberRepo,
      projectService,
    ),
  };
}

/**
 * The graph the scheduled purge runs on.
 *
 * **A separate factory, deliberately not part of {@link buildServices}.** The
 * purge is driven by a platform timer, not by a request, so it has no request to
 * be scoped to — and putting it in the request graph would build a cascade nobody
 * on that request can reach. It lives here, in the composition root, because this
 * is the only place allowed to name a collection (P-01) and because P-02's rule is
 * that nothing DB-backed is constructed at MODULE level — a local inside a
 * function satisfies both.
 *
 * It takes no `env`: it builds no service that reads configuration, because the
 * purge authenticates nobody and sends nothing. A parameter that is not read is a
 * parameter the next reader has to verify.
 */
export function buildPurgeService(): PurgeService {
  const repos = buildRepositories();
  // No enrichment service: the purge writes records nobody reads back in this
  // invocation, and resolving ten entity labels per event would be pure cost in a
  // batch job whose only job is to delete things.
  const auditService = new AuditService(repos.auditRepo, repos.userRepo);
  const projectService = buildProjectService(repos, auditService);
  const tenantService = new TenantService(
    repos.tenantRepo,
    repos.tenantMemberRepo,
    repos.userRepo,
    repos.projectRepo,
    auditService,
    repos.projectMemberRepo,
    projectService,
  );

  return new PurgeService(repos.projectRepo, repos.tenantRepo, projectService, tenantService);
}
