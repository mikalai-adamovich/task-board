/**
 * One-shot data migrations for existing databases.
 *
 * Each migration is idempotent: running it against an already-conformed
 * database is a no-op, so it is safe to invoke on every cold start.
 */
import type { Db, Document, IndexDescriptionInfo } from 'mongodb';
import { MemberStatus, InvitationStatus, generateSlugFromName, TENANT_SLUG_MAX_LENGTH } from '@task-board/shared';
import { createLogger } from '../utils/logger.js';
import { toPlainText } from '../utils/markdown-plain-text.js';

const log = createLogger({ scope: 'migrations' });
/** MongoDB server error code for "ns not found" (the collection does not exist). */
const NAMESPACE_NOT_FOUND = 26;

// ─── Audit retention ──────────────────────────────────────────────────────────

/**
 * How long an audit record is kept, in days.
 *
 * The decision table's question was "forever, for a fixed window, or per tenant",
 * and the answer is a FIXED WINDOW, enforced by a time-to-live index on
 * `audit_events.createdAt` (see `CORE_INDEXES`). One number, one place, so
 * changing the policy is a one-line change and an index rebuild — not a hunt
 * through three comments that used to disagree about it.
 *
 * 400 days, and the reasoning is worth stating because it is a judgement, not a
 * derivation: it covers a full year plus a margin, so a comparison against the
 * same period last year is possible at the boundary, and it is long enough that
 * "somebody deleted the audit log" is not a question a normal user has to ask.
 * A regulatory minimum (seven years for financial records, say) is a different
 * product with a different customer; a 90-day window would be a defensible
 * privacy-first choice and is a one-line change here.
 *
 * The consequence a user has to understand: **the audit log is not a permanent
 * record.** Events older than this are removed by the database, and the audit
 * viewer cannot show them. "We deleted it" (an application action) and "it is
 * gone" (a TTL sweep) are different statements, and this constant is what makes
 * the second one true eventually.
 */
export const AUDIT_RETENTION_DAYS = 400;

/** The same window in seconds — the unit a time-to-live index takes. */
export const AUDIT_RETENTION_SECONDS = AUDIT_RETENTION_DAYS * 24 * 60 * 60;

/**
 * Documents per `bulkWrite` in {@link backfillTaskDescriptionText}.
 *
 * Bounded so the migration's working set (a `_id` + `description` projection per
 * document) stays small on a large table, and so a failure mid-run loses at most
 * one batch — the run is idempotent, so a re-run simply continues.
 */
const TASK_TEXT_BACKFILL_BATCH = 500;

/**
 * List a collection's indexes, tolerating a collection that has never
 * been created.
 *
 * `collection.indexes()` runs a `listIndexes` command against the collection
 * namespace, so on a brand-new database MongoDB answers with
 * `NamespaceNotFound` (code 26) instead of an empty list — which crashed the
 * whole migration run and made a fresh environment impossible to bootstrap.
 *
 * A collection that does not exist has no indexes, so the namespace error IS
 * the answer. Every OTHER error is re-thrown: swallowing them would hide real
 * connectivity/authentication failures behind a silently "empty" result.
 */
export async function listIndexesSafely(collection: {
  indexes(): Promise<IndexDescriptionInfo[]>;
}): Promise<IndexDescriptionInfo[]> {
  try {
    return await collection.indexes();
  } catch (err) {
    const code = (err as { code?: unknown }).code;

    if (code === NAMESPACE_NOT_FOUND) {
      return [];
    }
    throw err;
  }
}

// ─── DEC-018 Migration ───────────────────────────────────────────────────────

/**
 * Rewrite invited memberships created under the old semantics.
 *
 * Before DEC-018 an invited member was stored as `status = ACTIVE` with an
 * embedded PENDING invitation (the invitation tracked the pending state).
 * Under DEC-018 the membership itself must be `ACCESS_REVOKED` until the
 * invitee explicitly accepts.
 *
 * Matches docs with `invitation.status = 'PENDING'` and `status = 'ACTIVE'`
 * and flips them to `ACCESS_REVOKED`. Returns the number of rewritten docs.
 */
export async function migrateInvitedMembershipsToRevoked(db: Db): Promise<number> {
  const result = await db
    .collection('tenant_members')
    .updateMany(
      { status: MemberStatus.ACTIVE, 'invitation.status': InvitationStatus.PENDING },
      { $set: { status: MemberStatus.ACCESS_REVOKED } },
    );

  if (result.modifiedCount > 0) {
    log.warn('DEC-018: rewrote invited member(s) to ACCESS_REVOKED', { count: result.modifiedCount });
  }

  return result.modifiedCount;
}

// ─── DEC-032 Migrations ──────────────────────────────────────────────────────

interface TenantBackfillDocument {
  _id: import('mongodb').ObjectId;
  name?: string;
  slug?: string | null;
}

/**
 * Truncate a base slug so that the `-<n>` collision suffix still fits within
 * the max slug length (never ending on a hyphen).
 */
function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  const body = base.slice(0, TENANT_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '');

  return `${body}${suffix}`;
}

/**
 * Backfill the tenant `slug` field for tenants created before DEC-032.
 *
 * The slug is generated from the tenant name; on collision a numeric suffix
 * is appended (`-2`, `-3`, …). Idempotent: only documents missing a slug are
 * touched, so re-running against a conformed database is a no-op.
 *
 * Returns the number of backfilled tenants. Must run BEFORE
 * {@link ensureTenantSlugUniqueIndex} on first deployment.
 */
export async function backfillTenantSlugs(db: Db): Promise<number> {
  const tenants = db.collection<TenantBackfillDocument>('tenants');
  const missing = await tenants.find({ $or: [{ slug: { $exists: false } }, { slug: null }] }).toArray();
  let updated = 0;

  for (const doc of missing) {
    const base = generateSlugFromName(doc.name ?? '') || 'workspace';
    let candidate = base;
    let n = 1;

    while (await tenants.findOne({ slug: candidate })) {
      n += 1;
      candidate = withSuffix(base, n);
    }

    await tenants.updateOne({ _id: doc._id }, { $set: { slug: candidate } });
    updated += 1;
  }

  if (updated > 0) {
    log.warn('DEC-032: backfilled slug for tenant(s)', { count: updated });
  }

  return updated;
}

/**
 * Create the global unique index on `{ slug: 1 }`.
 *
 * `createIndex` is idempotent — an existing identical index is a no-op.
 * Run {@link backfillTenantSlugs} first so legacy rows cannot violate the
 * uniqueness constraint during index build.
 */
export async function ensureTenantSlugUniqueIndex(db: Db): Promise<void> {
  await db.collection('tenants').createIndex({ slug: 1 }, { unique: true });
}

