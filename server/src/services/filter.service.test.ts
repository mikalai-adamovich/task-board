import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterService } from './filter.service.js';
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
  let service: FilterService;

  beforeEach(() => {
    filterRepo = createMockFilterRepo();
    projectRepo = { findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }) };
    service = new FilterService(filterRepo, projectRepo as never);
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
