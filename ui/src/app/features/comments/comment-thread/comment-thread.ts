import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { CommentClient } from '@services/comment-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { canWrite } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { finalize, of } from 'rxjs';
import { rxResource } from '@angular/core/rxjs-interop';
import { COMMENT_PAGE_SIZE } from '@task-board/shared';
import type { Comment, CommentPage } from '@task-board/shared';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { initials } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';
import { MilkdownEditor } from '@app/shared/milkdown-editor/milkdown-editor';

/** The first page of a thread nobody has written on yet. */
function emptyPage(): CommentPage {
  return { comments: [], hasMore: false, nextCursor: null, limit: COMMENT_PAGE_SIZE };
}

@Component({
  selector: 'ui-comment-thread',
  imports: [
    ConfirmDialog,
    HlmAlertImports,
    DatePipe,
    TranslocoPipe,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmCardImports,
    HlmTextareaImports,
    HlmAvatarImports,
    HlmDialogImports,
    MilkdownEditor,
  ],
  templateUrl: './comment-thread.html',
})
export class CommentThread {
  private readonly notify = injectToasts();
  private readonly commentClient = inject(CommentClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  /** Task ID to load comments for */
  readonly taskId = input.required<string>();
  /** Current user's ID — used to determine edit/delete permissions */
  readonly currentUserId = input.required<string>();
  /** Whether the current user can moderate (admin/owner) */
  readonly canEdit = input<boolean>(false);
  /** Initials of the current user for the new-comment avatar fallback */
  protected readonly currentUserInitials = computed(() => initials(this.authStore.currentUser()?.displayName ?? null));
  // No request until the task id is meaningful (a blank id would hit
  // `/tasks//comments` and poison the resource with the SPA-fallback HTML).
  // The resource owns the WHOLE loaded thread: the newest page plus every older
  // page the reader has asked for, together with the resume cursor for the one
  // below. A task switch re-runs the request and resets it to the empty page, so
  // "load older" can never page into the thread that was open a moment ago.
  private readonly commentsResource = rxResource({
    params: () => ({ taskId: this.taskId() }),
    stream: ({ params }) => (params.taskId ? this.commentClient.list(params.taskId) : of(emptyPage())),
    defaultValue: emptyPage(),
  });
  private readonly page = computed<CommentPage>(() =>
    this.commentsResource.hasValue() ? this.commentsResource.value() : emptyPage(),
  );
  /** The loaded comments, oldest first — the order the thread reads in on screen. */
  protected readonly comments = computed(() => this.page().comments);
  /** Whether the server says older comments exist beyond what is loaded. */
  protected readonly hasMore = computed(() => this.page().hasMore);
  private readonly loadingOlder = signal(false);
  private readonly olderError = signal('');
  private readonly loadError = computed(() => (this.commentsResource.error() ? 'comments.loadError' : ''));
  private readonly actionError = signal('');
  protected readonly error = computed(() => this.actionError() || this.olderError() || this.loadError());
  // New comment form
  private readonly newBody = signal('');
  private readonly submitting = signal(false);
  // Inline edit state
  private readonly editingId = signal<string | null>(null);
  private readonly editBody = signal('');
  private readonly savingEdit = signal(false);
  /** Whether the inline edit editor has finished initializing (swap views only when ready) */
  private readonly editReady = signal(false);
  // Delete confirmation
  private readonly showDeleteConfirm = signal(false);
  private readonly commentToDelete = signal<Comment | null>(null);

  /**
   * Load the next (older) page and place it ABOVE the comments already shown.
   *
   * Each page arrives oldest-first, so prepending is what keeps the thread in
   * one continuous chronological order: the newest comment stays at the bottom
   * where it was, and older ones extend upwards. The page size is the shared
   * `COMMENT_PAGE_SIZE`, so one click is one server page — the client never
   * asks for "all comments".
   */
  protected loadOlder(): void {
    const cursor = this.page().nextCursor;

    // A page with no cursor is the end of the thread: there is nothing older to
    // ask for, and a second in-flight request would only duplicate one.
    if (!cursor || this.loadingOlder()) return;

    this.loadingOlder.set(true);
    this.olderError.set('');
    this.commentClient
      .list(this.taskId(), { limit: COMMENT_PAGE_SIZE, cursor })
      .pipe(finalize(() => this.loadingOlder.set(false)))
      .subscribe({
        next: (older) => {
          if (this.commentsResource.hasValue()) {
            this.commentsResource.value.update((current) => ({
              ...current,
              comments: [...older.comments, ...current.comments],
              hasMore: older.hasMore,
              nextCursor: older.nextCursor,
            }));
          } else {
            this.commentsResource.reload();
          }
        },
        error: () => {
          this.olderError.set('comments.loadOlderError');
        },
      });
  }

  protected submitComment(): void {
    const body = this.newBody().trim();

    if (!body) return;

    this.submitting.set(true);
    this.commentClient
      .create(this.taskId(), { body })
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: (comment) => {
          if (this.commentsResource.hasValue()) {
            this.commentsResource.value.update((page) => ({ ...page, comments: [...page.comments, comment] }));
          } else {
            this.commentsResource.reload();
          }
          this.newBody.set('');
          this.notify.success('toasts.created');
        },
        error: () => {
          this.actionError.set('comments.createError');
        },
      });
  }

  protected startEdit(comment: Comment): void {
    this.editingId.set(comment.id);
    this.editBody.set(comment.body);
    // Keep the display view visible until the edit editor signals readiness
    this.editReady.set(false);
  }

  private cancelEdit(): void {
    this.editingId.set(null);
    this.editBody.set('');
    this.editReady.set(false);
  }

  /** A comment is visually in edit mode only once its editor is initialized */
  protected isEditing(comment: Comment): boolean {
    return this.editingId() === comment.id && this.editReady();
  }

  protected onEditReady(): void {
    this.editReady.set(true);
  }

  protected saveEdit(commentId: string): void {
    const body = this.editBody().trim();

    if (!body) return;

    this.savingEdit.set(true);
    this.commentClient
      .update(commentId, { body })
      .pipe(finalize(() => this.savingEdit.set(false)))
      .subscribe({
        next: (updated) => {
          if (this.commentsResource.hasValue()) {
            this.commentsResource.value.update((page) => ({
              ...page,
              comments: page.comments.map((c) => (c.id === commentId ? updated : c)),
            }));
          } else {
            this.commentsResource.reload();
          }
          this.cancelEdit();
          this.notify.success('toasts.updated');
        },
        error: () => {
          this.actionError.set('comments.updateError');
        },
      });
  }

  protected confirmDelete(comment: Comment): void {
    this.commentToDelete.set(comment);
    this.showDeleteConfirm.set(true);
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteConfirm.set(false);
      this.commentToDelete.set(null);
    }
  }

  protected deleteComment(): void {
    const comment = this.commentToDelete();

    if (!comment) return;

    this.commentClient.delete(comment.id).subscribe({
      next: () => {
        if (this.commentsResource.hasValue()) {
          this.commentsResource.value.update((page) => ({
            ...page,
            comments: page.comments.filter((c) => c.id !== comment.id),
          }));
        } else {
          this.commentsResource.reload();
        }
        this.showDeleteConfirm.set(false);
        this.commentToDelete.set(null);
      },
      error: () => {
        this.actionError.set('comments.deleteError');
      },
    });
  }

  /** Whether the current user can edit/delete a specific comment */
  protected canModifyComment(comment: Comment): boolean {
    if (comment.authorId === this.currentUserId()) return true;

    // Moderators: project Editor+ or tenant Admin+ (see canWrite)
    return canWrite(this.projectStore.projectRole(), this.authStore.tenantRole());
  }
}
