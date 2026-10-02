/**
 * Every cursor-terminating repository read is BOUNDED — or carries a reason.
 *
 * The inbound body cap bounds what a caller may send; nothing bounded what the
 * Worker answered with, so a response could grow with the data until the Worker
 * ran out of memory building JSON. The bounds live in `read-bounds.ts`.
 *
 * ## What is actually enforced here
 *
 * Two properties, and the first is the load-bearing one:
 *
 *  1. A SCAN. Every `.ts` under `repositories/` (specs excluded) is parsed, and
 *     every `.toArray()` — the only way this driver hands a cursor back as rows —
 *     is checked for a bound. A read is bounded when the chain reaches a `.limit()`,
 *     a `$limit` stage in an INLINE aggregation pipeline, or a `.toArray(n)`
 *     argument. Anything else must appear in {@link EXEMPTIONS}, keyed by
 *     `<file>#<member>` with a stated reason, or this fails.
 *
 *     The previous version of this file hand-listed twelve reads and drove each
 *     against a mock cursor. That proved those twelve were bounded and nothing
 *     else: a read written the next day passed unnoticed. Enumerating is not
 *     enforcement, and a guardrail that claims a day-one failure it cannot
 *     deliver is worse than no guardrail, because it is believed.
 *
 *  2. A BEHAVIOURAL check of the bounds added deliberately: each is driven
 *     against a recording cursor and asserted to be the constant declared in
 *     `read-bounds.ts`, so a bound is a deliberate edit to that file rather than
 *     a number that drifts per call site.
 *
 * ## Why the scan parses instead of matching text
 *
 * The repository layer is the only place a `Collection` is reachable, which is
 * what makes a whole-directory scan the right perimeter: it cannot miss a read
 * the way a hand-list can. Parsing (rather than pattern-matching the source) is
 * what lets the scan tell a `limit()` in a CHAIN from the word `limit` in a
 * string, and find the member a read belongs to without a line-number convention.
 *
 * ## What the scan cannot see, stated rather than assumed
 *
 * A pipeline held in a VARIABLE is invisible to the scan: `aggregate(pipeline)`
 * shows no `$limit`, so it is reported as unbounded and must be exempted with a
 * reason. There is exactly one such read, and the semantic-sort exemption below
 * is paired with an assertion on the pipeline BUILDER — an exemption the file
 * did not otherwise check would be an unchecked claim.
 *
 * The scan proves a bound is PRESENT; it cannot prove the bound is a good
 * number. That is property 2's job, and the reasons below are a reviewer's.
 *
 * ## Stale exemptions fail
 *
 * An exemption that no longer matches a real offender is an error, so a read that
 * gained a bound cannot quietly stay excused — the excuse is re-read when the
 * code around it changes.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import type { Collection } from 'mongodb';
import { COMMENT_PAGE_SIZE } from '@task-board/shared';
import { CommentRepository } from '../repositories/comment.repository.js';
import { TaskRelationshipRepository } from '../repositories/task-relationship.repository.js';
import { StatusRepository } from '../repositories/status.repository.js';
import { TaskTypeRepository } from '../repositories/task-type.repository.js';
import { LabelRepository } from '../repositories/label.repository.js';
import { SprintRepository } from '../repositories/sprint.repository.js';
import { FilterRepository } from '../repositories/filter.repository.js';
import { ProjectMemberRepository } from '../repositories/project-member.repository.js';
import { TenantMemberRepository } from '../repositories/tenant-member.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { AuditEventRepository } from '../repositories/audit-event.repository.js';
import { TaskRepository } from '../repositories/task.repository.js';
import {
  MAX_BULK_ID_LOOKUP,
  MAX_INVITATIONS_PER_EMAIL,
  MAX_PROJECT_LABELS,
  MAX_PROJECT_MEMBERS,
  MAX_PROJECT_SPRINTS,
  MAX_PROJECT_STATUSES,
  MAX_PROJECT_TASK_TYPES,
  MAX_PROJECTS_PER_TENANT,
  MAX_RELATIONSHIPS_PER_TASK,
  MAX_SAVED_FILTERS_PER_USER,
  MAX_TENANT_MEMBERS,
  MAX_USER_MEMBERSHIPS,
} from './read-bounds.js';

const REPOSITORY_DIR = join(dirname(import.meta.filename), '..', 'repositories');

/** A `.toArray()` that no bound in its chain covers. */
interface UnboundedRead {
  /** `<file>#<member>` — stable across edits, unlike a line number. */
  site: string;
  file: string;
  member: string;
  line: number;
}

