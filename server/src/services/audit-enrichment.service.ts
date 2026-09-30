/**
 * Audit-log enrichment: resolves entity ids into human-readable labels
 * so the UI never renders raw UUIDs.
 *
 * Batching contract: for a single page of events, each referenced collection is
 * queried AT MOST ONCE (one `$in` per repo) — never once per event. All bulk
 * lookups run in parallel via `Promise.all`.
 */
import type { AuditChange, AuditEvent } from '@task-board/shared';

/** Minimal bulk-lookup contract — satisfied by every repository's `findByIds`. */
export interface AuditLabelRepo<T> {
  findByIds(ids: string[]): Promise<T[]>;
}

/** Fallback label when an id cannot be resolved (deleted entity, bad reference). */
export const UNKNOWN_LABEL = 'Unknown';

interface TaskRef {
  id: string;
  number: number;
  projectId: string;
}
interface NamedRef {
  id: string;
  name: string;
}
interface ProjectRef {
  id: string;
  key: string;
  name: string;
}
interface UserRef {
  id: string;
  displayName: string;
  email: string;
}
interface CommentRef {
  id: string;
  taskId: string;
}
interface TenantMemberRef {
  id: string;
  userId: string;
}

/** Change fields whose values are single-entity references. */
const SINGLE_REF_FIELDS = new Set(['statusId', 'sprintId', 'assigneeId', 'reporterId', 'typeId', 'taskId']);
/** Change fields whose values are arrays of references. */
const ARRAY_REF_FIELDS = new Set(['labelIds']);

export interface AuditEnrichmentRepos {
  tasks: AuditLabelRepo<TaskRef>;
  sprints: AuditLabelRepo<NamedRef>;
  statuses: AuditLabelRepo<NamedRef>;
  labels: AuditLabelRepo<NamedRef>;
  taskTypes: AuditLabelRepo<NamedRef>;
  projects: AuditLabelRepo<ProjectRef>;
  users: AuditLabelRepo<UserRef>;
  comments: AuditLabelRepo<CommentRef>;
  tenants: AuditLabelRepo<NamedRef>;
  tenantMembers: AuditLabelRepo<TenantMemberRef>;
}

/** Id buckets collected per collection for one page — one `$in` query per bucket. */
interface AuditIdSets {
  tasks: Set<string>;
  sprints: Set<string>;
  statuses: Set<string>;
  labels: Set<string>;
  taskTypes: Set<string>;
  projects: Set<string>;
  users: Set<string>;
  comments: Set<string>;
  tenants: Set<string>;
  tenantMembers: Set<string>;
}

export class AuditEnrichmentService {
  constructor(private readonly repos: AuditEnrichmentRepos) {}

