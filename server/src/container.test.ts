import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildPurgeService, buildServices, type Services } from './container.js';
import { AuthService } from './services/auth.service.js';
import { AuditService } from './services/audit.service.js';
import { BoardService } from './services/board.service.js';
import { CommentService } from './services/comment.service.js';
import { FilterService } from './services/filter.service.js';
import { LabelService } from './services/label.service.js';
import { ProjectService } from './services/project.service.js';
import { RateLimitAuthorityService } from './services/rate-limit-authority.service.js';
import { SprintService } from './services/sprint.service.js';
import { StatusService } from './services/status.service.js';
import { TaskRelationshipService } from './services/task-relationship.service.js';
import { TaskService } from './services/task.service.js';
import { TaskTypeService } from './services/task-type.service.js';
import { TenantMemberService } from './services/tenant-member.service.js';
import { PurgeService } from './services/purge.service.js';
import { TenantService } from './services/tenant.service.js';
import { UserPreferencesService } from './services/user-preferences.service.js';
import { TenantMemberRepository } from './repositories/tenant-member.repository.js';
import { assertCorrespondence } from './testing/correspondence.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` clash
// that `fileURLToPath(new URL(...))` runs into under @cloudflare/workers-types.
const SRC_DIR = dirname(import.meta.filename);
/**
 * The cascade repositories the delete cascade actually CALLS, derived from
 * `ProjectService`'s own source (`this.cascadeRepos.<name>`). This replaces a
 * literal 11-name array, which could only ever be updated by hand and blocked
 * the next correct repository; the derivation changes with the code it polices.
 */
const CASCADE_REPOSITORIES_CALLED: string[] = [
  ...new Set(
    [...readFileSync(join(SRC_DIR, 'services', 'project.service.ts'), 'utf8').matchAll(/cascadeRepos\.(\w+)/g)].map(
      (match) => match[1] ?? '',
    ),
  ),
].sort();
/**
 * The class each repository is constructed from in the composition root, read
 * from `container.ts` itself.
 *
 * A graph walk that only checked "a value is present" would pass a
 * `CommentRepository` wired as `cascadeRepos.taskRepo`; binding each key to the
 * class the container builds that repository from catches the swap. The map is
 * derived, so renaming a repository needs no edit here.
 *
 * Two shapes are matched because the purge moved the wiring into a `buildRepositories()`
 * factory: `const taskRepo = new TaskRepository(…)` and the object-literal
 * `taskRepo: new TaskRepository(…)`. Only the first was matched before, and the
 * map silently became EMPTY — every assertion that consults it would then fail
 * closed (loudly, which is why it is safe to widen it), but the swap check it
 * exists for would not have been running.
 */
