import type { Comment, CommentPage, CreateComment, UpdateComment, IdentitySnapshot } from '@task-board/shared';
import { encodeCommentCursor, type CommentPageCursor } from '@task-board/shared';
import { ForbiddenError, NotFoundError } from '../errors/app-error.js';
import { CommentRepository } from '../repositories/comment.repository.js';
import { ensurePermission, rbacService } from './rbac.service.js';
import { assertProjectInTenant, requireCallerContext, type CallerContext } from './tenant-assert.js';
import { assertProjectAcceptsWrites, type WriteGuardedProject } from './project-write-guard.js';
import type { AuditService } from './audit.service.js';

export interface CommentServiceUserRepo {
  findById(id: string): Promise<{ id: string; displayName?: string; name?: string; email: string } | null>;
}

/** Minimal task repository interface to resolve a comment's project */
export interface CommentServiceTaskRepo {
  findById(id: string): Promise<{ id: string; projectId: string } | null>;
}

/** Minimal project-member repository interface to resolve the caller's project role */
export interface CommentServiceProjectMemberRepo {
  findByUserAndProject(userId: string, projectId: string): Promise<{ role: string } | null>;
}

/**
 * Minimal project repository interface to resolve a task's tenant.
 *
 * `status` is part of the projection because the write seam needs it: a comment is written
 * against a task, so the write rule is a question about the task's OWNING
 * project, and the tenant assertion already performed this lookup.
 */
export interface CommentServiceProjectRepo {
  findById(id: string): Promise<({ tenantId: string } & WriteGuardedProject) | null>;
}

/**
 * The ONE message a comment-addressed route answers with, whether the id
 * does not exist, belongs to another tenant, or names a task that does.
 */
const COMMENT_NOT_FOUND = 'Comment not found';

export class CommentService {
  /**
   * Every dependency is REQUIRED: an absent project/task repository means
   * "cannot prove tenant ownership", which must fail closed (404) rather than
   * silently skip the assertion. The parameter order is unchanged from the
   * pre-audit signature so `container.ts` needs no wiring change.
   */
  constructor(
    private readonly commentRepo: CommentRepository,
    private readonly userRepo: CommentServiceUserRepo,
    private readonly taskRepo: CommentServiceTaskRepo,
    private readonly projectMemberRepo: CommentServiceProjectMemberRepo,
    private readonly auditService: AuditService,
    private readonly projectRepo: CommentServiceProjectRepo,
  ) {}

  // ─── Tenant / project scope ───────────────────────────────────────────────

  /**
   * A bare task id must never cross tenant boundaries. The task is
   * resolved first and its owning project is asserted against the caller's
   * tenant (404, not 403) BEFORE any comment is read or written.
   *
   * @returns the resolved task so callers can audit-log without a second fetch.
   */
  private async requireTaskInTenant(
    taskId: string,
    context: CallerContext,
  ): Promise<{ tenantId: string } & WriteGuardedProject & { id: string; projectId: string }> {
    const { tenantId } = requireCallerContext(context);
    const task = await this.taskRepo.findById(taskId);

    if (!task) {
      throw new NotFoundError('Task not found');
    }

    const project = await assertProjectInTenant(this.projectRepo, task.projectId, tenantId, 'Task');

    return { ...project, ...task };
  }

  /**
   * The WRITE variant of {@link requireTaskInTenant}. A comment is written
   * against a TASK, so the write rule is about the task's OWNING project — the
   * one that is scheduled for deletion. The read variant above is shared by
   * `getCommentsByTask` and the writes, so the rule cannot live in it; every
   * write method routes through this instead.
   */
  private async requireWritableTaskInTenant(
    taskId: string,
    context: CallerContext,
  ): Promise<{ tenantId: string } & WriteGuardedProject & { id: string; projectId: string }> {
    const task = await this.requireTaskInTenant(taskId, context);

    assertProjectAcceptsWrites(task, 'Task');

    return task;
  }

