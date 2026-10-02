import { Service, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '@app/api-url.token';
import { COMMENT_PAGE_SIZE } from '@task-board/shared';
import type { Comment, CommentPage, CreateComment, UpdateComment } from '@task-board/shared';

/** One page request for a task's comment thread. */
export interface CommentPageQuery {
  /** Comments per page (server maximum is `COMMENT_PAGE_SIZE`). */
  limit?: number;
  /** Opaque `nextCursor` of the page below this one; omit for the newest page. */
  cursor?: string;
}

/** Pure HTTP client for comment endpoints — no state management. */
@Service()
export class CommentClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /**
   * One page of a task's comments.
   *
   * The thread is walked from the NEWEST comment backwards, so the first request
   * (no cursor) is the one that matters for what the reader sees first; each
   * page is ordered oldest-first inside itself, and a follow-up page goes ABOVE
   * what is already on screen. `nextCursor` is opaque and is passed back
   * verbatim — this client never decodes it.
   */
  list(taskId: string, query: CommentPageQuery = {}): Observable<CommentPage> {
    let params = new HttpParams().set('limit', query.limit ?? COMMENT_PAGE_SIZE);

    if (query.cursor) params = params.set('cursor', query.cursor);

    return this.http
      .get<{ data: Comment[]; pagination: Omit<CommentPage, 'comments'> }>(`${this.baseUrl}/tasks/${taskId}/comments`, {
        params,
      })
      .pipe(map((res) => ({ comments: res.data, ...res.pagination })));
  }

  /** Create a new comment on a task */
  create(taskId: string, data: CreateComment): Observable<Comment> {
    return this.http
      .post<{ data: Comment }>(`${this.baseUrl}/tasks/${taskId}/comments`, data)
      .pipe(map((res) => res.data));
  }

  /** Update an existing comment */
  update(commentId: string, data: UpdateComment): Observable<Comment> {
    return this.http
      .patch<{ data: Comment }>(`${this.baseUrl}/comments/${commentId}`, data)
      .pipe(map((res) => res.data));
  }

  /** Delete a comment */
  delete(commentId: string): Observable<{ success: true }> {
    return this.http
      .delete<{ data: { success: true } }>(`${this.baseUrl}/comments/${commentId}`)
      .pipe(map((res) => res.data));
  }
}