  /**
   * Enrich one page of audit events with `entityLabel` and per-change
   * `oldLabel`/`newLabel` pairs. Purely additive — raw values are preserved
   * under `rawOldValue`/`rawNewValue` whenever labels are attached.
   */
  async enrichEvents(events: AuditEvent[]): Promise<AuditEvent[]> {
    if (events.length === 0) return events;

    // ── 1. Collect ids per collection ────────────────────────────────────────
    const ids = {
      tasks: new Set<string>(),
      sprints: new Set<string>(),
      statuses: new Set<string>(),
      labels: new Set<string>(),
      taskTypes: new Set<string>(),
      projects: new Set<string>(),
      users: new Set<string>(),
      comments: new Set<string>(),
      tenants: new Set<string>(),
      tenantMembers: new Set<string>(),
    };

    for (const event of events) {
      this.collectEntityRef(event.entityType, event.entityId, ids);

      for (const change of event.changes ?? []) this.collectChangeRefs(change, ids);
    }

    // ── 2. Bulk fetch — V7-4: comments and tasks are fetched in earlier rounds
    // so their references (comment → task, task → project) can be folded into
    // the id sets BEFORE the remaining collections are batched. Without the
    // task → project hop, project ids only ever came from PROJECT-entity
    // events and TASK labels always fell back to the `TASK-` prefix.
    // Each collection is still queried at most once per page.
    const commentRows = await this.repos.comments.findByIds([...ids.comments]);

    for (const comment of commentRows) {
      if (comment.taskId) ids.tasks.add(comment.taskId);
    }

    const taskRows = await this.repos.tasks.findByIds([...ids.tasks]);

    for (const task of taskRows) {
      if (task.projectId) ids.projects.add(task.projectId);
    }

    // Single-board model (doc 102): BOARD audit events carry the projectId as
    // entityId, so board labels resolve through the projects lookup below —
    // there is no separate boards repo anymore.
    const [sprintRows, statusRows, labelRows, typeRows, projectRows, userRows, tenantRows, memberRows] =
      await Promise.all([
        this.repos.sprints.findByIds([...ids.sprints]),
        this.repos.statuses.findByIds([...ids.statuses]),
        this.repos.labels.findByIds([...ids.labels]),
        this.repos.taskTypes.findByIds([...ids.taskTypes]),
        this.repos.projects.findByIds([...ids.projects]),
        this.repos.users.findByIds([...ids.users]),
        this.repos.tenants.findByIds([...ids.tenants]),
        this.repos.tenantMembers.findByIds([...ids.tenantMembers]),
      ]);
    // ── 3. Build lookup maps ─────────────────────────────────────────────────
    const projectKeyById = new Map(projectRows.map((p) => [p.id, p.key]));
    const taskKeyById = new Map(
      taskRows.map((t) => [t.id, `${projectKeyById.get(t.projectId) ?? 'TASK'}-${t.number}`]),
    );
    const labelNameById = new Map(labelRows.map((l) => [l.id, l.name]));
    const maps = {
      taskKeyById,
      sprintNameById: new Map(sprintRows.map((s) => [s.id, s.name])),
      statusNameById: new Map(statusRows.map((s) => [s.id, s.name])),
      labelNameById,
      typeNameById: new Map(typeRows.map((t) => [t.id, t.name])),
      projectNameById: new Map(projectRows.map((p) => [p.id, p.name])),
      userNameById: new Map(userRows.map((u) => [u.id, u.displayName || u.email])),
      commentTaskById: new Map(commentRows.map((c) => [c.id, c.taskId])),
      tenantNameById: new Map(tenantRows.map((t) => [t.id, t.name])),
      memberUserById: new Map(memberRows.map((m) => [m.id, m.userId])),
    };
    const resolveSingle = (field: string, value: unknown): string | null => {
      if (typeof value !== 'string' || value === '') return null;

      if (field === 'statusId') return maps.statusNameById.get(value) ?? null;
      if (field === 'sprintId') return maps.sprintNameById.get(value) ?? null;
      if (field === 'typeId') return maps.typeNameById.get(value) ?? null;
      if (field === 'taskId') return maps.taskKeyById.get(value) ?? null;
      if (field === 'assigneeId' || field === 'reporterId') return maps.userNameById.get(value) ?? null;
      if (field === 'labelIds') return labelNameById.get(value) ?? null;

      return null;
    };

    // ── 4. Apply enrichment ──────────────────────────────────────────────────
    return events.map((event) => ({
      ...event,
      entityLabel: this.resolveEntityLabel(event.entityType, event.entityId, maps),
      changes: (event.changes ?? []).map((change) => this.enrichChange(change, resolveSingle)),
    }));
  }

  private collectEntityRef(entityType: string, entityId: string, ids: AuditIdSets): void {
    if (!entityId) return;

    if (entityType === 'TASK') ids.tasks.add(entityId);
    else if (entityType === 'SPRINT') ids.sprints.add(entityId);
    else if (entityType === 'STATUS') ids.statuses.add(entityId);
    else if (entityType === 'LABEL') ids.labels.add(entityId);
    else if (entityType === 'TASK_TYPE') ids.taskTypes.add(entityId);
    // Single-board model: the board is identified by its projectId.
    else if (entityType === 'BOARD') ids.projects.add(entityId);
    else if (entityType === 'PROJECT') ids.projects.add(entityId);
    else if (entityType === 'TENANT') ids.tenants.add(entityId);
    else if (entityType === 'MEMBERSHIP') ids.tenantMembers.add(entityId);
    else if (entityType === 'COMMENT') ids.comments.add(entityId);
  }

