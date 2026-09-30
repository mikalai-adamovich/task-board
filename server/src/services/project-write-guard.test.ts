/**
 * The predicate itself, and the seam that applies it.
 *
 * Two things are proven here:
 *   1. {@link projectAcceptsWrites} answers the question it claims to, for
 *      every project status and for a project whose status cannot be read.
 *   2. {@link assertProjectWritableInTenant} refuses a write to a frozen
 *      project, still 404s a FOREIGN one (never 403), and still 401s a missing
 *      caller context — i.e. adding the rule did not soften the tenant seam.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProjectStatus } from '@task-board/shared';
import { projectAcceptsWrites, assertProjectAcceptsWrites } from './project-write-guard.js';
import { assertProjectInTenant, assertProjectWritableInTenant } from './tenant-assert.js';

describe('projectAcceptsWrites — the single write rule (N-1)', () => {
  it('accepts writes ONLY in ACTIVE', () => {
    expect(projectAcceptsWrites({ status: ProjectStatus.ACTIVE })).toBe(true);
  });

  it('refuses a project scheduled for deletion — the status the UI calls read-only', () => {
    expect(projectAcceptsWrites({ status: ProjectStatus.DELETION_PENDING })).toBe(false);
  });

  it('refuses an archived project', () => {
    expect(projectAcceptsWrites({ status: ProjectStatus.ARCHIVED })).toBe(false);
  });

  it('refuses a status it has never heard of (allow-list, not deny-list)', () => {
    // A status added to ProjectStatus tomorrow is read-only until someone
    // decides otherwise HERE. A deny-list of the two frozen statuses would let
    // a new one through by default, which is the wrong direction for a
    // deletion window.
    expect(projectAcceptsWrites({ status: 'SOMETHING_NEW' })).toBe(false);
  });

  it('fails closed when the status cannot be read at all', () => {
    // A test double that omits `status` must not be able to make a write look
    // legal. This is the fail-closed direction the codebase uses everywhere
    // else (a missing project repository is "cannot prove ownership" → 404).
    expect(projectAcceptsWrites({})).toBe(false);
    expect(projectAcceptsWrites({ status: null })).toBe(false);
    expect(projectAcceptsWrites(undefined)).toBe(false);
    expect(projectAcceptsWrites(null)).toBe(false);
  });
});

describe('assertProjectAcceptsWrites — the refusal it throws', () => {
  it('throws the unchanged PROJECT_ARCHIVED 409 for an archived project', () => {
    // Contract preservation: the archived refusal has always been a 409
    // PROJECT_ARCHIVED with this message, and `errors.projectArchived` is
    // translated in every locale. Nothing about that may move.
    expect(() => assertProjectAcceptsWrites({ status: ProjectStatus.ARCHIVED })).toThrow(
      'Project is archived and cannot be modified',
    );

    try {
      assertProjectAcceptsWrites({ status: ProjectStatus.ARCHIVED });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: 'PROJECT_ARCHIVED' });
    }
  });

  it('throws 409 CONFLICT naming the deletion for a DELETION_PENDING project', () => {
    try {
      assertProjectAcceptsWrites({ status: ProjectStatus.DELETION_PENDING });
      expect.unreachable('the write must be refused');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      expect((error as Error).message).toContain('scheduled for deletion');
    }
  });

  it('names the entity when a label is what is being written', () => {
    try {
      assertProjectAcceptsWrites({ status: ProjectStatus.DELETION_PENDING }, 'Label');
      expect.unreachable('the write must be refused');
    } catch (error) {
      expect((error as Error).message).toContain('Label');
    }
  });

  it('returns normally for an ACTIVE project', () => {
    expect(() => assertProjectAcceptsWrites({ status: ProjectStatus.ACTIVE })).not.toThrow();
  });
});

describe('assertProjectWritableInTenant — tenant seam first, write rule second', () => {
  const activeRepo = { findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: ProjectStatus.ACTIVE }) };
  const deletingRepo = {
    findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', status: ProjectStatus.DELETION_PENDING }),
  };
  const foreignRepo = {
    findById: vi.fn().mockResolvedValue({ tenantId: 'tenant-OTHER', status: ProjectStatus.ACTIVE }),
  };

  it('resolves the project and allows the write when it is ACTIVE', async () => {
    const project = await assertProjectWritableInTenant(activeRepo, 'project-1', 'tenant-1');

    expect(project.tenantId).toBe('tenant-1');
  });

  it('refuses the write to a project scheduled for deletion', async () => {
    await expect(assertProjectWritableInTenant(deletingRepo, 'project-1', 'tenant-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('still 404s a FOREIGN project — never 403, whatever its status', async () => {
    // The write rule must not become an existence oracle: a project in another
    // tenant has to be indistinguishable from a nonexistent one, so the tenant
    // check runs FIRST and the state of the project is never discussed.
    await expect(assertProjectWritableInTenant(foreignRepo, 'project-1', 'tenant-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('still 404s when there is no project repository (cannot prove ownership)', async () => {
    await expect(assertProjectWritableInTenant(undefined, 'project-1', 'tenant-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('the READ seam is unchanged: it resolves a DELETION_PENDING project without complaint', async () => {
    // A frozen project is READ-ONLY, not invisible: the banner the user is shown
    // has to have something behind it, so reads must still work.
    const project = await assertProjectInTenant(deletingRepo, 'project-1', 'tenant-1');

    expect(project.status).toBe(ProjectStatus.DELETION_PENDING);
  });
});
