import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentService } from './comment.service.js';
import type { CommentServiceTaskRepo, CommentServiceProjectMemberRepo } from './comment.service.js';
import type { CommentRepository } from '../repositories/comment.repository.js';
import type { AuditService } from './audit.service.js';
import type { Comment } from '@task-board/shared';
import { COMMENT_PAGE_SIZE, decodeCommentCursor } from '@task-board/shared';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockCommentRepo() {
  return {
    findById: vi.fn(),
    findPageByTask: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as CommentRepository;
}

function createMockUserRepo() {
  return {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Alice', email: 'alice@example.com' }),
  };
}

function createMockTaskRepo(): CommentServiceTaskRepo {
  return {
    findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' }),
  };
}

function createMockProjectMemberRepo(): CommentServiceProjectMemberRepo {
  return {
    findByUserAndProject: vi.fn().mockResolvedValue(null),
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    taskId: 'task-1',
    authorId: 'user-2',
    authorSnapshot: { displayName: 'Bob' },
    body: 'Hello',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Comment;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CommentService (DEC-020 ownership/moderation)', () => {
  let commentRepo: ReturnType<typeof createMockCommentRepo>;
  let userRepo: ReturnType<typeof createMockUserRepo>;
  let taskRepo: CommentServiceTaskRepo;
  let projectMemberRepo: CommentServiceProjectMemberRepo;
  let projectRepo: { findById: ReturnType<typeof vi.fn> };
  let auditService: AuditService;
  let service: CommentService;
  /**
   * The caller context every project-scoped method now
   * REQUIRES. Omitting it throws 401; a foreign `tenantId` throws 404.
   */
  const ctx = { tenantId: 'tenant-1', userId: 'user-1', userRole: 'MEMBER' };

  beforeEach(() => {
    commentRepo = createMockCommentRepo();
    userRepo = createMockUserRepo();
    taskRepo = createMockTaskRepo();
    projectMemberRepo = createMockProjectMemberRepo();
    projectRepo = { findById: vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-1', status: 'ACTIVE' }) };
    auditService = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    service = new CommentService(
      commentRepo,
      userRepo as never,
      taskRepo,
      projectMemberRepo,
      auditService,
      projectRepo as never,
    );
  });

  describe('getCommentsByTask (M-02)', () => {
    const CURSOR_KEY = { createdAtMs: Date.parse('2025-01-01T00:00:00.000Z'), objectId: 'a'.repeat(24) };

    it('returns one page for a task within the caller tenant', async () => {
      commentRepo.findPageByTask = vi.fn().mockResolvedValue({
        comments: [makeComment()],
        hasMore: true,
        nextCursor: CURSOR_KEY,
      });

      const result = await service.getCommentsByTask('task-1', { limit: COMMENT_PAGE_SIZE }, ctx);

      expect(result.comments).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.limit).toBe(COMMENT_PAGE_SIZE);
    });

    it('forwards the validated page window to the repository unchanged', async () => {
      commentRepo.findPageByTask = vi.fn().mockResolvedValue({ comments: [], hasMore: false, nextCursor: null });

      await service.getCommentsByTask('task-1', { limit: 5, cursor: CURSOR_KEY }, ctx);

      expect(commentRepo.findPageByTask).toHaveBeenCalledWith('task-1', { limit: 5, cursor: CURSOR_KEY });
    });

    it('hands back an OPAQUE cursor that decodes to the page boundary key', async () => {
      commentRepo.findPageByTask = vi.fn().mockResolvedValue({
        comments: [makeComment()],
        hasMore: true,
        nextCursor: CURSOR_KEY,
      });

      const { nextCursor } = await service.getCommentsByTask('task-1', { limit: 30 }, ctx);

      // Not the raw query object: the `_id` is a storage handle, so the wire
      // form is a serialized key the caller passes back verbatim.
      expect(nextCursor).not.toBe(CURSOR_KEY);
      expect(decodeCommentCursor(nextCursor)).toEqual(CURSOR_KEY);
    });

    it('never advertises a cursor on a page that has no more comments', async () => {
      // `hasMore` is derived from the probe row, so a page that says "no more"
      // has nothing to resume from — handing back a cursor anyway would invite
      // a client to keep paging a thread that is already exhausted.
      commentRepo.findPageByTask = vi
        .fn()
        .mockResolvedValue({ comments: [makeComment()], hasMore: false, nextCursor: CURSOR_KEY });

      const { nextCursor } = await service.getCommentsByTask('task-1', { limit: 30 }, ctx);

      expect(nextCursor).toBeNull();
    });

    it('throws NOT_FOUND when the task does not exist', async () => {
      taskRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.getCommentsByTask('missing', { limit: 30 }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws NOT_FOUND (not 403) when the task belongs to another tenant (M-02)', async () => {
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.getCommentsByTask('task-1', { limit: 30 }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(commentRepo.findPageByTask).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      await expect(service.getCommentsByTask('task-1', { limit: 30 }, undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(commentRepo.findPageByTask).not.toHaveBeenCalled();
    });
  });

  describe('createComment', () => {
    it('allows an EDITOR to comment and records the acting user as the author', async () => {
      commentRepo.create = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      const result = await service.createComment('task-1', { body: 'Hello' }, ctx);

      expect(result.id).toBe('comment-1');
      expect(commentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', authorId: 'user-1', body: 'Hello' }),
      );
    });

    it('denies a project VIEWER (create_comment is EDITOR+)', async () => {
      commentRepo.create = vi.fn();
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(service.createComment('task-1', { body: 'Nope' }, ctx)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
    });

    // The create path used to be authorized by a `if (userRole)` guard,
    // so a call site that forwarded no role wrote the comment unchecked.
    it('throws 401 when the caller context is missing — no more skipped create_comment check', async () => {
      commentRepo.create = vi.fn();

      await expect(service.createComment('task-1', { body: 'Nope' }, undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND for a task of another tenant and writes nothing', async () => {
      commentRepo.create = vi.fn();
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.createComment('task-1', { body: 'Nope' }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('allows an EDITOR to edit their own comment', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1' }));
      commentRepo.update = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1', body: 'Edited' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      const result = await service.updateComment('comment-1', { body: 'Edited' }, ctx);

      expect(result.body).toBe('Edited');
    });

    it('denies an EDITOR editing someone else’s comment', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-2' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      await expect(service.updateComment('comment-1', { body: 'Hacked' }, ctx)).rejects.toThrow(
        'You can only edit your own comments',
      );
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('allows a PROJECT_ADMIN to moderate any comment in project scope', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-2' }));
      commentRepo.update = vi.fn().mockResolvedValue(makeComment({ body: 'Moderated' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' });

      const result = await service.updateComment('comment-1', { body: 'Moderated' }, ctx);

      expect(result.body).toBe('Moderated');
    });

    it('allows a tenant OWNER to moderate any comment (bypass)', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-2' }));
      commentRepo.update = vi.fn().mockResolvedValue(makeComment({ body: 'Moderated' }));

      const result = await service.updateComment('comment-1', { body: 'Moderated' }, { ...ctx, userRole: 'OWNER' });

      expect(result.body).toBe('Moderated');
    });

    it('denies a VIEWER even for their own comment (no base permission)', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(service.updateComment('comment-1', { body: 'Edited' }, ctx)).rejects.toThrow(
        "Insufficient permissions. Requires 'edit_comment'",
      );
    });

    // A comment id from another tenant must be rejected too.
    it('throws NOT_FOUND (not 403) for a comment whose task is in another tenant', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment());
      commentRepo.update = vi.fn();
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' });
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.updateComment('comment-1', { body: 'Hacked' }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment());
      commentRepo.update = vi.fn();

      await expect(service.updateComment('comment-1', { body: 'Hacked' }, undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('allows an EDITOR to delete their own comment', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      await service.deleteComment('comment-1', ctx);

      expect(commentRepo.delete).toHaveBeenCalledWith('comment-1');
    });

    it('denies an EDITOR deleting someone else’s comment', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-2' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'EDITOR' });

      await expect(service.deleteComment('comment-1', ctx)).rejects.toThrow('You can only delete your own comments');
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });

    it('allows a PROJECT_ADMIN to delete any comment in project scope', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-2' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' });

      await service.deleteComment('comment-1', ctx);

      expect(commentRepo.delete).toHaveBeenCalledWith('comment-1');
    });

    it('throws NotFoundError when the comment does not exist', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(service.deleteComment('missing', { ...ctx, userRole: 'OWNER' })).rejects.toThrow(
        'Comment not found',
      );
    });

    // A comment id from another tenant must be rejected too.
    it('throws NOT_FOUND for a comment whose task is in another tenant and deletes nothing', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment());
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'PROJECT_ADMIN' });
      projectRepo.findById = vi.fn().mockResolvedValue({ id: 'project-1', tenantId: 'tenant-OTHER' });

      await expect(service.deleteComment('comment-1', ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });

    it('throws 401 when the caller context is missing (fail closed)', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment());

      await expect(service.deleteComment('comment-1', undefined as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });

    it('denies a project VIEWER deleting a comment (403)', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(makeComment({ authorId: 'user-1' }));
      projectMemberRepo.findByUserAndProject = vi.fn().mockResolvedValue({ role: 'VIEWER' });

      await expect(service.deleteComment('comment-1', ctx)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });
  });
  /**
   * A comment of another tenant must be indistinguishable from a
   * nonexistent one, down to the error BODY.
   *
   * Before, the not-found branch said "Comment not found" and the cross-tenant
   * branch said "Task not found" (the comment's own task failed the tenant
   * assert), so the bit the 404 suppresses came back through `message` and any
   * comment id became a tenant-ownership oracle.
   */
  describe('a foreign comment is indistinguishable from a nonexistent one (D-18)', () => {
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

    /** A service whose task belongs to a project of ANOTHER tenant. */
    function serviceOverAForeignTask() {
      const foreignProjectRepo = {
        findById: vi.fn().mockResolvedValue({ id: 'project-2', tenantId: 'tenant-2' }),
      };

      return {
        foreignProjectRepo,
        service: new CommentService(
          commentRepo,
          userRepo as never,
          taskRepo,
          projectMemberRepo,
          auditService,
          foreignProjectRepo as never,
        ),
      };
    }

    it('answers a nonexistent comment and a foreign one with the SAME body', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue(null);

      const missing = await body(service.deleteComment('comment-missing', ctx));

      commentRepo.findById = vi.fn().mockResolvedValue({ id: 'comment-x', taskId: 'task-x', body: 'b' });
      taskRepo.findById = vi.fn().mockResolvedValue({ id: 'task-x', projectId: 'project-2' });

      const { service: foreignService } = serviceOverAForeignTask();
      const foreign = await body(foreignService.deleteComment('comment-x', ctx));

      expect(foreign).toEqual(missing);
      expect(missing).toMatchObject({ statusCode: 404 });
    });

    it('still refuses a foreign comment — equality is not bought by removing the check', async () => {
      commentRepo.findById = vi.fn().mockResolvedValue({ id: 'comment-x', taskId: 'task-x', body: 'b' });
      taskRepo.findById = vi.fn().mockResolvedValue({ id: 'task-x', projectId: 'project-2' });

      const { service: foreignService } = serviceOverAForeignTask();

      await expect(foreignService.deleteComment('comment-x', ctx)).rejects.toMatchObject({ statusCode: 404 });
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });
  });
});