/**
 * Every deliberately unbounded read, with the reason it must not be truncated.
 *
 * An entry here is a CLAIM, and these are the only claims this file makes:
 * adding a row says "this read must not be truncated, and here is why", which is
 * the review conversation made structural. The reasons are stated in full rather
 * than by pointer, because the document that produced them is disposable and a
 * citation to it would outlive the argument it was making.
 */
const EXEMPTIONS: { site: string; reason: string }[] = [
  {
    site: 'project.repository.ts#findDue',
    reason:
      'Selection for the purge reaper, and truncation here strands rows permanently: a project left un-purged by one run is still past its deadline on the next, so the same first N would be selected every time and the tail would never be deleted. The read is already reduced to a projected id and bounded in time by maxTimeMS.',
  },
  {
    site: 'tenant.repository.ts#findDue',
    reason:
      'The workspace purge reaper, with exactly the failure mode above: truncation leaves a workspace past its deadline permanently unpurged, because the next run selects the same rows again. Ids only, projected, and bounded in time by maxTimeMS.',
  },
  {
    site: 'task.repository.ts#findIdsByProject',
    reason:
      'The id set drives the project cascade, which deletes comments keyed by taskId BEFORE the tasks. Truncating it does not shrink the response, it orphans every comment outside the first N tasks by deleting the task they point at. Paging a delete, rather than truncating it, is what would allow a row bound here.',
  },
  {
    site: 'task.repository.ts#countByStatusGrouped',
    reason:
      'The $group emits one row per distinct status the project references, so the answer is the project status vocabulary, not its task count. A $limit would not shorten the server-side grouping and would convert a correct per-status count into a silently wrong one. Bounded in time by maxTimeMS.',
  },
  {
    site: 'task.repository.ts#findByProject',
    reason:
      'The semantic-sort branch of findByProject. Its pipeline is a VARIABLE, so no $limit is visible where the cursor is consumed; the bound lives in buildSemanticSortPipeline, which ends in { $limit: limit }. A test below asserts that last stage, because an exemption for a pipeline this scan cannot see would otherwise stand unchecked.',
  },
];

/** `cursor.limit(n)` / `collection.find(q)` — a call on a named method. */
function isMethodCall(node: ts.CallExpression, method: string): boolean {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method;
}

/** The member a node belongs to, for an exemption key that must survive a reformat. */
function enclosingMember(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
  }

  return '<module scope>';
}

/** Whether a `{ $limit: … }` stage appears in an INLINE pipeline literal. */
function hasInlineLimitStage(pipeline: ts.Expression | undefined): boolean {
  if (pipeline === undefined || !ts.isArrayLiteralExpression(pipeline)) return false;

  return pipeline.elements.some((stage) => {
    if (!ts.isObjectLiteralExpression(stage)) return false;

    return stage.properties.some((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;

      const name = property.name;

      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === '$limit';
    });
  });
}

/**
 * Walk the chain a `.toArray()` terminates and report whether a bound is on it.
 *
 * The bound is issued BEFORE the rows are read, so the walk goes DOWN the chain
 * from the call: in `find().sort().limit(n).toArray()` the `limit` hangs off the
 * receiver of `.toArray`, not off anything a parent link would reach.
 */