  /**
   * The comment is addressed by a bare id, so its owning task is
   * resolved and tenant-asserted before any authorization decision is made.
   *
   * A `Comment` document carries no `projectId` of its own — the audit/role
   * context is inherited from the resolved task, hence the explicit spread.
   */
  private async requireCommentInTenant(
    commentId: string,
    context: CallerContext,
  ): Promise<Comment & { projectId: string; tenantId: string }> {
    requireCallerContext(context);

    const comment = await this.commentRepo.findById(commentId);

    if (!comment) {
      throw new NotFoundError(COMMENT_NOT_FOUND);
    }

    // The task resolution below 404s with the TASK's name ("Task not
    // found"). On a comment-addressed route the entity being addressed is the
    // COMMENT, so a comment belonging to another tenant answered differently
    // from a nonexistent one — the bit the 404 suppresses came back through
    // `message`, and any comment id became a tenant-ownership oracle. Re-raise
    // with the one message this route may answer, whatever the real reason was.
    try {
      const task = await this.requireTaskInTenant(comment.taskId, context);

      return { ...comment, projectId: task.projectId, tenantId: task.tenantId };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundError(COMMENT_NOT_FOUND);
      }

      throw error;
    }
  }

  /**
   * One page of a task's comment thread, newest window first.
   *
   * `limit` is the page size the route already validated (at most
   * `COMMENT_PAGE_SIZE`); `cursor` is the decoded resume key of the page below
   * this one. The tenant assertion happens BEFORE the read, exactly as it did
   * for the unpaginated version, so a cross-tenant task is still a 404 and
   * never reaches the collection.
   *
   * The cursor is re-encoded here rather than in the route, so the string the
   * caller receives is produced by the same package that parses it — the route
   * hands over a decoded key and never sees a payload.
   */
  async getCommentsByTask(
    taskId: string,
    query: { limit: number; cursor?: CommentPageCursor | undefined },
    context: CallerContext,
  ): Promise<CommentPage> {
    await this.requireTaskInTenant(taskId, context);

    const page = await this.commentRepo.findPageByTask(taskId, query);

    return {
      comments: page.comments,
      hasMore: page.hasMore,
      // A cursor is only useful when there is more to fetch: `hasMore` is derived
      // from the probe row, so a page that reports more always has an oldest
      // comment to resume from, and a page that does not never advertises one.
      nextCursor: page.hasMore && page.nextCursor ? encodeCommentCursor(page.nextCursor) : null,
      limit: query.limit,
    };
  }

  async createComment(taskId: string, input: CreateComment, context: CallerContext): Promise<Comment> {
    const { userId } = requireCallerContext(context);
    const task = await this.requireWritableTaskInTenant(taskId, context);
    // V2-4: Viewers are read-only — gate creation through the RBAC matrix
    // (create_comment allows PROJECT_ADMIN/EDITOR; tenant Owner/Admin bypass).
    const projectRole = await this.resolveCallerProjectRole(task.projectId, userId);

    ensurePermission('create_comment', context.userRole, projectRole);

    const authorSnapshot = await this.captureIdentitySnapshot(userId);
    const comment = await this.commentRepo.create({
      taskId,
      authorId: userId,
      authorSnapshot,
      body: input.body,
    });

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: task.tenantId,
        projectId: task.projectId,
        entityType: 'COMMENT',
        entityId: comment.id,
        action: 'CREATED',
        actorId: userId,
      });
    }

    return comment;
  }

  async updateComment(commentId: string, input: UpdateComment, context: CallerContext): Promise<Comment> {
    const { userId, userRole } = requireCallerContext(context);
    const comment = await this.requireCommentInTenant(commentId, context);

    // The same read-only rule as every other project-scoped write.
    assertProjectAcceptsWrites(await this.projectRepo.findById(comment.projectId), 'Task');

    // Base permission first, then ownership — Editors edit only their own
    // comments; Project Admin+ (and tenant Owner/Admin bypass) may moderate any.
    await this.ensureCommentAccess(comment, userId, userRole, 'edit_comment', 'edit');

    const updated = await this.commentRepo.update(commentId, { body: input.body });

    if (!updated) {
      throw new NotFoundError(COMMENT_NOT_FOUND);
    }

    // Audit side effect
    if (this.auditService) {
      await this.auditService.log({
        tenantId: comment.tenantId,
        projectId: comment.projectId,
        entityType: 'COMMENT',
        entityId: commentId,
        action: 'UPDATED',
        actorId: userId,
        changes: [{ field: 'body', oldValue: comment.body, newValue: input.body }],
      });
    }

    return updated;
  }

  async deleteComment(commentId: string, context: CallerContext): Promise<void> {
    const { userId, userRole } = requireCallerContext(context);
    const comment = await this.requireCommentInTenant(commentId, context);

    // The same read-only rule as every other project-scoped write.
    assertProjectAcceptsWrites(await this.projectRepo.findById(comment.projectId), 'Task');

    // Base permission first, then ownership — Editors delete only their own
    // comments; Project Admin+ (and tenant Owner/Admin bypass) may moderate any.
    await this.ensureCommentAccess(comment, userId, userRole, 'delete_comment', 'delete');

    // Audit side effect (before delete)
    if (this.auditService) {
      await this.auditService.log({
        tenantId: comment.tenantId,
        projectId: comment.projectId,
        entityType: 'COMMENT',
        entityId: commentId,
        action: 'DELETED',
        actorId: userId,
      });
    }

    await this.commentRepo.delete(commentId);
  }

  /**
   * Enforce DEC-020 comment authorization:
   * 1. `ensurePermission` gates the base action (Editors+; Viewers denied).
   * 2. Non-authors need moderation rights — evaluated through the RBAC matrix at
   *    PROJECT_ADMIN level so tenant Owner/Admin bypass applies without ad-hoc
   *    role comparisons.
   *
   * The caller's project role is resolved from the ALREADY tenant-asserted
   * task, so a foreign comment can never reach this point.
   */
  private async ensureCommentAccess(
    comment: Pick<Comment, 'taskId' | 'authorId'> & { projectId: string },
    userId: string,
    userRole: string,
    action: 'edit_comment' | 'delete_comment',
    verb: string,
  ): Promise<void> {
    const projectRole = await this.resolveCallerProjectRole(comment.projectId, userId);

    // Base permission: Editors+ may act on comments (Viewers denied)
    ensurePermission(action, userRole, projectRole);

    // Moderation of other people's comments requires Project Admin-level rights
    // ('manage_project' maps to PROJECT_ADMIN + tenant Owner/Admin bypass)
    const isAuthor = comment.authorId === userId;

    if (!isAuthor && !rbacService.can(userRole, projectRole, 'manage_project')) {
      throw new ForbiddenError(`You can only ${verb} your own comments`);
    }
  }

  /**
   * Resolve the caller's project role from an already tenant-asserted projectId.
   * A missing membership yields `null`, which the RBAC matrix treats as
   * "no project access" (denied unless the tenant role bypasses).
   */
  private async resolveCallerProjectRole(projectId: string, userId: string): Promise<string | null> {
    const membership = await this.projectMemberRepo.findByUserAndProject(userId, projectId);

    return membership?.role ?? null;
  }

  private async captureIdentitySnapshot(userId: string): Promise<IdentitySnapshot> {
    const user = await this.userRepo.findById(userId);

    return {
      displayName: user?.displayName ?? user?.name ?? user?.email ?? 'Unknown User',
    };
  }
}
