import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterService, validateFilterCriteriaRefs, type FilterRefDeps } from './filter.service.js';
import { FilterRepository } from '../repositories/filter.repository.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.js';
import type { CreateFilter, Filter } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockFilterRepo() {
  return {
    findByUserAndProject: vi.fn(),
    findByUserProjectAndName: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as FilterRepository;
}

function makeFilter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: 'filter-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'My Open Tasks',
    filters: { statusIds: ['status-1'] },
    sort: { field: 'createdAt', direction: 'desc' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Filter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/** The caller context is REQUIRED — a missing one must fail closed. */
const CTX = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };
const FOREIGN_CTX = { tenantId: 'tenant-OTHER', userId: 'user-1', userRole: 'MEMBER' };

describe('FilterService', () => {
  let filterRepo: ReturnType<typeof createMockFilterRepo>;
  let projectRepo: { findById: ReturnType<typeof vi.fn> };
  let refDeps: FilterRefDeps;
  let service: FilterService;

  beforeEach(() => {
    filterRepo = createMockFilterRepo();
    projectRepo = { findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }) };
    // Everything the caller references resolves INSIDE project-1 unless a test
    // says otherwise, so the existing assertions stay about their own subject.
    refDeps = {
      statusRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'status-1', projectId: 'project-1' }]) },
      taskTypeRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'type-1', projectId: 'project-1' }]) },
      sprintRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'sprint-1', projectId: 'project-1' }]) },
      labelRepo: { findByProject: vi.fn().mockResolvedValue([{ id: 'label-1' }]) },
      projectMemberRepo: {
        findUserIdentityByProject: vi.fn().mockResolvedValue({ userId: 'user-1', displayName: 'User One' }),
      },
    };
    service = new FilterService(filterRepo, projectRepo as never, refDeps);
  });

  describe('getFiltersByUserAndProject', () => {
    it('returns all filters for the user and project', async () => {
      const filters = [makeFilter(), makeFilter({ id: 'filter-2', name: 'Assigned to me' })];

      filterRepo.findByUserAndProject = vi.fn().mockResolvedValue(filters);

      const result = await service.getFiltersByUserAndProject('project-1', CTX);

      expect(result).toHaveLength(2);
      expect(filterRepo.findByUserAndProject).toHaveBeenCalledWith('user-1', 'project-1');
    });

    it('throws NOT_FOUND (not 403) when the project belongs to another tenant (M-02)', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.getFiltersByUserAndProject('project-1', CTX)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(filterRepo.findByUserAndProject).not.toHaveBeenCalled();
    });

    it('M-005: throws 401 when the caller context is missing (fail closed)', async () => {
      await expect(
        service.getFiltersByUserAndProject('project-1', { tenantId: '', userId: '', userRole: '' }),
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(filterRepo.findByUserAndProject).not.toHaveBeenCalled();
    });
  });

  describe('createFilter', () => {
    const input: CreateFilter = {
      name: 'My Open Tasks',
      filters: { statusIds: ['status-1'] },
      sort: { field: 'createdAt', direction: 'desc' },
    };

    it('creates a filter when the name is free', async () => {
      filterRepo.findByUserProjectAndName = vi.fn().mockResolvedValue(null);
      filterRepo.create = vi.fn().mockResolvedValue(makeFilter());

      const result = await service.createFilter('project-1', input, CTX);

      expect(result.name).toBe('My Open Tasks');
      expect(filterRepo.create).toHaveBeenCalledWith({
        projectId: 'project-1',
        userId: 'user-1',
        name: 'My Open Tasks',
        filters: { statusIds: ['status-1'] },
        sort: { field: 'createdAt', direction: 'desc' },
      });
    });

    it('throws ConflictError when a filter with the same name exists', async () => {
      filterRepo.findByUserProjectAndName = vi.fn().mockResolvedValue(makeFilter());

      await expect(service.createFilter('project-1', input, CTX)).rejects.toThrow(ConflictError);
      expect(filterRepo.create).not.toHaveBeenCalled();
    });

    it('M-005: the WRITE path now tenant-asserts too — a foreign project is 404', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.createFilter('project-1', input, CTX)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(filterRepo.create).not.toHaveBeenCalled();
    });

    it('M-005: a foreign tenant cannot create a filter in a project it does not own', async () => {
      await expect(service.createFilter('project-1', input, FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(filterRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('updateFilter', () => {
    const input = { name: 'Renamed Filter' };

    it('updates a filter owned by the caller', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
      filterRepo.update = vi.fn().mockResolvedValue(makeFilter({ name: 'Renamed Filter' }));

      const result = await service.updateFilter('filter-1', input, CTX);

      expect(result.name).toBe('Renamed Filter');
      expect(filterRepo.update).toHaveBeenCalledWith('filter-1', input);
    });

    it('throws NotFoundError when the filter does not exist', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.updateFilter('missing', input, CTX)).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when the filter belongs to another user', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter({ userId: 'someone-else' }));

      await expect(service.updateFilter('filter-1', input, CTX)).rejects.toThrow(ForbiddenError);
      expect(filterRepo.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the update returns null', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
      filterRepo.update = vi.fn().mockResolvedValue(null);

      await expect(service.updateFilter('filter-1', input, CTX)).rejects.toThrow(NotFoundError);
    });

    it('M-005: a filter in a foreign tenant is 404 — never a 403 that would confirm it exists', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.updateFilter('filter-1', input, CTX)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(filterRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteFilter', () => {
    it('deletes a filter owned by the caller', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
      filterRepo.delete = vi.fn().mockResolvedValue(undefined);

      await expect(service.deleteFilter('filter-1', CTX)).resolves.toBeUndefined();
      expect(filterRepo.delete).toHaveBeenCalledWith('filter-1');
    });

    it('throws NotFoundError when the filter does not exist', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.deleteFilter('missing', CTX)).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when the filter belongs to another user', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter({ userId: 'someone-else' }));

      await expect(service.deleteFilter('filter-1', CTX)).rejects.toThrow(ForbiddenError);
      expect(filterRepo.delete).not.toHaveBeenCalled();
    });

    it('M-005: a foreign tenant cannot delete a filter of another tenant', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());

      await expect(service.deleteFilter('filter-1', FOREIGN_CTX)).rejects.toMatchObject({ statusCode: 404 });
      expect(filterRepo.delete).not.toHaveBeenCalled();
    });

    it('M-005: throws 401 when the caller context is missing (fail closed)', async () => {
      filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());

      await expect(
        service.deleteFilter('filter-1', { tenantId: 'tenant-1', userId: '', userRole: '' }),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(filterRepo.delete).not.toHaveBeenCalled();
    });
  });
});

