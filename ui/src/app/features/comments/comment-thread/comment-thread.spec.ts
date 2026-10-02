/**
 * Tests for the CommentThread component.
 *
 * Covers:
 * - Loading the NEWEST page of comments on init (one request, no cursor)
 * - Loading older pages with the server cursor, prepended above what is loaded
 * - Submitting a new comment
 * - Inline edit flow
 * - Delete with confirmation
 * - canModifyComment permission check
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { CommentThread } from './comment-thread';
import { CommentClient } from '@services/comment-client';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import { COMMENT_PAGE_SIZE } from '@task-board/shared';
import type { Comment, CommentPage } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';
const mockComments: Comment[] = [
  {
    id: 'c1',
    taskId: 'tk1',
    authorId: 'u1',
    authorSnapshot: { displayName: 'Alice' },
    body: 'First comment',
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'c2',
    taskId: 'tk1',
    authorId: 'u2',
    authorSnapshot: { displayName: 'Bob' },
    body: 'Second comment',
    createdAt: NOW,
    updatedAt: '2025-01-02T00:00:00Z',
  },
];

/** One page as the server returns it, with the cursor fields a client echoes back. */
function makePage(comments: Comment[], overrides: Partial<CommentPage> = {}): CommentPage {
  return { comments, hasMore: false, nextCursor: null, limit: COMMENT_PAGE_SIZE, ...overrides };
}