  private collectChangeRefs(change: AuditChange, ids: AuditIdSets): void {
    for (const value of [change.oldValue, change.newValue]) {
      if (SINGLE_REF_FIELDS.has(change.field) && typeof value === 'string' && value !== '') {
        if (change.field === 'statusId') ids.statuses.add(value);
        else if (change.field === 'sprintId') ids.sprints.add(value);
        else if (change.field === 'typeId') ids.taskTypes.add(value);
        else if (change.field === 'taskId') ids.tasks.add(value);
        else ids.users.add(value); // assigneeId | reporterId
      } else if (ARRAY_REF_FIELDS.has(change.field) && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item !== '') ids.labels.add(item);
        }
      }
    }
  }

  private resolveEntityLabel(
    entityType: string,
    entityId: string,
    maps: {
      taskKeyById: Map<string, string>;
      sprintNameById: Map<string, string>;
      statusNameById: Map<string, string>;
      labelNameById: Map<string, string>;
      typeNameById: Map<string, string>;
      projectNameById: Map<string, string>;
      userNameById: Map<string, string>;
      commentTaskById: Map<string, string>;
      tenantNameById: Map<string, string>;
      memberUserById: Map<string, string>;
    },
  ): string | null {
    if (entityType === 'TASK') return maps.taskKeyById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'SPRINT') return maps.sprintNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'STATUS') return maps.statusNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'LABEL') return maps.labelNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'TASK_TYPE') return maps.typeNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'BOARD') return maps.projectNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'PROJECT') return maps.projectNameById.get(entityId) ?? UNKNOWN_LABEL;
    if (entityType === 'TENANT') return maps.tenantNameById.get(entityId) ?? UNKNOWN_LABEL;

    if (entityType === 'MEMBERSHIP') {
      const userId = maps.memberUserById.get(entityId);

      return userId ? (maps.userNameById.get(userId) ?? UNKNOWN_LABEL) : UNKNOWN_LABEL;
    }

    if (entityType === 'COMMENT') {
      const taskId = maps.commentTaskById.get(entityId);

      return taskId ? `comment on ${maps.taskKeyById.get(taskId) ?? UNKNOWN_LABEL}` : UNKNOWN_LABEL;
    }

    // TASK_RELATIONSHIP and any future types have no cheap human label.
    return null;
  }

  private enrichChange(
    change: AuditChange,
    resolveSingle: (field: string, value: unknown) => string | null,
  ): AuditChange {
    const isArrayField = ARRAY_REF_FIELDS.has(change.field);

    if (!isArrayField && !SINGLE_REF_FIELDS.has(change.field)) return change;

    const oldLabel = isArrayField
      ? this.joinLabels(change.oldValue, (id) => resolveSingle('labelIds', id))
      : resolveSingle(change.field, change.oldValue);
    const newLabel = isArrayField
      ? this.joinLabels(change.newValue, (id) => resolveSingle('labelIds', id))
      : resolveSingle(change.field, change.newValue);

    if (oldLabel === null && newLabel === null) return change;

    return {
      ...change,
      oldLabel,
      newLabel,
      rawOldValue: change.oldValue,
      rawNewValue: change.newValue,
    };
  }

  /** Join an array of ids into a comma-separated label list (`labelIds` diffs). */
  private joinLabels(value: unknown, resolveOne: (id: unknown) => string | null): string | null {
    if (!Array.isArray(value)) return null;

    const parts = value.map((id) => resolveOne(id)).filter((label): label is string => label !== null);

    return parts.length > 0 ? parts.join(', ') : null;
  }
}
