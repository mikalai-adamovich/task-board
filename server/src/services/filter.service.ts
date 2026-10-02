import type { Filter, CreateFilter, UpdateFilter, FilterCriteria, FilterSort } from '@task-board/shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { withConflictOnDuplicate } from '../db/duplicate-key.js';
import { FilterRepository } from '../repositories/filter.repository.js';
import {
  assertProjectInTenant,
  assertProjectWritableInTenant,
  requireCallerContext,
  type CallerContext,
} from './tenant-assert.js';

/**
 * Minimal project repository interface used to verify the project's tenant.
 *
 * This dependency is now REQUIRED. It used to be optional, which meant a
 * container that forgot to pass it silently disabled every tenant check.
 */
export interface FilterServiceProjectRepo {
  findById(id: string): Promise<{ tenantId: string } | null>;
}

/**
 * The repositories {@link validateFilterCriteriaRefs} reads through.
 *
 * The same minimum surface the task write path declares for its own references
 * (`validateCrossProjectRefs` in `task.service.ts`), for the same reason: the
 * check states the properties it needs rather than the collections behind them,
 * so it is one independently testable function and not a method reachable only
 * through a fully wired service.
 */
export interface FilterRefDeps {
  statusRepo: { findByIds(ids: string[]): Promise<{ id: string; projectId: string }[]> };
  taskTypeRepo: { findByIds(ids: string[]): Promise<{ id: string; projectId: string }[]> };
  sprintRepo: { findByIds(ids: string[]): Promise<{ id: string; projectId: string }[]> };
  /** Labels are checked by reading the PROJECT's labels, not the submitted ids. */
  labelRepo: { findByProject(projectId: string): Promise<{ id: string }[]> };
  /**
   * The people seam. An assignee or reporter is proved THROUGH their membership
   * of this project, never from the global users collection, so a filter can
   * never carry the id of someone the caller's project cannot already name.
   */
  projectMemberRepo: {
    findUserIdentityByProject(
      userId: string,
      projectId: string,
    ): Promise<{ userId: string; displayName: string } | null>;
  };
}

/**
 * Validate that every id a saved filter references belongs to `projectId`.
 *
 * A saved filter is a PERSISTED query, so an unchecked id is a stored reference
 * that outlives the request that created it: the filter kept a cross-project
 * status, sprint, label or user id, and every later reader of that filter — in
 * this tenant or, if the filter is ever shared or exported, another — replays
 * it. This is the same defect class the task write path closes, and the same
 * convention answers it: a reference that does not resolve inside the project is
 * a 404, never a 403 and never a 400, so an id belonging to another project or
 * another tenant is indistinguishable from one that does not exist. The message
 * names the id the caller supplied and nothing else — no entity name is read on
 * the way to refusing it.
 *
 * One batched `findByIds` per entity kind, all of them concurrent; a criteria
 * object carrying no ids costs no query at all, which is what a filter with only
 * a search box or a date range does.
 */
export async function validateFilterCriteriaRefs(
  deps: FilterRefDeps,
  projectId: string,
  filters: FilterCriteria,
): Promise<void> {
  const statusIds = unique(filters.statusIds);
  const typeIds = unique(filters.typeIds);
  const sprintIds = unique(filters.sprintIds);
  const labelIds = unique(filters.labelIds);
  const userIds = unique([...(filters.assigneeIds ?? []), ...(filters.reporterIds ?? [])]);
  const [statuses, taskTypes, sprints, labels, members] = await Promise.all([
    statusIds.length > 0 ? deps.statusRepo.findByIds(statusIds) : Promise.resolve([]),
    typeIds.length > 0 ? deps.taskTypeRepo.findByIds(typeIds) : Promise.resolve([]),
    sprintIds.length > 0 ? deps.sprintRepo.findByIds(sprintIds) : Promise.resolve([]),
    labelIds.length > 0 ? deps.labelRepo.findByProject(projectId) : Promise.resolve([]),
    // Membership is per user, so people are resolved one at a time rather than in
    // a batch; the list is already capped at MAX_IDS_PER_DOCUMENT by the schema.
    Promise.all(userIds.map((userId) => deps.projectMemberRepo.findUserIdentityByProject(userId, projectId))),
  ]);

  assertOwned(statuses, statusIds, projectId, 'Status');
  assertOwned(taskTypes, typeIds, projectId, 'Task type');
  assertOwned(sprints, sprintIds, projectId, 'Sprint');

  if (labelIds.length > 0) {
    const own = new Set(labels.map((label) => label.id));
    const foreign = labelIds.find((id) => !own.has(id));

    if (foreign !== undefined) {
      throw new NotFoundError(`Label ${foreign} not found in project ${projectId}`);
    }
  }

  const memberIds = new Set(members.flatMap((member) => (member === null ? [] : [member.userId])));
  const outsider = userIds.find((userId) => !memberIds.has(userId));

  if (outsider !== undefined) {
    throw new NotFoundError(`User ${outsider} is not a member of project ${projectId}`);
  }
}