/**
 * Run the slug backfill and the unique index creation back-to-back as a
 * single migration step. Invoking them as two separate steps in the startup
 * sequence left a window where a concurrent isolate could insert a duplicate
 * slug between the backfill and the index build.
 */
export async function ensureTenantSlugIntegrity(db: Db): Promise<void> {
  await backfillTenantSlugs(db);
  await ensureTenantSlugUniqueIndex(db);
}

// ─── DEC-055 Migration ───────────────────────────────────────────────────────

/**
 * Backfill the tenant-member `expiresAt` field.
 *
 * Members created before the field existed have no `expiresAt`; the domain
 * contract is `Date | null`, so legacy documents are set to `null`
 * (= never expires). Idempotent: only documents missing the field are
 * touched. Returns the number of backfilled documents.
 */
export async function backfillMemberExpiresAt(db: Db): Promise<number> {
  const result = await db
    .collection('tenant_members')
    .updateMany({ expiresAt: { $exists: false } }, { $set: { expiresAt: null } });

  if (result.modifiedCount > 0) {
    log.warn('DEC-055: backfilled expiresAt on member document(s)', { count: result.modifiedCount });
  }

  return result.modifiedCount;
}

// ─── Seed-status display-name migration ─────────────────────────────────

/**
 * Raw seed-status keys → human-readable display names.
 * Keyed by normalizedName so only the original seed statuses are touched —
 * user-created or user-renamed statuses are never modified.
 */
const SEED_STATUS_NAME_MAP: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  reopened: 'Reopened',
  done: 'Done',
};

/**
 * Rename seed statuses that still carry their raw enum keys as display names
 * (`TODO` → `To Do`, `IN_PROGRESS` → `In Progress`, …).
 *
 * Matches by `normalizedName` AND exact raw-key `name`, so it is idempotent:
 * already-renamed or custom-named statuses never match. Returns the number of
 * renamed documents.
 */
export async function renameSeedStatusNames(db: Db): Promise<number> {
  const statuses = db.collection('statuses');
  let updated = 0;

  for (const [normalizedName, displayName] of Object.entries(SEED_STATUS_NAME_MAP)) {
    const result = await statuses.updateMany(
      { normalizedName, name: normalizedName.toUpperCase() },
      { $set: { name: displayName, updatedAt: new Date() } },
    );

    updated += result.modifiedCount;
  }

  if (updated > 0) {
    log.warn('DR-1: renamed seed status(es) to human-readable names', { count: updated });
  }

  return updated;
}

// ─── Core Indexes ────────────────────────────────────────────────────────────

interface IndexDefinition {
  collection: string;
  spec: Record<string, 1 | -1>;
  /**
   * Forwarded to `createIndex`. `expireAfterSeconds` is the time-to-live option
   * A single-field date index carrying it is how an audit row is retired
   * on a clock rather than by an application delete.
   */
  options?: { unique?: boolean; expireAfterSeconds?: number };
  /**
   * This index MUST NOT be built while pre-existing duplicates remain —
   * `createIndex({unique:true})` aborts the whole build with `DuplicateKey`
   * when it finds them. The index is created only after a duplicate probe has
   * confirmed the key is currently clean; otherwise the migration reports the
   * offending groups and leaves the index out (see `hasDuplicatesFor`).
   */
  requiresDuplicateFreeData?: boolean;
}

/**
 * Every index required by the repositories, created programmatically.
 *
 * Repository file headers document these indexes, but before this function
 * nothing created them — new environments silently ran with full collection
 * scans and no uniqueness enforcement (e.g. `users.email`: the check-then-insert
 * registration flow races into duplicate accounts without it).
 */