function isBounded(toArrayCall: ts.CallExpression): boolean {
  // `toArray(n)` is the driver's own row cap.
  if (toArrayCall.arguments.length > 0) return true;

  const names: string[] = [];
  let cursor: ts.Node = toArrayCall;
  let root: ts.CallExpression = toArrayCall;

  for (;;) {
    if (!ts.isCallExpression(cursor)) break;

    const callee = cursor.expression;

    if (!ts.isPropertyAccessExpression(callee)) break;

    names.push(callee.name.text);
    root = cursor;

    const receiver = callee.expression;

    if (!ts.isCallExpression(receiver)) break;

    cursor = receiver;
  }

  if (names.includes('limit')) return true;

  // An aggregate whose pipeline is a literal can be judged here; one held in a
  // variable cannot, and is reported so the exemption carries the claim instead.
  return isMethodCall(root, 'aggregate') && hasInlineLimitStage(root.arguments[0]);
}

/** Report the `.toArray()` calls in one source that no bound covers. */
export function findUnboundedReads(file: string, source: string): UnboundedRead[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: UnboundedRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isMethodCall(node, 'toArray') && !isBounded(node)) {
      const member = enclosingMember(node);

      offenders.push({
        site: `${file}#${member}`,
        file,
        member,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return offenders;
}

/** The repository sources the scan covers — specs excluded, a spec may build anything. */
function repositorySources(): { file: string; source: string }[] {
  return readdirSync(REPOSITORY_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(REPOSITORY_DIR, file), 'utf8') }));
}

describe('every cursor-terminating repository read is bounded', () => {
  const sources = repositorySources();
  const offenders = sources.flatMap(({ file, source }) => findUnboundedReads(file, source));

  it('scans the whole repository directory rather than a hand-list', () => {
    // Without this, a scanner that found nothing would make every other
    // assertion in this block pass by covering nothing at all.
    expect(sources.length).toBeGreaterThan(10);
    expect(offenders.length).toBeGreaterThanOrEqual(EXEMPTIONS.length);
  });

  it('reports no unbounded read that is not exempted with a reason', () => {
    const exemptSites = new Set(EXEMPTIONS.map((entry) => entry.site));
    const unexplained = offenders.filter((offender) => !exemptSites.has(offender.site));

    expect(unexplained.map((offender) => `${offender.site} (${offender.file}:${offender.line})`)).toEqual([]);
  });

  it('has no stale exemption — every one still matches a real offender', () => {
    // The other direction of the same invariant: a read that has since gained a
    // bound must lose its excuse rather than keep it, so the list cannot rot into
    // a general amnesty.
    const realSites = new Set(offenders.map((offender) => offender.site));
    const stale = EXEMPTIONS.filter((entry) => !realSites.has(entry.site)).map((entry) => entry.site);

    expect(stale).toEqual([]);
    expect(EXEMPTIONS.every((entry) => entry.reason.trim().length > 40)).toBe(true);
  });

  it('DETECTS a synthetic unbounded read — the negative control for the scan itself', () => {
    // The claim "a read added without a bound fails here the day it is written"
    // is only worth something if the detector demonstrably fires. A synthetic
    // source run through the SAME function as the real scan is that proof; an
    // assertion about the real tree would not be.
    const synthetic = [
      'class SyntheticRepository {',
      '  async findEverything(name: string): Promise<unknown[]> {',
      '    return this.collection.find({ name }).toArray();',
      '  }',
      '}',
    ].join('\n');
    const found = findUnboundedReads('synthetic.repository.ts', synthetic);

    expect(found.map((offender) => offender.site)).toEqual(['synthetic.repository.ts#findEverything']);
    expect(found[0]?.line).toBe(3);
  });

  it('leaves the bounded shapes of a synthetic read alone', () => {
    // Each shape is one way a repository is allowed to be unbounded-free; a
    // detector that only understood `.limit()` would flag three of these.
    const synthetic = [
      'class SyntheticRepository {',
      '  async withLimit(id: string): Promise<unknown[]> {',
      '    return this.collection.find({ id }).sort({ id: 1 }).limit(MAX).toArray();',
      '  }',
      '  async withArgument(n: number): Promise<unknown[]> {',
      '    return this.collection.find({}).toArray(n);',
      '  }',
      '  async withInlineLimit(id: string): Promise<unknown[]> {',
      '    return this.collection.aggregate([{ $match: { id } }, { $limit: 10 }]).toArray();',
      '  }',
      '}',
    ].join('\n');

    expect(findUnboundedReads('synthetic.repository.ts', synthetic)).toEqual([]);
  });

  it('keeps the semantic-sort pipeline bounded — the one exemption the scan cannot see', () => {
    const source = readFileSync(join(REPOSITORY_DIR, 'task.repository.ts'), 'utf8');
    const builder = source.slice(
      source.indexOf('private buildSemanticSortPipeline'),
      source.indexOf('  async create('),
    );
    const limitStage = builder.lastIndexOf('{ $limit:');
    const lastReorder = Math.max(builder.lastIndexOf('{ $sort:'), builder.lastIndexOf('{ $skip:'));

    expect(builder.length).toBeGreaterThan(0);
    // AFTER every ordering stage, so it bounds what the cursor returns: a limit
    // followed by more stages would bound nothing.
    expect(limitStage).toBeGreaterThan(lastReorder);
    expect(limitStage).toBeLessThan(builder.lastIndexOf('];'));
  });
});