function unique(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

/** Every id must resolve to a row whose `projectId` is this project. */
function assertOwned(rows: { id: string; projectId: string }[], ids: string[], projectId: string, label: string): void {
  if (ids.length === 0) return;

  const own = new Map(rows.map((row) => [row.id, row.projectId]));
  const foreign = ids.find((id) => own.get(id) !== projectId);

  if (foreign !== undefined) {
    throw new NotFoundError(`${label} ${foreign} not found in project ${projectId}`);
  }
}

export class FilterService {
  constructor(
    private readonly filterRepo: FilterRepository,
    private readonly projectRepo: FilterServiceProjectRepo,
    /**
     * REQUIRED, like `projectRepo`: the reference check below is the whole point
     * of a saved filter being project-scoped, and an optional seam would let a
     * container that forgot to wire it skip every check silently.
     */
    private readonly refDeps: FilterRefDeps,
  ) {}

  /**
   * The project must belong to the caller's tenant, otherwise 404 — never
   * 403, so a foreign project id is indistinguishable from a nonexistent one.
   * The caller context is REQUIRED; a missing one throws 401 (fail closed)
   * instead of skipping the assertion.
   *
   * @returns the resolved project so callers never need a second lookup.
   */
  private async assertProjectScope(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId } = requireCallerContext(context);

    return assertProjectInTenant(this.projectRepo, projectId, tenantId);
  }

  /**
   * The WRITE variant — a saved filter is a write to the project, so a
   * project scheduled for deletion refuses it exactly like every other
   * project-scoped write. Separate from the read scope above, which
   * `getFiltersByUserAndProject` still needs.
   */
  private async assertProjectWritableScope(projectId: string, context: CallerContext): Promise<{ tenantId: string }> {
    const { tenantId } = requireCallerContext(context);

    return assertProjectWritableInTenant(this.projectRepo, projectId, tenantId);
  }

  async getFiltersByUserAndProject(projectId: string, context: CallerContext): Promise<Filter[]> {
    await this.assertProjectScope(projectId, context);

    return this.filterRepo.findByUserAndProject(context.userId, projectId);
  }

  async createFilter(projectId: string, input: CreateFilter, context: CallerContext): Promise<Filter> {
    // The write path asserts the tenant exactly like the read path, plus
    // It also asserts the single server-owned write rule.
    await this.assertProjectWritableScope(projectId, context);

    // BEFORE the write, and on the same terms as a task write: every id the
    // filter references must resolve inside the project it is saved under. The
    // stored criteria are replayed as a query by whoever opens the filter later,
    // so an unvalidated id here is a cross-project reference kept in the
    // database rather than a bad request that stopped at the edge.
    await validateFilterCriteriaRefs(this.refDeps, projectId, input.filters);

    const existing = await this.filterRepo.findByUserProjectAndName(context.userId, projectId, input.name);

    if (existing) {
      throw new ConflictError('A filter with this name already exists for this project');
    }

    // Two concurrent "save filter" calls with the same name can both pass
    // the pre-check above; the unique `{userId,projectId,name}` index then
    // rejects the loser. That is the same domain conflict, so it must produce
    // the same 409 instead of a 500 from the raw driver error.
    return withConflictOnDuplicate(
      () =>
        this.filterRepo.create({
          projectId,
          userId: context.userId,
          name: input.name,
          filters: input.filters,
          sort: input.sort,
        }),
      () => new ConflictError('A filter with this name already exists for this project'),
    );
  }

  async updateFilter(filterId: string, input: UpdateFilter, context: CallerContext): Promise<Filter> {
    const { userId } = requireCallerContext(context);
    const filter = await this.filterRepo.findById(filterId);

    if (!filter) {
      throw new NotFoundError('Filter not found');
    }

    // Resolve-then-assert-then-act. The tenant assertion runs BEFORE the
    // ownership check, so a filter of another tenant is a 404 and never a 403
    // that would confirm it exists.
    await this.assertProjectWritableScope(filter.projectId, context);

    if (filter.userId !== userId) {
      throw new ForbiddenError('You can only edit your own filters');
    }

    // F22 (latent bug the flag exposed): `input` is a PATCH body, so omitted
    // fields are `undefined`. Forwarding it verbatim put every key into `$set`,
    // and BSON serialises `undefined` as `null` — so a PATCH that omitted a key
    // could null that column. Build the patch from defined keys only.
    // The same check on the PATCH, and for the same reason: replacing the stored
    // criteria with a set carrying a foreign id is exactly as durable as storing
    // one at create time. A PATCH that does not touch `filters` never reaches
    // here, so an edit of the name alone costs no query.
    if (input.filters !== undefined) {
      await validateFilterCriteriaRefs(this.refDeps, filter.projectId, input.filters);
    }

    const patch: { name?: string; filters?: FilterCriteria; sort?: FilterSort } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.filters !== undefined) patch.filters = input.filters;
    if (input.sort !== undefined) patch.sort = input.sort;

    const updated = await this.filterRepo.update(filterId, patch);

    if (!updated) {
      throw new NotFoundError('Filter not found');
    }

    return updated;
  }

  async deleteFilter(filterId: string, context: CallerContext): Promise<void> {
    const { userId } = requireCallerContext(context);
    const filter = await this.filterRepo.findById(filterId);

    if (!filter) {
      throw new NotFoundError('Filter not found');
    }

    await this.assertProjectWritableScope(filter.projectId, context);

    if (filter.userId !== userId) {
      throw new ForbiddenError('You can only delete your own filters');
    }

    await this.filterRepo.delete(filterId);
  }
}
