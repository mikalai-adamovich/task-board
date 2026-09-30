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

export class FilterService {
  constructor(
    private readonly filterRepo: FilterRepository,
    private readonly projectRepo: FilterServiceProjectRepo,
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