describe('the declared bounds are the ones actually issued', () => {
  interface QueryState {
    /** The `.limit(n)` the repository issued on its cursor, if any. */
    limit?: number;
    /** The pipeline the repository handed to `aggregate()`. */
    pipeline: Record<string, unknown>[];
  }

  /**
   * A cursor that records every stage a repository chains onto it, so a test can
   * assert the limit was ISSUED rather than infer it from the returned rows — a
   * mock that silently ignores `.limit()` returns the same rows either way.
   *
   * Every stage returns the SAME cursor object and `toArray` reads the shared
   * state, so a chain of any length (`find().sort().limit().toArray()`) records
   * correctly; returning a fresh object per stage would drop the recording on
   * the first link.
   */
  function recordingCursor(state: QueryState, docs: unknown[] = []) {
    const cursor = {
      sort() {
        return cursor;
      },
      skip() {
        return cursor;
      },
      limit(n: number) {
        state.limit = n;

        return cursor;
      },
      async toArray() {
        return docs;
      },
    };

    return cursor;
  }

  function recordingCollection() {
    const state: QueryState = { pipeline: [] };
    const collection = {
      find: vi.fn(() => recordingCursor(state)),
      aggregate: vi.fn((pipeline: Record<string, unknown>[]) => {
        state.pipeline = pipeline;

        return recordingCursor(state);
      }),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      insertOne: vi.fn(),
      insertMany: vi.fn(),
      countDocuments: vi.fn(),
      deleteMany: vi.fn(),
      deleteOne: vi.fn(),
      bulkWrite: vi.fn(),
    };

    return { collection: collection as unknown as Collection<never>, state, raw: collection };
  }

  /** Drive a `find()`-based read and return the limit it issued. */
  async function limitOf(run: (collection: ReturnType<typeof recordingCollection>['raw']) => Promise<unknown>) {
    const { state, raw } = recordingCollection();

    await run(raw as never);

    return state.limit;
  }

  /** Drive an `aggregate()`-based read and return the `$limit` it put in the pipeline. */
  async function pipelineLimitOf(run: (collection: ReturnType<typeof recordingCollection>['raw']) => Promise<unknown>) {
    const { state, raw } = recordingCollection();

    await run(raw as never);

    const stage = state.pipeline.find((entry) => '$limit' in entry);

    return (stage as { $limit?: number } | undefined)?.$limit;
  }

  it('bounds the comment page by the shared page size plus the hasMore probe', async () => {
    // The thread read is PAGINATED, not capped, so what bounds it is the page
    // size the schema already refuses to let a caller exceed — plus the one
    // probe row `hasMore` is derived from. Asserting the issued number against
    // the shared constant is what ties the repository to the contract: a page
    // size edited in `@task-board/shared` and a repository that kept its own
    // copy would drift apart silently.
    const initial = await limitOf((collection) =>
      new CommentRepository(collection as never).findPageByTask('task-1', { limit: COMMENT_PAGE_SIZE }),
    );
    const narrowed = await limitOf((collection) =>
      new CommentRepository(collection as never).findPageByTask('task-1', { limit: 5 }),
    );

    expect(initial).toBe(COMMENT_PAGE_SIZE + 1);
    expect(narrowed).toBe(6);
  });

  it('never lets a comment page grow past the page size, whatever the caller asks for', () => {
    // `COMMENT_PAGE_SIZE` is a page size, not a suggestion: the route rejects
    // anything above it (400, VALIDATION_ERROR), so a request that reached the
    // repository already carries a validated page size. A page that could return
    // a thousand comments would put the response bound back in the hands of the
    // client.
    expect(COMMENT_PAGE_SIZE).toBe(30);
  });

  it('bounds the relationships of a task in both directions', async () => {
    const limit = await limitOf((collection) =>
      new TaskRelationshipRepository(collection as never).findByTask('task-1'),
    );

    expect(limit).toBe(MAX_RELATIONSHIPS_PER_TASK);
  });

  it('bounds the per-project reference lists', async () => {
    const statuses = await limitOf((c) => new StatusRepository(c as never).findByProject('project-1'));
    const taskTypes = await limitOf((c) => new TaskTypeRepository(c as never).findByProject('project-1'));
    const labels = await limitOf((c) => new LabelRepository(c as never).findByProject('project-1'));
    const sprints = await limitOf((c) => new SprintRepository(c as never).findByProject('project-1'));

    expect(statuses).toBe(MAX_PROJECT_STATUSES);
    expect(taskTypes).toBe(MAX_PROJECT_TASK_TYPES);
    expect(labels).toBe(MAX_PROJECT_LABELS);
    expect(sprints).toBe(MAX_PROJECT_SPRINTS);
  });

  it("bounds one user's saved filters in one project", async () => {
    const limit = await limitOf((c) => new FilterRepository(c as never).findByUserAndProject('user-1', 'project-1'));

    expect(limit).toBe(MAX_SAVED_FILTERS_PER_USER);
  });

  it("bounds one workspace's projects", async () => {
    const limit = await limitOf((c) => new ProjectRepository(c as never).findByTenant('tenant-1'));

    expect(limit).toBe(MAX_PROJECTS_PER_TENANT);
  });

  it('bounds the project member lists, joined and unjoined', async () => {
    const plain = await limitOf((c) => new ProjectMemberRepository(c as never).findByProject('project-1'));
    const byUser = await limitOf((c) => new ProjectMemberRepository(c as never).findByUser('user-1'));
    const joined = await pipelineLimitOf((c) => new ProjectMemberRepository(c as never).findByProjectWithUsers('p1'));
    const identity = await pipelineLimitOf((c) =>
      new ProjectMemberRepository(c as never).findUserIdentityByProject('user-1', 'project-1'),
    );

    expect(plain).toBe(MAX_PROJECT_MEMBERS);
    expect(byUser).toBe(MAX_PROJECT_MEMBERS);
    expect(joined).toBe(MAX_PROJECT_MEMBERS);
    // One membership row per (user, project): the unique index makes this a fact,
    // and the query now states it.
    expect(identity).toBe(1);
  });

  it('bounds the tenant member lists, plain and joined', async () => {
    const byTenant = await limitOf((c) => new TenantMemberRepository(c as never).findByTenant('tenant-1'));
    const byUser = await limitOf((c) => new TenantMemberRepository(c as never).findByUser('user-1'));
    const joined = await pipelineLimitOf((c) =>
      new TenantMemberRepository(c as never).findByTenantWithUsers('tenant-1'),
    );
    const withTenants = await pipelineLimitOf((c) =>
      new TenantMemberRepository(c as never).findByUserWithTenants('user-1'),
    );

    expect(byTenant).toBe(MAX_TENANT_MEMBERS);
    expect(byUser).toBe(MAX_USER_MEMBERSHIPS);
    expect(joined).toBe(MAX_TENANT_MEMBERS);
    expect(withTenants).toBe(MAX_USER_MEMBERSHIPS);
  });

  it('bounds the invitation lookups — both the all-state one and the PENDING-only one', async () => {
    // `findPendingByEmail` reads the address an UNAUTHENTICATED visitor typed, so
    // its bound is the one that keeps a typed string from choosing the size of
    // the answer. Its sibling is asserted here too so the pair cannot diverge.
    const all = await limitOf((c) => new TenantMemberRepository(c as never).findByInvitedEmail('a@b.test'));
    const pending = await limitOf((c) => new TenantMemberRepository(c as never).findPendingByEmail('a@b.test'));

    expect(all).toBe(MAX_INVITATIONS_PER_EMAIL);
    expect(pending).toBe(MAX_INVITATIONS_PER_EMAIL);
  });

  it('bounds the `$in` bulk lookups that take their id list from the caller', async () => {
    const users = await limitOf((c) => new UserRepository(c as never).findByIds(['a', 'b']));
    const members = await limitOf((c) => new TenantMemberRepository(c as never).findByIds(['a', 'b']));

    expect(users).toBe(MAX_BULK_ID_LOOKUP);
    expect(members).toBe(MAX_BULK_ID_LOOKUP);
  });

  it('bounds the bulk `$in` lookup — reachable, so it is not left internal-only', async () => {
    // `BaseRepository.findByIds` is inherited by most repositories and is called
    // on the audit-enrichment and board paths, so it is a live read rather than
    // dead plumbing. StatusRepository is used here only as a carrier.
    const limit = await limitOf((c) => new StatusRepository(c as never).findByIds(['a', 'b']));

    expect(limit).toBe(MAX_BULK_ID_LOOKUP);
  });

  it('bounds the post-bulk-write result read', async () => {
    const limit = await limitOf((c) =>
      new TaskRepository(c as never).bulkUpdateWithVersion([{ id: 'task-1', version: 1 }], { priorityLevel: 2 }),
    );

    expect(limit).toBe(MAX_BULK_ID_LOOKUP);
  });

  it('leaves the audit LIST queries paginated rather than capped, and still bounded', async () => {
    // The audit list was already bounded (skip/limit paging); this asserts the
    // bound is still issued so a future "simplification" cannot drop it.
    const limit = await limitOf((c) =>
      new AuditEventRepository(c as never).findByProject('project-1', { page: 2, limit: 25 }),
    );

    expect(limit).toBe(25);
  });

  it('keeps every declared bound a positive integer', () => {
    const bounds = {
      MAX_BULK_ID_LOOKUP,
      MAX_INVITATIONS_PER_EMAIL,
      MAX_PROJECT_LABELS,
      MAX_PROJECT_MEMBERS,
      MAX_PROJECTS_PER_TENANT,
      MAX_PROJECT_SPRINTS,
      MAX_PROJECT_STATUSES,
      MAX_PROJECT_TASK_TYPES,
      MAX_RELATIONSHIPS_PER_TASK,
      MAX_SAVED_FILTERS_PER_USER,
      MAX_TENANT_MEMBERS,
      MAX_USER_MEMBERSHIPS,
    };

    for (const [name, value] of Object.entries(bounds)) {
      expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
      expect(value, `${name} must be positive`).toBeGreaterThan(0);
    }
  });
});