const REPOSITORY_CLASS_BY_VARIABLE: ReadonlyMap<string, string> = new Map(
  [
    ...readFileSync(join(SRC_DIR, 'container.ts'), 'utf8').matchAll(/(?:const\s+(\w+)\s*=|(\w+)\s*:)\s*new (\w+)\(/g),
  ].map((declaration) => [
    // Group 1 is the `const x =` form, group 2 the `x:` property form.
    declaration[1] ?? declaration[2] ?? '',
    declaration[3] ?? '',
  ]),
);

/**
 * Required-dependency guardrail: the cascade repositories and the audit service.
 *
 * `buildServices()` is the composition root. Before this test existed it was
 * imported by exactly one production caller (`middleware/services.ts`) and by
 * NO test — so it could pass 3 of 5 constructor arguments to `ProjectService`
 * and literal `undefined, undefined` to `TenantService` without anything
 * noticing. Every use of those dependencies was guarded by `if (this.x)`, so
 * the failures were silent: the project delete cascade, the tenant
 * archive/restore cascade and every project/tenant audit write never executed.
 *
 * This spec builds the REAL graph (only `getCollection` is mocked) and asserts
 * that no service holds an `undefined`/`null` dependency. Together with the
 * now-required constructor parameters (removing the `?` turns a dropped
 * argument into a compile error) the defect cannot come back silently:
 *   - dropping an argument  → `tsc --noEmit` fails (required param),
 *   - passing `undefined`   → the table below fails (this spec).
 */

vi.mock('./db/mongo.js', () => {
  // A collection is only ever stored by the repositories at construction time;
  // nothing is read or written here, so a bare stub is enough.
  const stubCollection = { name: 'stub' };

  return {
    getCollection: vi.fn((name: string) => ({ ...stubCollection, collectionName: name })),
  };
});

const ENV = { JWT_SECRET: 'test-secret', FRONTEND_URL: 'http://localhost:4200' };
/**
 * Every service key and the class it must be an instance of.
 *
 * The completeness check below walks each instance's own properties, so the
 * table does not need (and deliberately does not pin) constructor arities:
 * `Function.length` stops at the first defaulted parameter, which several
 * services have. What matters is that nothing reachable is `undefined`/`null`.
 */
const SERVICE_TABLE: { key: keyof Services; ctor: new (...args: never[]) => object }[] = [
  { key: 'auth', ctor: AuthService },
  { key: 'audit', ctor: AuditService },
  { key: 'boards', ctor: BoardService },
  { key: 'comments', ctor: CommentService },
  { key: 'filters', ctor: FilterService },
  { key: 'labels', ctor: LabelService },
  { key: 'preferences', ctor: UserPreferencesService },
  { key: 'projects', ctor: ProjectService },
  { key: 'rateLimits', ctor: RateLimitAuthorityService },
  { key: 'relationships', ctor: TaskRelationshipService },
  { key: 'sprints', ctor: SprintService },
  { key: 'statuses', ctor: StatusService },
  { key: 'tasks', ctor: TaskService },
  { key: 'taskTypes', ctor: TaskTypeService },
  { key: 'tenantMembers', ctor: TenantMemberService },
  { key: 'tenants', ctor: TenantService },
];

/**
 * Recursively collect every `undefined`/`null` value reachable from an object's
 * own enumerable properties (services store their deps as own properties).
 * Depth 2 covers the plain-object bundles the container passes in
 * (`collections`, `cascadeRepos`).
 */
function findMissing(value: unknown, path: string, depth = 0, found: string[] = []): string[] {
  if (value === undefined || value === null) {
    found.push(path);
    return found;
  }

  if (depth >= 2 || typeof value !== 'object') {
    return found;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    findMissing(child, `${path}.${key}`, depth + 1, found);
  }

  return found;
}

describe('buildServices (composition root)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // No RESEND_API_KEY in the test env ⇒ the documented ConsoleEmailService
    // fallback. Silence its per-request warning; the fallback itself is
    // asserted below.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('builds every service as an instance of its class', () => {
    const services = buildServices(ENV);

    // Correspondence first: a service added to `Services` that this table does
    // not know about would otherwise get NONE of the assertions below (class
    // identity, no missing dependency) — the table would silently cover less
    // of the graph than it claims to. Derived from the built graph, so the pair
    // is checked in both directions and a new service must be added here.
    assertCorrespondence(
      'Services ↔ SERVICE_TABLE',
      Object.keys(services),
      SERVICE_TABLE.map(({ key }) => key),
    );

    for (const { key, ctor } of SERVICE_TABLE) {
      expect(services[key], `svc.${key} must be a ${ctor.name}`).toBeInstanceOf(ctor);
    }
  });

  it('injects no undefined/null dependency into any service', () => {
    const services = buildServices(ENV);

    for (const { key } of SERVICE_TABLE) {
      const missing = findMissing(services[key], `svc.${key}`);

      expect(missing, `svc.${key} has missing dependencies: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('wires the real tenant-member repository into ProjectService (M-003 / G-02)', () => {
    const services = buildServices(ENV);
    const projects = services.projects as unknown as { tenantMemberRepo: unknown };

    // Residual risk (g): the "target user must hold an ACTIVE membership in
    // the caller's tenant" guard used to live in `routes/projects.ts`, so a
    // direct `addMember` call bypassed it. It is now a REQUIRED constructor
    // parameter; this assertion makes "wired as a real repository" a
    // graph-completeness guarantee, not a code-review convention.
    expect(projects.tenantMemberRepo).toBeInstanceOf(TenantMemberRepository);
    expect(typeof (projects.tenantMemberRepo as { findByUserAndTenant?: unknown }).findByUserAndTenant).toBe(
      'function',
    );
    // The very same instance must back the auth/tenant services, so `addMember`
    // and the tenant-context middleware cannot disagree about a membership.
    expect(projects.tenantMemberRepo).toBe(
      (services.tenantMembers as unknown as { tenantMemberRepo: unknown }).tenantMemberRepo,
    );
  });

  it('wires every cascade repository the delete cascade actually uses (M-023)', () => {
    const projects = buildServices(ENV).projects as unknown as {
      cascadeRepos: Record<string, unknown>;
      auditService: unknown;
    };

    // The property: every repository the cascade CALLS is wired, with
    // the right identity, and nothing is wired that the cascade never calls. The
    // set of called repositories is derived from `project.service.ts`, so a 12th
    // cascade repository — a legitimate change — passes with no edit here, while
    // a call site the container does not satisfy fails.
    assertCorrespondence(
      'ProjectService cascade repositories',
      Object.keys(projects.cascadeRepos).sort(),
      CASCADE_REPOSITORIES_CALLED,
    );

    for (const [name, repo] of Object.entries(projects.cascadeRepos)) {
      expect(repo, `cascadeRepos.${name} must be a repository instance`).toBeInstanceOf(Object);

      const expectedClass = REPOSITORY_CLASS_BY_VARIABLE.get(name);

      expect(expectedClass, `container.ts builds no \`${name}\` to cascade`).toBeDefined();
      expect(
        (repo as object).constructor.name,
        `cascadeRepos.${name} must be the ${expectedClass ?? '?'} that container.ts builds`,
      ).toBe(expectedClass);
    }

    expect(projects.auditService).toBeInstanceOf(AuditService);
  });

  it('wires the real project repository and audit service into TenantService (M-023)', () => {
    const services = buildServices(ENV);
    const tenants = services.tenants as unknown as {
      projectRepo: unknown;
      auditService: unknown;
      projectMemberRepo: unknown;
    };

    expect(tenants.projectRepo).toBeInstanceOf(Object);
    expect(tenants.auditService).toBe(services.audit);
    expect(tenants.projectMemberRepo).toBeInstanceOf(Object);
  });

  it('shares one audit service instance across the whole graph', () => {
    const services = buildServices(ENV);

    expect(services.projects).toBeInstanceOf(ProjectService);
    expect((services.projects as unknown as { auditService: unknown }).auditService).toBe(services.audit);
  });

  it('falls back to the console mailer and warns loudly when RESEND_API_KEY is missing', () => {
    const services = buildServices(ENV);

    expect(services.auth).toBeInstanceOf(AuthService);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY is not configured'));
  });
});