export const CORE_INDEXES: IndexDefinition[] = [
  // users
  { collection: 'users', spec: { id: 1 }, options: { unique: true } },
  { collection: 'users', spec: { email: 1 }, options: { unique: true } },
  // `findByPasswordResetToken` filters on
  // {'passwordReset.tokenHash', deletedAt: null} — no index contained the token
  // hash, so the lookup was a full COLLSCAN on an UNAUTHENTICATED path
  // (POST /auth/forgot-password). Beyond the latency it was a secret oracle:
  // the response-time difference between "token found" and "token not found"
  // leaks token validity. Measured COLLSCAN → IXSCAN (500 docs → 0).
  { collection: 'users', spec: { 'passwordReset.tokenHash': 1 } },
  // tenants ({ slug: 1 } unique is handled by ensureTenantSlugUniqueIndex)
  { collection: 'tenants', spec: { id: 1 }, options: { unique: true } },
  // tenant_members
  { collection: 'tenant_members', spec: { id: 1 }, options: { unique: true } },
  { collection: 'tenant_members', spec: { tenantId: 1, userId: 1 }, options: { unique: true } },
  { collection: 'tenant_members', spec: { tenantId: 1 } },
  // MongoDB query-plan audit 2026-09-02: the auth/bootstrap path queries by
  // {userId} alone (findByUser, findByUserWithTenants, countOwnedTenants) —
  // the {tenantId, userId} index does not apply (tenantId is its prefix),
  // so those shapes ran as a COLLSCAN.
  { collection: 'tenant_members', spec: { userId: 1 } },
  { collection: 'tenant_members', spec: { 'invitation.tokenHash': 1 } },
  { collection: 'tenant_members', spec: { 'invitation.invitedEmail': 1 } },
  // The membership counter is a countDocuments call on
  // {userId, role}. Both fields existed in CORE_INDEXES but only as single-field
  // indexes whose prefix had to be walked and re-checked per key; the compound
  // form lets COUNT_SCAN use a single contiguous range.
  //
  // The sibling compound index {tenantId: 1, status: 1} was REMOVED. Its
  // only serving query was `TenantMemberRepository.countActiveByTenant`, which
  // had no caller anywhere in the codebase (dead code). The index-coverage
  // guardrail in `migrations.test.ts` enforces exactly this pairing: a repository
  // that drops a query must drop the index it served. {tenantId: 1} (from
  // `findByTenant`) is unaffected and still covers the tenant-scoped reads.
  { collection: 'tenant_members', spec: { userId: 1, role: 1 } },
  // projects
  { collection: 'projects', spec: { id: 1 }, options: { unique: true } },
  { collection: 'projects', spec: { tenantId: 1, key: 1 }, options: { unique: true } },
  // The non-unique { key: 1 } index (added for
  // `ProjectRepository.findByKey`) was REMOVED. `findByKey` looked a project up by
  // `key` ALONE — it was tenant-unsafe by construction — and had no caller: every
  // project lookup goes through `findByTenantAndKey` (served by the unique
  // {tenantId, key} index) or `BaseRepository.findById` (served by {id: 1}). With
  // the query gone the index only cost write amplification on every project
  // insert/update. The index-coverage guardrail in `migrations.test.ts` enforces
  // this pairing.
  // project_members
  { collection: 'project_members', spec: { id: 1 }, options: { unique: true } },
  { collection: 'project_members', spec: { projectId: 1, userId: 1 }, options: { unique: true } },
  // The IDENTICAL gap that `{tenantId, userId}` left on
  // tenant_members (see the note above it) was never fixed here — `findByUser`
  // resolves a user's memberships across ALL projects, so `projectId` is the
  // prefix that does not apply. Measured COLLSCAN over 2,000 documents; this
  // query guards authorisation (project-scoped role resolution), so a linear
  // scan is a latency problem on the hot authz path, not just a slow read.
  { collection: 'project_members', spec: { userId: 1 } },
  // tasks
  { collection: 'tasks', spec: { id: 1 }, options: { unique: true } },
  { collection: 'tasks', spec: { projectId: 1, number: -1 }, options: { unique: true } },
  { collection: 'tasks', spec: { projectId: 1, createdAt: -1 } },
  { collection: 'tasks', spec: { projectId: 1, updatedAt: -1 } },
  { collection: 'tasks', spec: { projectId: 1, statusId: 1 } },
  { collection: 'tasks', spec: { projectId: 1, sprintId: 1 } },
  { collection: 'tasks', spec: { projectId: 1, assigneeId: 1 } },
  // Denormalized sort names — indexed sort without $lookup pipelines
  { collection: 'tasks', spec: { projectId: 1, statusName: 1, number: -1 } },
  { collection: 'tasks', spec: { projectId: 1, sprintName: 1, number: -1 } },
  // Audit #3: /tasks/my (`findAssignedTo`) filters by {assigneeId} alone and
  // sorts by {updatedAt} — the compound {projectId, assigneeId} index does not
  // apply (projectId is its prefix). Covers the cross-project "My Tasks"
  // query as an IXSCAN without a blocking SORT.
  { collection: 'tasks', spec: { assigneeId: 1, updatedAt: -1 } },
  // Label filter queries (`labelIds` array) — multikey index
  { collection: 'tasks', spec: { projectId: 1, labelIds: 1 } },
  // Capacity experiment 2026-08-31: title sort (task-table) — covers
  // {projectId} + sort {title} without a blocking SORT at 1k-10k tasks/project
  { collection: 'tasks', spec: { projectId: 1, title: 1 } },
  // Capacity experiment 2026-08-31: statusId filter + updatedAt sort
  // (task-table status filter + updatedAt:desc) — covers filter+sort in one
  // IXSCAN instead of IXSCAN + blocking SORT over all matching tasks
  { collection: 'tasks', spec: { projectId: 1, statusId: 1, updatedAt: -1 } },
  // MongoDB query-plan audit 2026-09-02: the repository appends `number: -1`
  // as the pagination tiebreaker to every sort (task.repository findByProject).
  // A sort of {createdAt: -1, number: -1} can NOT use {projectId, createdAt: -1}
  // (the trailing key must also be in the index), so the planner fell back to
  // IXSCAN on {projectId, number: -1} + a blocking SORT over the ENTIRE
  // matching set — proven by explain("executionStats") A/B. These four
  // indexes restore IXSCAN-only plans (keysExamined ≈ nReturned) for the
  // createdAt/updatedAt/title sort paths and the statusId-filtered
  // updatedAt sort.
  { collection: 'tasks', spec: { projectId: 1, createdAt: -1, number: -1 } },
  { collection: 'tasks', spec: { projectId: 1, updatedAt: -1, number: -1 } },
  { collection: 'tasks', spec: { projectId: 1, title: 1, number: -1 } },
  { collection: 'tasks', spec: { projectId: 1, statusId: 1, updatedAt: -1, number: -1 } },
  // Jira-like workload audit 2026-09-02: plain-field task-table sorts
  // (priority/assigneeId/reporterId/typeId) were blocking SORTs over the whole
  // matching set (measured ~108ms @5k tasks, ~216ms @10k, linear in project
  // size). These indexes use an ALIGNED `number` tiebreaker so ONE index per
  // field serves both sort directions via reverse traversal — findByProject
  // flips the tiebreaker to `number: sortDir` for exactly these fields.
  // Contract note: for ASC the order WITHIN groups of equal field values
  // changes (number ASC instead of number DESC); `number` stays unique per
  // project, so overall ordering remains deterministic. See §4.20.
  { collection: 'tasks', spec: { projectId: 1, priorityLevel: 1, number: 1 } },
  // Board column pages (Stage 4): per-column keyset pagination — equality on
  // {projectId, statusId} ($in per column) + mixed sort {priorityLevel: -1,
  // number: 1}. The existing {projectId, priorityLevel, number} index cannot
  // serve the mixed DESC/ASC sort (proven blocking SORT at every scale —
  // see product-analysis/100 §4.23). Additive: existing indexes stay.
  { collection: 'tasks', spec: { projectId: 1, statusId: 1, priorityLevel: -1, number: 1 } },
  { collection: 'tasks', spec: { projectId: 1, assigneeId: 1, number: 1 } },
  { collection: 'tasks', spec: { projectId: 1, reporterId: 1, number: 1 } },
  { collection: 'tasks', spec: { projectId: 1, typeId: 1, number: 1 } },
  // `countByType` is a countDocuments on {projectId, typeId}.
  // The {projectId, typeId, number} index above carries a third key, so the
  // count has to walk the `number` tail and re-check typeId for every key.
  { collection: 'tasks', spec: { projectId: 1, typeId: 1 } },
  // comments
  { collection: 'comments', spec: { taskId: 1 } },
  // The thread read filters {taskId} and sorts
  // {createdAt: -1, _id: -1} (the keyset window `findPageByTask` walks
  // newest-first). Sorting by a field that is not in ANY index forces a
  // blocking SORT over the whole matching set — measured SORT>FETCH>IXSCAN.
  // Compound {taskId, createdAt} removes the SORT stage entirely, and the
  // DESCENDING window needs no second index: an index is an ordered structure,
  // so the planner traverses this one backwards. The `_id` term of the sort is
  // the index's implicit record-id tiebreaker, which is why it is not a key
  // here — the same reason the audit list's `{createdAt, _id}` sort is served by
  // an index ending at `createdAt`.
  { collection: 'comments', spec: { taskId: 1, createdAt: 1 } },
  // `comments` was the only entity collection with no
  // `{id: 1}` index at all, so `findOneAndUpdate({id})` (comment edit) and
  // `deleteOne({id})` (BaseRepository.delete) were COLLSCANs over the whole
  // collection. `id` is a randomUUID, so uniqueness is free to assert.
  { collection: 'comments', spec: { id: 1 }, options: { unique: true } },
  // task_relationships
  { collection: 'task_relationships', spec: { projectId: 1 } },
  { collection: 'task_relationships', spec: { sourceTaskId: 1 } },
  { collection: 'task_relationships', spec: { targetTaskId: 1 } },
  // `create()` runs a `findBySourceAndTarget` pre-check and
  // then `insertOne` — a textbook check-then-act race that lets two concurrent
  // requests both pass the check and both insert a duplicate `blocks` edge.
  // The unique index is the only fix that closes the window (the same reasoning
  // that produced the `users.email` unique index). Duplicate-safe: see
  // `requiresDuplicateFreeData` + the `duplicate key` analysis in F11.
  {
    collection: 'task_relationships',
    spec: { projectId: 1, sourceTaskId: 1, targetTaskId: 1 },
    options: { unique: true },
    requiresDuplicateFreeData: true,
  },
  // task_relationships was also the only entity collection
  // with no `{id: 1}` index. `id` is a randomUUID → duplicate-free in practice,
  // but the probe still runs so the build can never abort a production deploy.
  { collection: 'task_relationships', spec: { id: 1 }, options: { unique: true }, requiresDuplicateFreeData: true },
  // ── The scheduled purge's selection query, on BOTH entity kinds.
  // `{ status: <equality>, deletionScheduledAt: <range> }` — the exact shape a
  // compound index exists for. Without these the once-a-day purge is a COLLSCAN
  // of `projects`/`tenants`, both of which grow with the product. The owner
  // approved index changes in this tree; these are two of them, and they are the
  // only new B-tree indexes this package adds (the third new index is the
  // time-to-live one below, which is a retention mechanism, not a query index).
  { collection: 'projects', spec: { status: 1, deletionScheduledAt: 1 } },
  { collection: 'tenants', spec: { status: 1, deletionScheduledAt: 1 } },
  // audit_events — every audit index that SERVES A SORT ends in
  // `createdAt` + `_id`. `createdAt` is a wall-clock millisecond
  // and two events can carry the same one, so sorting on it alone is not a total
  // order: with `.skip()/.limit()` paging the server may order a tied group
  // differently on two consecutive pages, so an event can be shown twice or not
  // at all. `_id` is unique, so `(createdAt, _id)` is. Both fields are in the
  // index, so the sort stays index-served instead of becoming a blocking SORT
  // over the whole matched range (`audit_events` is append-only and unbounded).
  // The `_id` suffix is ALIGNED with the `createdAt` direction for the same
  // reason `task.repository.ts` aligns its `number` tiebreaker: one index then
  // serves BOTH directions by reverse traversal, since the leading fields are
  // pinned by equality. The superseded `{…, createdAt}`-only indexes are
  // dropped by {@link dropSupersededIndexes}.
  { collection: 'audit_events', spec: { tenantId: 1, createdAt: -1, _id: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, createdAt: -1, _id: -1 } },
  // Entity/action drill-down filters on the audit log
  { collection: 'audit_events', spec: { projectId: 1, entityType: 1, createdAt: -1, _id: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, action: 1, createdAt: -1, _id: -1 } },
  // The `actorId` audit filter is a first-class, user-facing
  // drill-down and no index contained `actor.userId`, so the planner used
  // {projectId, createdAt} and read the project's ENTIRE audit range to filter
  // in FETCH — measured 31,220 keys / 31,220 docs / 160 ms, growing without
  // bound because audit_events is append-only. → 20 / 20 / 0 ms.
  { collection: 'audit_events', spec: { projectId: 1, 'actor.userId': 1, createdAt: -1, _id: -1 } },
  // The `entityId` drill-down — same shape as the actorId filter above and
  // the same prefix-only coverage (only {projectId, entityType|action, createdAt}
  // existed, neither of which contains entityId).
  { collection: 'audit_events', spec: { projectId: 1, entityId: 1, createdAt: -1, _id: -1 } },
  // The tenant-wide audit view filters {tenantId, projectId} and sorts by
  // createdAt. `projectId` is NOT the prefix of {tenantId, createdAt}, so the
  // query scanned all 330k tenant-level events to re-check projectId per
  // document — measured 330,000 docs / 720 ms → 20 / 20 / 1 ms.
  { collection: 'audit_events', spec: { tenantId: 1, projectId: 1, createdAt: -1, _id: -1 } },
  // ── The RETENTION WINDOW. ───────────────────────────────────────────────────
  //
  // THE ANSWER TO "how long must audit records be kept": a fixed window,
  // enforced by a time-to-live index on `createdAt`, so an event expires
  // AUDIT_RETENTION_DAYS after it was written. This is the only mechanism that
  // removes an audit row — no service, route or purge deletes one (the project
  // purge used to `deleteMany` the whole project's history, including the record
  // of who purged it; that call is gone).
  //
  // What "append-only" now means, precisely, at all three sites that used to
  // claim it: the log is append-only in NORMAL OPERATION — nothing in the
  // application updates or deletes a row — and rows leave only on this clock.
  //
  // WHAT THIS DOES NOT PROMISE, stated where a reader of the audit log will find
  // it: time-to-live deletion is NOT instantaneous. MongoDB's TTL monitor sweeps
  // roughly once a minute, so "the retention window has passed" and "the row is
  // gone" are two different statements, and the gap between them is up to about a
  // minute. It is also not a transaction: nothing waits for it, nothing reports
  // it, and a row inside the window is not guaranteed to survive to the instant
  // the window closes if the database is unavailable when the monitor runs. The
  // window is a BOUND on how long a record is kept, not a guarantee that it is
  // kept until it.
  //
  // The user-facing consequence: the audit viewer shows at most the last
  // AUDIT_RETENTION_DAYS of history for a workspace, and older events are removed
  // by the database rather than by the application. An auditor who needs a longer
  // window needs it exported BEFORE the window closes — there is no "show me the
  // deleted events" path, by design.
  //
  // Cost: one more index on a write-heavy collection (every event insert updates
  // it), and it is a single-field index on `createdAt` — deliberately NOT one of
  // the compound sort indexes above, because a TTL index must be a single field
  // to be honoured.
  { collection: 'audit_events', spec: { createdAt: 1 }, options: { expireAfterSeconds: AUDIT_RETENTION_SECONDS } },
  // rate_limit_counters — the retention of the rate-limit AUTHORITY
  // (`services/rate-limit-authority.service.ts`). Every probe sets `expiresAt` to
  // the end of its own window plus a grace period, and this index is what turns
  // that date into an actual deletion: without it the collection grows one
  // document per distinct address and per distinct email forever, and a spray of
  // identities is exactly the traffic that produces the most of them.
  //
  // This index is therefore the ONLY thing bounding the collection, and what it
  // bounds is TIME, not count: a document lives one window plus the grace after
  // its last write, so the live set is the scopes probed inside the current
  // window and the rest is swept by the database. There is deliberately no
  // document-count cap and no eviction — a shared ceiling across all scopes is a
  // quantity an attacker can fill with cheap minted scopes and then starve
  // legitimate ones behind, and the sized worst case is computed in
  // `docs/architecture.md` §2.7 instead.
  //
  // Single-field for the same reason as the audit index above: a TTL index must
  // be a single field or the server silently ignores it and the collection is
  // never swept. The sweep is a background task of the database, so it costs no
  // Worker request either.
  { collection: 'rate_limit_counters', spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  // filters
  { collection: 'filters', spec: { userId: 1, projectId: 1 } },
  // `findByUserProjectAndName` pre-checks then inserts, and
  // `name` was not in any index — two rapid "save filter" calls with the same
  // name both passed the check and produced a duplicate the user then sees
  // twice. Cosmetic rather than corrupting, but the same check-then-act race
  // and the same fix. Duplicate-safe: see `requiresDuplicateFreeData`.
  {
    collection: 'filters',
    spec: { userId: 1, projectId: 1, name: 1 },
    options: { unique: true },
    requiresDuplicateFreeData: true,
  },
  // labels
  { collection: 'labels', spec: { projectId: 1 } },
  // `findByProject` filters {projectId} and sorts
  // {name: 1} — a blocking SORT (SORT>FETCH>IXSCAN) on a collection that has
  // only {projectId}.
  { collection: 'labels', spec: { projectId: 1, name: 1 } },
  // statuses
  { collection: 'statuses', spec: { id: 1 }, options: { unique: true } },
  { collection: 'statuses', spec: { projectId: 1, normalizedName: 1 }, options: { unique: true } },
  // Board columns are ordered by {position} — same
  // blocking-SORT shape as `labels` above.
  { collection: 'statuses', spec: { projectId: 1, position: 1 } },
  // task_types
  { collection: 'task_types', spec: { id: 1 }, options: { unique: true } },
  { collection: 'task_types', spec: { projectId: 1, key: 1 }, options: { unique: true } },
  // Task types are ordered by {position} — same
  // blocking-SORT shape as `statuses` / `labels`.
  { collection: 'task_types', spec: { projectId: 1, position: 1 } },
  // boards — single-board model (102 proposal): projectId is the natural
  // unique key; there is no separate board id anymore.
  { collection: 'boards', spec: { projectId: 1 }, options: { unique: true } },
  // sprints
  { collection: 'sprints', spec: { id: 1 }, options: { unique: true } },
  { collection: 'sprints', spec: { projectId: 1, status: 1 } },
  // The sprint dropdown is ordered newest-first by
  // {createdAt: -1} — same blocking-SORT shape as `statuses` / `labels` /
  // `task_types`.
  { collection: 'sprints', spec: { projectId: 1, createdAt: -1 } },
  // user_preferences / user_settings
  { collection: 'user_preferences', spec: { userId: 1, projectId: 1 }, options: { unique: true } },
  { collection: 'user_settings', spec: { userId: 1 }, options: { unique: true } },
];

/**
 * Does the collection currently contain duplicate values for `spec`?
 *
 * Used as the PRE-CHECK for the unique indexes added in F11. `createIndex` with
 * `unique: true` aborts the whole build (`DuplicateKey`, code 11000) the moment
 * it encounters a pre-existing duplicate — and this migration runs from CD
 * against a database the OLD Worker is still serving, so an unhandled build
 * failure would abort the deploy. Probing first turns that into a decision the
 * migration can report and skip.
 *
 * Implemented as a `$group`/`$match` aggregation with a `$limit` so only a few
 * offending groups are ever materialised in the Worker's heap. An aggregation on
 * a namespace that was never created yields an empty cursor (no `NamespaceNotFound`
 * — unlike `listIndexes`), so a fresh database reports "no duplicates" and the
 * index is created, which is exactly what a fresh environment wants.
 *
 * The B-tree spec CANNOT be reused as the `$group._id` verbatim. An object of
 * `1`/`-1` is an inclusion-style projection, and `$group` rejects a projection
 * as its `_id` with `$group does not support inclusion-style expressions`
 * (code 17390) — a server-side failure, so it cannot be caught by reading the
 * docs. Every probe-guarded index died that way: the probe threw before
 * `createIndex` was ever called, and the run reported a failed index build
 * whose definition was in fact valid. Grouping is done by a document of
 * resolved field values instead (see {@link duplicateGroupId}).
 */
export async function hasDuplicatesFor(
  collection: { aggregate(pipeline: Document[]): { toArray(): Promise<unknown[]> } },
  spec: Record<string, 1 | -1>,
): Promise<{ duplicate: boolean; sample: unknown[] }> {
  const groups = await collection
    .aggregate([
      { $group: { _id: duplicateGroupId(spec), count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();

  return { duplicate: groups.length > 0, sample: groups };
}

/**
 * The `$group._id` that groups documents by exactly the key `spec` indexes on.
 *
 * Sort direction is deliberately dropped: a duplicate is a property of the key's
 * VALUES, so `{a: 1, b: -1}` and `{a: -1, b: 1}` describe the same duplicate
 * set, and the direction only decides scan order. Keys are positional (`k0`,
 * `k1`, …) rather than the field names because `$group` rejects a `_id` document
 * KEY containing a dot (code 16412), which this repository's nested keys
 * (`actor.userId`, `passwordReset.tokenHash`) would all trip.
 *
 * A nested key is resolved by folding `$getField` from `$$ROOT` along the path.
 * Both shorter spellings were measured against the server and rejected:
 *   - `"$" + field` — rejected outright on a dotted path (code 16412);
 *   - one flat `$getField` on a dotted path — accepted, but returns `null` for
 *     EVERY document instead of traversing, so a clean collection reads as
 *     "all duplicates" and a valid unique index would be skipped for the wrong
 *     reason. A silent wrong answer is worse than the loud failure it replaces.
 *
 * A field that is absent or `null` resolves to `null`, matching how a unique
 * index treats a missing key, so the probe's verdict agrees with whether the
 * real `createIndex({unique: true})` would actually fail.
 */
function duplicateGroupId(spec: Record<string, 1 | -1>): Document {
  return Object.fromEntries(Object.keys(spec).map((field, position) => [`k${position}`, resolveFieldPath(field)]));
}

/** `a.b.c` → `$getField('c', $getField('b', $getField('a', $$ROOT)))`. */
function resolveFieldPath(field: string): Document {
  // Seeded with the BARE `$$ROOT` field reference (a raw string in an
  // expression position), never `{ $literal: '$$ROOT' }` — that would be the
  // 3-character STRING "$$ROOT" and every segment would resolve to null.
  return field
    .split('.')
    .reduce<unknown>((input, segment) => ({ $getField: { field: segment, input } }), '$$ROOT') as Document;
}

/**
 * Create all core indexes (idempotent — `createIndex` is a no-op for an
 * existing identical index).
 *
 * EVERY index is still ATTEMPTED (a failure on one must not hide the state of
 * the others), but a failure is no longer swallowed: {@link ensureCoreIndexes}
 * rejects, `runMigrations` propagates, and `scripts/migrate.ts` exits non-zero
 * so the CD job fails BEFORE the Worker deploy.an index that
 * failed to build is a data-integrity constraint that exists only in the source
 * tree, and the log line that said otherwise was the only evidence anyone had.
 *
 * Duplicate-safe unique indexes. Three of the F11 indexes are `unique`
 * over a key the application used to enforce with a check-then-act pre-check
 * (`filters` by name, `task_relationships` by edge, plus the missing `{id}`
 * indexes on `comments` / `task_relationships`). A `unique` build over existing
 * duplicates FAILS, so those carry `requiresDuplicateFreeData` and are probed
 * first:
 *
 *   - no duplicates  → index is created (the constraint now closes the race);
 *   - duplicates     → the index is SKIPPED and the offending groups are
 *                      reported via `log.error`. Nothing is deleted and nothing
 *                      is thrown: the duplicate rows stay readable, the
 *                      migration continues, and the deploy is not blocked. The
 *                      operator decides whether to dedupe by hand and re-run.
 *
 * That is the ONE documented skip, and it is a decision the migration can make
 * because it is a decision it already probed for. An UNGUARDED build failure is
 * a different thing: nothing was probed, nothing was reported, and the index
 * simply does not exist afterwards.
 *
 * `comments {id: 1}` is deliberately NOT probe-guarded: `id` is a
 * `randomUUID()` produced at insert time, and a collision would mean two
 * comments genuinely share an identity — the build SHOULD fail loudly there
 * rather than silently skip a real data-integrity problem. (The
 * `task_relationships {id: 1}` twin IS probe-guarded, for symmetry with the
 * relationship table it lives on.)
 */
export async function ensureCoreIndexes(db: Db): Promise<void> {
  // `allSettled`, not `all`: every index must be ATTEMPTED so one broken entry
  // cannot mask the state of the rest, and the run must still fail. `Promise.all`
  // would report only the first rejection and leave the operator guessing.
  const results = await Promise.allSettled(
    CORE_INDEXES.map(async ({ collection, spec, options, requiresDuplicateFreeData }) => {
      const target = db.collection(collection);

      if (requiresDuplicateFreeData) {
        const { duplicate, sample } = await hasDuplicatesFor(target, spec);

        if (duplicate) {
          log.error('Skipped unique index — pre-existing duplicates found', { collection, spec, sample });

          return;
        }
      }

      await target.createIndex(spec, options);
    }),
  );
  const failed = results.filter((result) => result.status === 'rejected');

  for (const result of failed) {
    const reason: unknown = (result as PromiseRejectedResult).reason;

    log.error('Failed to create index', { err: reason });
  }

  if (failed.length > 0) {
    // The message names the COUNT and the FIRST reason, never a swallowed
    // error: `scripts/migrate.ts` turns this throw into a non-zero exit.
    throw new Error(
      `ensureCoreIndexes: ${failed.length} of ${CORE_INDEXES.length} index build(s) failed — the first was: ` +
        `${failed[0]?.status === 'rejected' ? String((failed[0] as PromiseRejectedResult).reason) : 'unknown'}`,
    );
  }

  await dropSupersededIndexes(db);
}

/**
 * The auto-generated index name MongoDB assigns to a key spec:
 * `key_direction` joined with `_`, e.g. `{projectId: 1, createdAt: -1}` →
 * `projectId_1_createdAt_-1`. Dots are preserved, which is why
 * `{'actor.userId': 1}` is `actor.userId_1`.
 */
export function indexNameFor(spec: Record<string, 1 | -1>): string {
  return Object.entries(spec)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

/**
 * Indexes a LATER entry in {@link CORE_INDEXES} has replaced: the audit sort
 * indexes grew a `_id` tiebreaker because `createdAt` alone is not
 * a total order.
 *
 * They are dropped, not merely replaced, because `audit_events` is write-heavy
 * (append-only in NORMAL OPERATION — nothing in the application updates or
 * deletes a row; rows leave only on the retention TTL): keeping both sets
 * would double the per-insert index cost of
 * the collection to serve a query that the old shape already served worse.
 * Dropping is safe only AFTER the replacement exists, which is why this runs at
 * the end of {@link ensureCoreIndexes} — an index build that failed rejects
 * before reaching it. Idempotent: a name that is already gone throws
 * `IndexNotFound`, which is the expected steady state.
 */
export const SUPERSEDED_INDEXES: { collection: string; spec: Record<string, 1 | -1> }[] = [
  { collection: 'audit_events', spec: { tenantId: 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, entityType: 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, action: 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, 'actor.userId': 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { projectId: 1, entityId: 1, createdAt: -1 } },
  { collection: 'audit_events', spec: { tenantId: 1, projectId: 1, createdAt: -1 } },
];

export async function dropSupersededIndexes(db: Db): Promise<void> {
  for (const { collection, spec } of SUPERSEDED_INDEXES) {
    try {
      await db.collection(collection).dropIndex(indexNameFor(spec));
      log.info('Dropped superseded index', { collection, spec });
    } catch {
      // Never built, or already dropped — the steady state of a re-run.
    }
  }
}

// ─── Single-Board Migration (102 proposal) ───────────────────────────────────

interface LegacyBoardDocument {
  _id: import('mongodb').ObjectId;
  id?: string;
  projectId: string;
  name?: string;
  type?: string;
  columns?: { id?: string; statusIds: string[]; position: number }[];
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Guarantee exactly one board per project, keyed by `projectId`, and strip the
 * dead multi-board fields. Idempotent — an already-conformed database is a
 * no-op. MUST run before the unique `{projectId:1}` index is created (it
 * removes the duplicates the index would reject).
 *
 * 1. Dedupe: when a project has >1 board, keep the one referenced by the
 *    project's `defaultBoardId` (fallback: the oldest by createdAt) and delete
 *    the rest.
 * 2. Normalize the survivor to `{projectId, columns, createdAt, updatedAt}` —
 *    drop `id`/`name`/`type`.
 * 3. `$unset` the dead `projects.defaultBoardId` and
 *    `user_preferences.defaultBoardId` fields.
 * 4. Drop the obsolete `{id:1}` unique index (superseded by `{projectId:1}`).
 */
export async function migrateToSingleBoardPerProject(db: Db): Promise<void> {
  const boards = db.collection<LegacyBoardDocument>('boards');
  const projects = db.collection('projects');
  const prefs = db.collection('user_preferences');
  const now = new Date();

  // ── 4 — obsolete legacy index MUST be dropped FIRST: the unique {id:1}
  // index rejects the second normalized doc (id: null) once a project's
  // boards are being stripped of their legacy `id` field.
  try {
    await boards.dropIndex('id_1');
  } catch {
    // Already dropped (or never created) — nothing to do.
  }

  // Also drop the legacy NON-unique {projectId:1} index: it occupies the
  // auto-generated name `projectId_1`, which would collide with the UNIQUE
  // index created by ensureCoreIndexes below.
  const indexes = await listIndexesSafely(boards);
  const legacyProjectIdIndex = indexes.find((index) => index.name === 'projectId_1' && !index.unique);

  if (legacyProjectIdIndex) {
    await boards.dropIndex('projectId_1');
  }

  // ── 1+2 — one normalized board per project ────────────────────────────────
  const legacy = await boards.find({}).toArray();
  const byProject = new Map<string, LegacyBoardDocument[]>();

  for (const board of legacy) {
    const list = byProject.get(board.projectId) ?? [];

    list.push(board);
    byProject.set(board.projectId, list);
  }

  for (const [projectId, list] of byProject) {
    const project = await projects.findOne({ id: projectId }, { projection: { defaultBoardId: 1 } });
    const preferredId: string | undefined = project?.defaultBoardId;
    let survivor = preferredId ? list.find((b) => b.id === preferredId) : undefined;

    if (!survivor) {
      survivor = [...list].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))[0];
    }

    const doomed = list.filter((b) => b !== survivor);

    if (doomed.length > 0) {
      await boards.deleteMany({ _id: { $in: doomed.map((b) => b._id) } });
      log.warn('single-board: dropped extra board(s) for project', { projectId, count: doomed.length });
    }

    if (survivor) {
      await boards.updateOne(
        { _id: survivor._id },
        {
          $set: {
            projectId,
            columns: survivor.columns ?? [],
            createdAt: survivor.createdAt ?? now,
            updatedAt: survivor.updatedAt ?? now,
          },
          $unset: { id: '', name: '', type: '' },
        },
      );
    }
  }

  const projectIds = await projects.find({}, { projection: { id: 1 } }).toArray();
  const withoutBoard = projectIds.filter((p) => !byProject.has(p.id));

  if (withoutBoard.length > 0) {
    // Should never happen (the seed always creates a board) — surface it, the
    // board endpoint will 404 for these projects until they are reseeded.
    log.warn('single-board: projects without any board', { count: withoutBoard.length });
  }

  // ── 3 — dead per-project/per-user default-board references ────────────────
  const projectUnset = await projects.updateMany(
    { defaultBoardId: { $exists: true } },
    { $unset: { defaultBoardId: '' } },
  );
  const prefUnset = await prefs.updateMany({ defaultBoardId: { $exists: true } }, { $unset: { defaultBoardId: '' } });

  if (projectUnset.modifiedCount > 0 || prefUnset.modifiedCount > 0) {
    log.info('single-board: unset defaultBoardId fields', {
      projects: projectUnset.modifiedCount,
      preferences: prefUnset.modifiedCount,
    });
  }
}

/**
 * Idempotent data migrations, executed by `server/scripts/migrate.ts` (from
 * CD before the Worker deploy, or locally) — NEVER in the Worker request
 * path. The slug backfill and the unique slug index are a single step
 * — splitting them left a window where a concurrent run could insert a
 * duplicate slug in between.
 */
/**
 * Backfill the denormalized task.statusName / task.sprintName sort
 * fields from the authoritative statuses / sprints collections.
 *
 * Idempotent: only documents whose stored name differs from (or is missing
 * from) the source entity are touched; a conformed database yields
 * modifiedCount 0. Orphaned statusId/sprintId values (entity deleted without
 * a replacement) get `null`, matching the runtime contract.
 */
export async function backfillTaskSortNames(db: Db): Promise<number> {
  const tasks = db.collection('tasks');
  let modified = 0;

  for (const [entityCollection, idKey, nameKey] of [
    ['statuses', 'statusId', 'statusName'],
    ['sprints', 'sprintId', 'sprintName'],
  ] as const) {
    const entities = await db.collection(entityCollection).find({}).toArray();
    const knownIds = new Set(entities.map((entity) => entity.id));

    for (const entity of entities) {
      const result = await tasks.updateMany(
        { [idKey]: entity.id, [nameKey]: { $ne: entity.name } },
        { $set: { [nameKey]: entity.name } },
      );

      modified += result.modifiedCount;
    }

    // Orphans (entity gone): normalize a missing field to null.
    const orphans = await tasks.updateMany(
      { [idKey]: { $nin: [...knownIds] }, [nameKey]: { $exists: true, $ne: null } },
      { $set: { [nameKey]: null } },
    );

    modified += orphans.modifiedCount;
  }

  return modified;
}

/**
 * Backfill the plain-text search projection on tasks that predate it.
 *
 * **Why a backfill at all, rather than matching the Markdown until one is written.**
 * The projection is derived on every save, so without this a task saved before
 * this change carries no `descriptionText` and its description stops being
 * searchable — search would silently lose history. The alternative (searching the
 * Markdown until each task is next edited) needs a permanent dual-path search that
 * is wrong for every task nobody edits, which is most of them.
 *
 * **Additive and idempotent.**
 * - Additive: it only ever `$set`s a new field. Nothing is removed, renamed or
 *   retyped, so a rollback of the code leaves an unused field and nothing else.
 * - Idempotent: the filter is `descriptionText: { $exists: false }`, so a second
 *   run matches nothing and a re-run costs one indexed-ish scan. A document whose
 *   description is null/absent is not touched at all — there is no text to project,
 *   and writing `descriptionText: ''` would make "searchable by the empty string"
 *   a query someone can eventually issue.
 *
 * **Safe on a database that already holds data.** The work is done in bounded
 * batches with `bulkWrite` (`ordered: false`), and the read is a projection of
 * `_id` + `description` only — the migration never materialises a full task
 * document, and it holds at most {@link TASK_TEXT_BACKFILL_BATCH} of them at a
 * time. `maxTimeMS` is deliberately NOT set: a long-running background migration
 * that the server aborts mid-way is a worse outcome than one that takes its time,
 * and the operation is idempotent so a resumed run is free.
 *
 * @returns the number of documents the projection was written to.
 */
export async function backfillTaskDescriptionText(db: Db): Promise<number> {
  const tasks = db.collection('tasks');
  let written = 0;

  for (;;) {
    const pending = await tasks
      .find(
        { descriptionText: { $exists: false }, description: { $exists: true, $ne: null } },
        { projection: { _id: 1, description: 1 } },
      )
      .limit(TASK_TEXT_BACKFILL_BATCH)
      .toArray();

    if (pending.length === 0) {
      break;
    }

    const result = await tasks.bulkWrite(
      pending.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          // The SAME pure function the write path uses, so a backfilled task and a
          // freshly saved one are byte-identical.
          update: { $set: { descriptionText: toPlainText(doc.description as string | null) } },
        },
      })),
      { ordered: false },
    );

    written += result.modifiedCount;
  }

  return written;
}

export async function runMigrations(db: Db): Promise<void> {
  await migrateInvitedMembershipsToRevoked(db);
  await renameSeedStatusNames(db); // DR-1 — raw seed-status keys → display names
  await ensureTenantSlugIntegrity(db); // DEC-032 — backfill + unique index back-to-back
  await backfillMemberExpiresAt(db); // DEC-055 — expiresAt: null on legacy members
  await migrateToSingleBoardPerProject(db); // 102 — dedupe boards, strip dead fields (before the unique index)
  await backfillTaskSortNames(db); // TOP-2 — denormalized statusName/sprintName on legacy tasks
  await backfillTaskDescriptionText(db); // N-5 — plain-text search projection on legacy tasks
  await ensureCoreIndexes(db); // create every repository-documented index (idempotent)

  const priorityStats = await migrateTaskPriorityToLevel(db); // priority string → numeric priorityLevel (replaces the old index)

  if (priorityStats.tasksMigrated > 0 || priorityStats.filtersMigrated > 0) {
    log.info(
      `migrateTaskPriorityToLevel: legacy priority values migrated to priorityLevel — ${JSON.stringify(priorityStats)}`,
    );
  }
}

/** String → numeric level mapping for the 2026-09 priority model migration. */
const PRIORITY_LEVEL_BY_LEGACY: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface TaskPriorityMigrationStats {
  tasksTotal: number;
  legacyCounts: Record<string, number>;
  missing: number;
  unexpected: number;
  conflicts: number;
  tasksMigrated: number;
  filtersMigrated: number;
  oldFieldRemoved: number;
  oldIndexDropped: boolean;
}

/**
 * Priority model migration (2026-09): `priority: string` → `priorityLevel: number`
 * (position in TASK_PRIORITY_CONFIG; see shared/src/constants/priority.ts).
 *
 * Order of operations per the migration design:
 *   1. count + validate (missing / unexpected / both-fields conflicts STOP the run);
 *   2. backfill `priorityLevel` from the legacy string;
 *   3. verify nothing is left un-migrated;
 *   4. migrate saved-filter `criteria.priority` arrays the same way;
 *   5. `$unset` the legacy `priority` field only after a successful verify;
 *   6. drop the legacy `{projectId, priority, number}` index (replacement).
 *
 * Idempotent: on a migrated database every counter is 0 and the run is a no-op.
 * audit_events are deliberately NOT migrated (historical records).
 */
export async function migrateTaskPriorityToLevel(db: Db): Promise<TaskPriorityMigrationStats> {
  const tasks = db.collection('tasks');
  const tasksTotal = await tasks.countDocuments({});
  const legacyCounts: Record<string, number> = {};

  for (const legacy of Object.keys(PRIORITY_LEVEL_BY_LEGACY)) {
    legacyCounts[legacy] = await tasks.countDocuments({ priority: legacy });
  }

  const missing = await tasks.countDocuments({ priority: { $exists: false }, priorityLevel: { $exists: false } });
  const knownValues = Object.keys(PRIORITY_LEVEL_BY_LEGACY);
  const unexpected = await tasks.countDocuments({
    priority: { $exists: true, $nin: knownValues },
  });
  const conflicts = await tasks.countDocuments({ priority: { $exists: true }, priorityLevel: { $exists: true } });

  if (missing > 0 || unexpected > 0) {
    throw new Error(
      `migrateTaskPriorityToLevel: refusing to migrate — missing priority on ${missing} task(s), ` +
        `unexpected (non LOW/MEDIUM/HIGH/CRITICAL) priority on ${unexpected} task(s). ` +
        'Fix the data before running this migration.',
    );
  }

  // 2. Backfill (only where priorityLevel is not present yet — idempotent re-runs).
  let tasksMigrated = 0;

  for (const [legacy, level] of Object.entries(PRIORITY_LEVEL_BY_LEGACY)) {
    const res = await tasks.updateMany(
      { priority: legacy, priorityLevel: { $exists: false } },
      { $set: { priorityLevel: level } },
    );

    tasksMigrated += res.modifiedCount;
  }

  // 3. Verify — every document must carry priorityLevel at this point.
  const unmigrated = await tasks.countDocuments({ priorityLevel: { $exists: false } });

  if (unmigrated > 0) {
    throw new Error(
      `migrateTaskPriorityToLevel: verification failed — ${unmigrated} task(s) still without priorityLevel.`,
    );
  }

  // 4. Saved filters: criteria.priority: ["HIGH", ...] → criteria.priorityLevel: [2, ...].
  const filters = db.collection('filters');
  let filtersMigrated = 0;
  const staleFilters = await filters.find({ 'criteria.priority': { $exists: true, $ne: null } }).toArray();

  for (const filter of staleFilters) {
    const legacyArray = (filter.criteria as { priority?: unknown[] }).priority ?? [];
    const unexpectedValues = legacyArray.filter((v) => typeof v !== 'string' || !(v in PRIORITY_LEVEL_BY_LEGACY));

    if (unexpectedValues.length > 0) {
      throw new Error(
        `migrateTaskPriorityToLevel: saved filter ${filter.id ?? String(filter._id)} contains unexpected ` +
          `priority value(s): ${JSON.stringify(unexpectedValues)}. Fix the filter before migrating.`,
      );
    }

    const levels = legacyArray.map((v) => PRIORITY_LEVEL_BY_LEGACY[v as string]);

    await filters.updateOne(
      { _id: filter._id },
      {
        $set: { 'criteria.priorityLevel': levels },
        $unset: { 'criteria.priority': '' },
      },
    );
    filtersMigrated += 1;
  }

  // 5. Remove the legacy field only after successful backfill + verification.
  const oldFieldRemoved = (await tasks.updateMany({ priority: { $exists: true } }, { $unset: { priority: '' } }))
    .modifiedCount;
  // 6. Drop the replaced legacy index (the priorityLevel index is created by
  // ensureCoreIndexes, which runs immediately before this migration).
  let oldIndexDropped = false;

  try {
    await tasks.dropIndex('projectId_1_priority_1_number_1');
    oldIndexDropped = true;
  } catch {
    // Idempotent re-run (or index never existed) — nothing to drop.
  }

  return {
    tasksTotal,
    legacyCounts,
    missing,
    unexpected,
    conflicts,
    tasksMigrated,
    filtersMigrated,
    oldFieldRemoved,
    oldIndexDropped,
  };
}