describe('CommentThread', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let commentClientMock: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  async function setup(
    opts: { comments?: Comment[]; page?: Partial<CommentPage>; canEdit?: boolean; taskId?: string } = {},
  ) {
    const { comments = mockComments, page, canEdit = false, taskId = 'tk1' } = opts;

    commentClientMock = {
      list: vi.fn().mockReturnValue(of(makePage(comments, page))),
      create: vi.fn().mockReturnValue(
        of({
          id: 'c3',
          taskId: 'tk1',
          authorId: 'u1',
          authorSnapshot: { displayName: 'Alice' },
          body: 'New comment',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
      update: vi.fn().mockReturnValue(
        of({
          id: 'c1',
          taskId: 'tk1',
          authorId: 'u1',
          authorSnapshot: { displayName: 'Alice' },
          body: 'Updated body',
          createdAt: NOW,
          updatedAt: '2025-01-02T00:00:00Z',
        }),
      ),
      delete: vi.fn().mockReturnValue(of({ success: true })),
    };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: CommentClient, useValue: commentClientMock },
        {
          provide: AuthStore,
          useValue: {
            tenantRole: vi.fn().mockReturnValue(canEdit ? 'ADMIN' : null),
            currentUser: vi.fn().mockReturnValue(null),
          },
        },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(CommentThread);

    fixture.componentRef.setInput('taskId', taskId);
    fixture.componentRef.setInput('currentUserId', 'u1');
    fixture.componentRef.setInput('canEdit', canEdit);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  // ── Loading ─────────────────────────────────────────────────────
  // A blank taskId (the route segment is not bound yet) must not produce
  // `commentClient.list('')` — that request returns the SPA-fallback HTML.
  it('should NOT load comments while the task id is blank (F21)', async () => {
    await setup({ taskId: '' });

    expect(commentClientMock.list).not.toHaveBeenCalled();
    expect(component.comments()).toEqual([]);
  });

  it('should load comments on init', async () => {
    await setup();
    expect(commentClientMock.list).toHaveBeenCalledWith('tk1');
    expect(component.comments()).toHaveLength(2);
  });

  it('should handle load error', async () => {
    commentClientMock = {
      list: vi.fn().mockReturnValue(throwError(() => new Error('fail'))),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: CommentClient, useValue: commentClientMock },
        {
          provide: AuthStore,
          useValue: { tenantRole: vi.fn().mockReturnValue(null), currentUser: vi.fn().mockReturnValue(null) },
        },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(CommentThread);

    fixture.componentRef.setInput('taskId', 'tk1');
    fixture.componentRef.setInput('currentUserId', 'u1');
    fixture.componentRef.setInput('canEdit', false);

    component = fixture.componentInstance;
    await settle(fixture);

    expect(component.error()).toBe('comments.loadError');
  });

  // ── Create ──────────────────────────────────────────────────────
  it('should submit a new comment', async () => {
    await setup();
    component.newBody.set('New comment');
    component.submitComment();
    expect(commentClientMock.create).toHaveBeenCalledWith('tk1', { body: 'New comment' });
    expect(component.comments()).toHaveLength(3);
    expect(component.newBody()).toBe('');
  });

  it('should not submit empty comment', async () => {
    await setup();
    component.newBody.set('   ');
    component.submitComment();
    expect(commentClientMock.create).not.toHaveBeenCalled();
  });

  // ── Pagination ────────────────────────────────────────────────
  // The mocked client resolves synchronously, so an action is observable right
  // after the call — no timer and no `detectChanges()` in the way.
  const olderPage: Comment[] = mockComments.map((c, i) => ({ ...c, id: `c-old-${i}`, body: `Older ${i}` }));

  it('should fetch only the newest page on init — no cursor, one request', async () => {
    await setup({ page: { hasMore: true, nextCursor: 'cursor-1' } });

    expect(commentClientMock.list).toHaveBeenCalledTimes(1);
    // No cursor on the first request: the newest page is the whole first read.
    expect(commentClientMock.list).toHaveBeenCalledWith('tk1');
    expect(component.comments().map((c: Comment) => c.id)).toEqual(['c1', 'c2']);
  });

  it('should report hasMore while the server says older comments exist', async () => {
    await setup({ page: { hasMore: true, nextCursor: 'cursor-1' } });

    expect(component.hasMore()).toBe(true);
  });

  it('should report no more comments when the first page is the whole thread', async () => {
    await setup();

    expect(component.hasMore()).toBe(false);
  });

  it('should request the next page with the server cursor and PREPEND it above the loaded comments', async () => {
    await setup({ page: { hasMore: true, nextCursor: 'cursor-1' } });
    commentClientMock.list.mockReturnValue(of(makePage(olderPage, { hasMore: false, nextCursor: null })));

    component.loadOlder();

    expect(commentClientMock.list).toHaveBeenLastCalledWith('tk1', { limit: COMMENT_PAGE_SIZE, cursor: 'cursor-1' });
    // The thread still reads oldest-first: the older page extends upwards and
    // the newest comment stays at the bottom where it always was.
    expect(component.comments().map((c: Comment) => c.id)).toEqual(['c-old-0', 'c-old-1', 'c1', 'c2']);
    expect(component.hasMore()).toBe(false);
  });

  it('should stop asking once the thread is exhausted', async () => {
    await setup({ page: { hasMore: true, nextCursor: 'cursor-1' } });
    commentClientMock.list.mockReturnValue(of(makePage(olderPage, { hasMore: false, nextCursor: null })));

    component.loadOlder();
    component.loadOlder();

    expect(commentClientMock.list).toHaveBeenCalledTimes(2);
  });

  it('should not request anything when the first page already holds the whole thread', async () => {
    await setup();

    component.loadOlder();

    expect(commentClientMock.list).toHaveBeenCalledTimes(1);
  });

  it('should surface a failed older-page load and keep the loaded comments', async () => {
    await setup({ page: { hasMore: true, nextCursor: 'cursor-1' } });
    commentClientMock.list.mockReturnValue(throwError(() => new Error('fail')));

    component.loadOlder();

    expect(component.error()).toBe('comments.loadOlderError');
    expect(component.comments()).toHaveLength(2);
  });

  // ── Edit ────────────────────────────────────────────────────────
  it('should start and cancel inline edit', async () => {
    await setup();

    const comment = component.comments()[0];

    component.startEdit(comment);
    expect(component.editingId()).toBe('c1');
    expect(component.editBody()).toBe('First comment');

    component.cancelEdit();
    expect(component.editingId()).toBeNull();
    expect(component.editBody()).toBe('');
  });

  it('should save an edited comment', async () => {
    await setup();
    component.startEdit(component.comments()[0]);
    component.editBody.set('Updated body');
    component.saveEdit('c1');
    expect(commentClientMock.update).toHaveBeenCalledWith('c1', { body: 'Updated body' });
    expect(component.editingId()).toBeNull();
  });

  // ── Delete ──────────────────────────────────────────────────────
  it('should confirm and delete a comment', async () => {
    await setup();

    const comment = component.comments()[0];

    component.confirmDelete(comment);
    expect(component.showDeleteConfirm()).toBe(true);
    expect(component.commentToDelete()?.id).toBe('c1');

    component.deleteComment();
    expect(commentClientMock.delete).toHaveBeenCalledWith('c1');
    expect(component.comments()).toHaveLength(1);
    expect(component.showDeleteConfirm()).toBe(false);
  });

  // ── Permissions ─────────────────────────────────────────────────
  it('should allow author to modify own comment', async () => {
    await setup();

    const ownComment = component.comments()[0]; // authorId = u1

    expect(component.canModifyComment(ownComment)).toBe(true);
  });

  it('should not allow non-author to modify comment without canEdit', async () => {
    await setup();

    const otherComment = component.comments()[1]; // authorId = u2

    expect(component.canModifyComment(otherComment)).toBe(false);
  });

  it('should allow admin to modify any comment when canEdit is true', async () => {
    await setup({ canEdit: true });

    const otherComment = component.comments()[1]; // authorId = u2

    expect(component.canModifyComment(otherComment)).toBe(true);
  });
});
