import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LabelService } from './label.service.js';
import type { LabelServiceTaskRepo, LabelServiceProjectRepo, LabelServiceProjectMemberRepo } from './label.service.js';
import type { LabelRepository } from '../repositories/label.repository.js';
import type { CallerContext } from './tenant-assert.js';
import type { AuditService } from './audit.service.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors/app-error.js';
import type { Label } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockLabelRepo() {
  return {
    findByProject: vi.fn(),
    findByProjectAndNormalizedName: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as LabelRepository;
}

function createMockTaskRepo() {
  return {
    removeLabelFromAll: vi.fn(),
  } as unknown as LabelServiceTaskRepo;
}

function createMockProjectRepo(tenantId = 'tenant-1') {
  return {
    findById: vi.fn().mockResolvedValue({ tenantId, status: 'ACTIVE' }),
  } as unknown as LabelServiceProjectRepo;
}

function createMockProjectMemberRepo(role: string | null) {
  return {
    findByUserAndProject: vi.fn().mockResolvedValue(role ? { role } : null),
  } as unknown as LabelServiceProjectMemberRepo;
}

function createMockAuditService() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
}

function makeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: 'label-1',
    projectId: 'project-1',
    name: 'bug',
    color: '#ff0000',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Label;
}

/** A caller context is now REQUIRED — the happy-path fixture is explicit. */
const CTX: CallerContext = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LabelService', () => {
  let labelRepo: ReturnType<typeof createMockLabelRepo>;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let projectRepo: ReturnType<typeof createMockProjectRepo>;
  let auditService: ReturnType<typeof createMockAuditService>;

  beforeEach(() => {
    labelRepo = createMockLabelRepo();
    taskRepo = createMockTaskRepo();
    projectRepo = createMockProjectRepo();
    auditService = createMockAuditService();
  });

  describe('getLabelsByProject', () => {
    it('returns all labels for a project', async () => {
      labelRepo.findByProject = vi.fn().mockResolvedValue([makeLabel()]);

      const service = new LabelService(labelRepo, taskRepo, projectRepo);
      const result = await service.getLabelsByProject('project-1', CTX);

      expect(result).toHaveLength(1);
      expect(labelRepo.findByProject).toHaveBeenCalledWith('project-1');
    });
  });

  describe('createLabel', () => {
    const input = { name: 'Bug', color: '#ff0000' };

    it('creates a label for a project admin', async () => {
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.create = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );
      const result = await service.createLabel('project-1', input, CTX);

      expect(result.name).toBe('bug');
      expect(labelRepo.create).toHaveBeenCalledWith('project-1', input);
    });

    it('allows tenant admins without project membership (RBAC bypass)', async () => {
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.create = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo(null),
      );
      const result = await service.createLabel('project-1', input, { ...CTX, userRole: 'ADMIN' });

      expect(result.name).toBe('bug');
    });

    it('throws ForbiddenError for a viewer (manage_labels denied)', async () => {
      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('VIEWER'),
      );

      await expect(service.createLabel('project-1', input, CTX)).rejects.toThrow(ForbiddenError);
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when membership lookup is unavailable', async () => {
      const service = new LabelService(labelRepo, taskRepo, projectRepo);

      await expect(service.createLabel('project-1', input, CTX)).rejects.toThrow(
        'Project membership lookup is unavailable',
      );
    });

    it('throws ConflictError on duplicate normalized name', async () => {
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await expect(service.createLabel('project-1', input, CTX)).rejects.toThrow(ConflictError);
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('writes an audit event when audit service and project repo are present', async () => {
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.create = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.createLabel('project-1', input, CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          entityType: 'LABEL',
          action: 'CREATED',
          actorId: 'user-1',
        }),
      );
    });
  });

  describe('updateLabel', () => {
    const input = { name: 'Defect', color: '#00ff00' };

    it('updates a label for a project admin', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.update = vi.fn().mockResolvedValue(makeLabel({ name: 'Defect' }));

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );
      const result = await service.updateLabel('label-1', input, CTX);

      expect(result.name).toBe('Defect');
      expect(labelRepo.update).toHaveBeenCalledWith('label-1', { name: 'Defect', normalizedName: 'defect' });
    });

    it('throws NotFoundError when the label does not exist', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(null);

      const service = new LabelService(labelRepo, taskRepo, projectRepo);

      await expect(service.updateLabel('missing', input, CTX)).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError for a viewer', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('VIEWER'),
      );

      await expect(service.updateLabel('label-1', input, CTX)).rejects.toThrow(ForbiddenError);
    });

    it('throws ConflictError when another label with the same name exists', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(makeLabel({ id: 'label-2' }));

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await expect(service.updateLabel('label-1', input, CTX)).rejects.toThrow(ConflictError);
    });

    it('allows renaming to the same normalized name (self-match)', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.update = vi.fn().mockResolvedValue(makeLabel({ name: 'Defect' }));

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );
      const result = await service.updateLabel('label-1', input, CTX);

      expect(result.name).toBe('Defect');
    });

    it('throws NotFoundError when the update returns null', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.update = vi.fn().mockResolvedValue(null);

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await expect(service.updateLabel('label-1', input, CTX)).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteLabel', () => {
    it('deletes a label and removes task associations for a project admin', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.delete = vi.fn().mockResolvedValue(undefined);

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.deleteLabel('label-1', CTX);

      expect(taskRepo.removeLabelFromAll).toHaveBeenCalledWith('project-1', 'label-1');
      expect(labelRepo.delete).toHaveBeenCalledWith('label-1');
    });

    it('throws NotFoundError when the label does not exist', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(null);

      const service = new LabelService(labelRepo, taskRepo, projectRepo);

      await expect(service.deleteLabel('missing', CTX)).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError for a viewer', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('VIEWER'),
      );

      await expect(service.deleteLabel('label-1', CTX)).rejects.toThrow(ForbiddenError);
      expect(taskRepo.removeLabelFromAll).not.toHaveBeenCalled();
    });

    it('writes a DELETED audit event before deleting', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.delete = vi.fn().mockResolvedValue(undefined);

      const service = new LabelService(
        labelRepo,
        taskRepo,
        projectRepo,
        auditService,
        createMockProjectMemberRepo('PROJECT_ADMIN'),
      );

      await service.deleteLabel('label-1', CTX);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'LABEL', action: 'DELETED', actorId: 'user-1' }),
      );
    });
  });

  // ── Tenant isolation + fail-closed guardrails ─────────────────────────────

  describe('tenant isolation (M-001/M-006/M-034)', () => {
    const input = { name: 'Bug', color: '#ff0000' };
    let memberRepo: LabelServiceProjectMemberRepo & { findByUserAndProject: ReturnType<typeof vi.fn> };
    let service: LabelService;
    /** tenant-B user hitting tenant-A's project-1 */
    const foreignCtx: CallerContext = { tenantId: 'tenant-OTHER', userId: 'user-1', userRole: 'OWNER' };

    beforeEach(() => {
      // tenant OWNER bypasses the project matrix, so a foreign owner is the
      // strongest possible attacker and MUST still be stopped by the seam.
      memberRepo = { findByUserAndProject: vi.fn().mockResolvedValue(null) } as never;
      service = new LabelService(labelRepo, taskRepo, projectRepo, auditService, memberRepo);
    });

    it('createLabel rejects a foreign tenant with 404 (not 403) and writes nothing', async () => {
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.create = vi.fn().mockResolvedValue(makeLabel());

      await expect(service.createLabel('project-1', input, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('getLabelsByProject rejects a foreign tenant with 404 and lists nothing', async () => {
      labelRepo.findByProject = vi.fn().mockResolvedValue([makeLabel()]);

      await expect(service.getLabelsByProject('project-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(labelRepo.findByProject).not.toHaveBeenCalled();
    });

    it('updateLabel on a foreign-tenant label is 404 and never renames it', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());
      labelRepo.update = vi.fn().mockResolvedValue(makeLabel({ name: 'HIJACKED' }));

      await expect(service.updateLabel('label-1', { name: 'HIJACKED' }, foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(labelRepo.update).not.toHaveBeenCalled();
    });

    it('deleteLabel on a foreign-tenant label is 404 and never deletes it', async () => {
      labelRepo.findById = vi.fn().mockResolvedValue(makeLabel());

      await expect(service.deleteLabel('label-1', foreignCtx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(taskRepo.removeLabelFromAll).not.toHaveBeenCalled();
      expect(labelRepo.delete).not.toHaveBeenCalled();
    });

    it('a 404 for a foreign project is indistinguishable from a nonexistent one', async () => {
      const missingProject = createMockProjectRepo();

      missingProject.findById = vi.fn().mockResolvedValue(null) as never;

      const svc = new LabelService(labelRepo, taskRepo, missingProject, auditService, memberRepo);
      const foreign = await service
        .createLabel('project-1', input, foreignCtx)
        .then(() => null)
        .catch((e: { message: string }) => e);
      const absent = await svc
        .createLabel('project-1', input, foreignCtx)
        .then(() => null)
        .catch((e: { message: string }) => e);

      expect(foreign?.message).toBe(absent?.message);
    });

    it('throws Unauthorized (401) instead of silently skipping the check when the context is empty', async () => {
      const emptyCtx: CallerContext = { tenantId: '', userId: '', userRole: '' };

      await expect(service.createLabel('project-1', input, emptyCtx)).rejects.toThrow(UnauthorizedError);
      await expect(service.getLabelsByProject('project-1', emptyCtx)).rejects.toThrow(UnauthorizedError);
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('throws Forbidden (403) for a VIEWER inside the tenant', async () => {
      memberRepo.findByUserAndProject.mockResolvedValue({ role: 'VIEWER' });

      await expect(service.createLabel('project-1', input, CTX)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('happy path: a project admin of the owning tenant still succeeds', async () => {
      memberRepo.findByUserAndProject.mockResolvedValue({ role: 'PROJECT_ADMIN' });
      labelRepo.findByProjectAndNormalizedName = vi.fn().mockResolvedValue(null);
      labelRepo.create = vi.fn().mockResolvedValue(makeLabel());

      const result = await service.createLabel('project-1', input, CTX);

      expect(result.id).toBe('label-1');
      expect(labelRepo.create).toHaveBeenCalledWith('project-1', input);
    });
  });
  /**
   * On an id-addressed route, "does not exist" and "belongs to another
   * tenant" must be BYTE-IDENTICAL responses.
   *
   * The property, not the message: these assert the two error BODIES are equal,
   * so a fix that renames both messages to anything else still passes and a fix
   * that changes only one of them fails. `tenant-isolation.test.ts` already
   * asserts the STATUS of every tenant-scoped route; nothing asserted the body.
   */
  describe('a foreign label is indistinguishable from a nonexistent one (D-18)', () => {
    /** A service whose project lookup knows two tenants. */
    function serviceOverTwoTenants() {
      const repos = {
        labelRepo: createMockLabelRepo(),
        taskRepo: createMockTaskRepo(),
        projectRepo: createMockProjectRepo(),
      };

      repos.projectRepo.findById = vi.fn((id: string) =>
        Promise.resolve(id === 'project-2' ? { tenantId: 'tenant-2' } : { tenantId: 'tenant-1' }),
      );

      return { ...repos, service: new LabelService(repos.labelRepo, repos.taskRepo, repos.projectRepo) };
    }

    /** The error body a caller would receive, whatever the underlying reason. */
    async function body(promise: Promise<unknown>): Promise<unknown> {
      try {
        await promise;

        return { resolved: true };
      } catch (error) {
        const e = error as { statusCode?: number; code?: string; message?: string };

        return { statusCode: e.statusCode, code: e.code, message: e.message };
      }
    }

    it('answers a nonexistent id and a foreign id with the SAME error body', async () => {
      const missing = serviceOverTwoTenants();

      missing.labelRepo.findById = vi.fn().mockResolvedValue(null);

      const foreign = serviceOverTwoTenants();

      foreign.labelRepo.findById = vi
        .fn()
        .mockResolvedValue({ id: 'label-foreign', projectId: 'project-2', name: 'X' });

      const a = await body(missing.service.updateLabel('label-missing', { name: 'Renamed' }, CTX));
      const b = await body(foreign.service.updateLabel('label-foreign', { name: 'Renamed' }, CTX));

      expect(a).toEqual(b);
      expect(a).toMatchObject({ statusCode: 404 });
    });

    it('still refuses a foreign label — equality is not bought by removing the check', async () => {
      const { service, labelRepo } = serviceOverTwoTenants();

      labelRepo.findById = vi.fn().mockResolvedValue({ id: 'label-foreign', projectId: 'project-2', name: 'X' });

      await expect(service.updateLabel('label-foreign', { name: 'Renamed' }, CTX)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(labelRepo.update).not.toHaveBeenCalled();
    });

    it('deletes a foreign label with the same body as a missing one', async () => {
      const missing = serviceOverTwoTenants();

      missing.labelRepo.findById = vi.fn().mockResolvedValue(null);

      const foreign = serviceOverTwoTenants();

      foreign.labelRepo.findById = vi
        .fn()
        .mockResolvedValue({ id: 'label-foreign', projectId: 'project-2', name: 'X' });

      expect(await body(missing.service.deleteLabel('label-missing', CTX))).toEqual(
        await body(foreign.service.deleteLabel('label-foreign', CTX)),
      );
    });

    it('keeps the PROJECT-addressed route naming the PROJECT', async () => {
      // The mirror image: on `GET /projects/:projectId/labels` the addressed
      // entity IS the project, so equality there is achieved by naming it.
      const { service } = serviceOverTwoTenants();

      await expect(service.getLabelsByProject('project-2', CTX)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Project not found',
      });
    });
  });
});