/**
 * The SECOND graph — the one the scheduled purge runs on.
 *
 * It is built by the same repository builder as the request graph, deliberately:
 * a hand-copied second wiring is how `permanentDelete` came to delete a project
 * document and nothing else. These assertions are the guardrail on that sharing.
 */
describe('buildPurgeService (composition root, second graph)', () => {
  // The purge graph builds no mailer, so it emits no RESEND warning; the spy is
  // here only to keep a warning from reaching the test output if that changes.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('builds a PurgeService with no undefined dependency', () => {
    const purge = buildPurgeService();

    expect(purge).toBeInstanceOf(PurgeService);
    expect(findMissing(purge, 'svc.purge')).toEqual([]);
  });

  it('the purge graph carries every cascade repository the request graph does', () => {
    const services = buildServices(ENV);
    const purge = buildPurgeService() as unknown as {
      projectService: { cascadeRepos: Record<string, unknown> };
    };
    const projects = services.projects as unknown as { cascadeRepos: Record<string, unknown> };

    // Derived from BOTH sides, so a repository added to the cascade and forgotten
    // in the purge graph fails here rather than in production. (They are separate
    // graphs, so the repositories are separate instances; what must match is the
    // SET, and the two instances are built from the same builder.)
    expect(Object.keys(purge.projectService.cascadeRepos).sort()).toEqual(Object.keys(projects.cascadeRepos).sort());
  });

  it('the workspace purge reaches the project cascade', () => {
    // The single assertion that would have caught the original defect: a
    // `TenantService` with no project purge is a workspace delete that removes
    // two collections and leaves every project behind.
    const purge = buildPurgeService() as unknown as {
      tenantService: { projectPurge: { purgeProjectData: unknown } };
    };

    expect(typeof purge.tenantService.projectPurge.purgeProjectData).toBe('function');
  });
});