/**
 * A saved filter persists the ids its criteria name, so a reference that is not
 * checked at the write is a cross-project reference kept in the database and
 * replayed as a query by whoever opens the filter next.
 */
describe('validateFilterCriteriaRefs — stored ids belong to the filter’s own project', () => {
  function makeDeps(): FilterRefDeps {
    return {
      statusRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'status-1', projectId: 'project-1' }]) },
      taskTypeRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'type-1', projectId: 'project-1' }]) },
      sprintRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'sprint-1', projectId: 'project-1' }]) },
      labelRepo: { findByProject: vi.fn().mockResolvedValue([{ id: 'label-1' }]) },
      projectMemberRepo: {
        findUserIdentityByProject: vi.fn().mockResolvedValue({ userId: 'user-1', displayName: 'User One' }),
      },
    };
  }

  it('accepts ids that all resolve inside the project', async () => {
    const deps = makeDeps();

    await expect(
      validateFilterCriteriaRefs(deps, 'project-1', {
        statusIds: ['status-1'],
        typeIds: ['type-1'],
        sprintIds: ['sprint-1'],
        labelIds: ['label-1'],
        assigneeIds: ['user-1'],
        reporterIds: ['user-1'],
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a status that belongs to ANOTHER project — 404, not 403', async () => {
    const deps = makeDeps();

    deps.statusRepo.findByIds = vi.fn().mockResolvedValue([{ id: 'status-foreign', projectId: 'project-2' }]);

    await expect(
      validateFilterCriteriaRefs(deps, 'project-1', { statusIds: ['status-foreign'] }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('refuses an id that does not exist anywhere', async () => {
    const deps = makeDeps();

    deps.sprintRepo.findByIds = vi.fn().mockResolvedValue([]);

    await expect(validateFilterCriteriaRefs(deps, 'project-1', { sprintIds: ['ghost'] })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses a label the project does not own, judged from the project’s own labels', async () => {
    const deps = makeDeps();

    deps.labelRepo.findByProject = vi.fn().mockResolvedValue([{ id: 'label-1' }]);

    await expect(validateFilterCriteriaRefs(deps, 'project-1', { labelIds: ['label-foreign'] })).rejects.toMatchObject({
      statusCode: 404,
    });
    // The project's labels are read, not the submitted id looked up globally.
    expect(deps.labelRepo.findByProject).toHaveBeenCalledWith('project-1');
  });

  it('refuses an assignee who is not a member of this project — through the membership, not the users table', async () => {
    const deps = makeDeps();

    deps.projectMemberRepo.findUserIdentityByProject = vi.fn().mockResolvedValue(null);

    await expect(
      validateFilterCriteriaRefs(deps, 'project-1', { assigneeIds: ['user-outsider'] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.projectMemberRepo.findUserIdentityByProject).toHaveBeenCalledWith('user-outsider', 'project-1');
  });

  it('checks reporters as well as assignees', async () => {
    const deps = makeDeps();

    deps.projectMemberRepo.findUserIdentityByProject = vi.fn().mockResolvedValue(null);

    await expect(
      validateFilterCriteriaRefs(deps, 'project-1', { reporterIds: ['user-outsider'] }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('costs no query for a criteria object that names no ids at all', async () => {
    const deps = makeDeps();

    await expect(
      validateFilterCriteriaRefs(deps, 'project-1', { search: 'release', createdFrom: '2026-01-01' }),
    ).resolves.toBeUndefined();
    expect(deps.statusRepo.findByIds).not.toHaveBeenCalled();
    expect(deps.labelRepo.findByProject).not.toHaveBeenCalled();
    expect(deps.projectMemberRepo.findUserIdentityByProject).not.toHaveBeenCalled();
  });
});

describe('FilterService — a cross-project reference never reaches the database', () => {
  let filterRepo: ReturnType<typeof createMockFilterRepo>;
  let projectRepo: { findById: ReturnType<typeof vi.fn> };
  let refDeps: FilterRefDeps;
  let service: FilterService;

  beforeEach(() => {
    filterRepo = createMockFilterRepo();
    projectRepo = { findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }) };
    refDeps = {
      statusRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'status-1', projectId: 'project-1' }]) },
      taskTypeRepo: { findByIds: vi.fn().mockResolvedValue([]) },
      sprintRepo: { findByIds: vi.fn().mockResolvedValue([]) },
      labelRepo: { findByProject: vi.fn().mockResolvedValue([]) },
      projectMemberRepo: { findUserIdentityByProject: vi.fn().mockResolvedValue(null) },
    };
    service = new FilterService(filterRepo, projectRepo as never, refDeps);
  });

  it('createFilter refuses a foreign status id with 404 and writes nothing', async () => {
    refDeps.statusRepo.findByIds = vi.fn().mockResolvedValue([{ id: 'status-foreign', projectId: 'project-2' }]);
    filterRepo.findByUserProjectAndName = vi.fn().mockResolvedValue(null);

    await expect(
      service.createFilter(
        'project-1',
        { name: 'Sneaky', filters: { statusIds: ['status-foreign'] }, sort: { field: 'createdAt', direction: 'desc' } },
        CTX,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(filterRepo.create).not.toHaveBeenCalled();
  });

  it('updateFilter refuses foreign criteria with 404 and writes nothing', async () => {
    filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
    refDeps.sprintRepo.findByIds = vi.fn().mockResolvedValue([{ id: 'sprint-foreign', projectId: 'project-2' }]);

    await expect(
      service.updateFilter('filter-1', { filters: { sprintIds: ['sprint-foreign'] } }, CTX),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(filterRepo.update).not.toHaveBeenCalled();
  });

  it('an update that does not touch the criteria never reaches the reference check', async () => {
    filterRepo.findById = vi.fn().mockResolvedValue(makeFilter());
    filterRepo.update = vi.fn().mockResolvedValue(makeFilter({ name: 'Renamed' }));

    await service.updateFilter('filter-1', { name: 'Renamed' }, CTX);

    expect(refDeps.statusRepo.findByIds).not.toHaveBeenCalled();
    expect(filterRepo.update).toHaveBeenCalledWith('filter-1', { name: 'Renamed' });
  });
});
