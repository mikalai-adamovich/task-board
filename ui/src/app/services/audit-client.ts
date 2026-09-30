import { Service, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '@app/api-url.token';
import type { AuditEvent, AuditEntityType, AuditAction, SortDirection, PaginatedResponse } from '@task-board/shared';

/**
 * List filters — all optional, URL-synced by the AuditLogViewer.
 *
 * `action` was a hand-copied `'CREATED' | 'UPDATED' | 'DELETED'` and `sort`
 * a hand-copied `'asc' | 'desc'`; both are the shared `AuditAction` /
 * `SortDirection` unions the server's `AuditQuerySchema` validates against, so
 * the client can no longer send a value the server would reject. `| undefined`
 * is required because the viewer builds the params object with
 * `signal() || undefined` for "no filter".
 */
export interface AuditListParams {
  page?: number | undefined;
  limit?: number | undefined;
  entityType?: AuditEntityType | undefined;
  action?: AuditAction | undefined;
  /** Actor user id */
  actorId?: string | undefined;
  /** Time sort direction — server default is desc (newest first) */
  sort?: SortDirection | undefined;
}

/**
 * Pure HTTP client for audit endpoints — no state management.
 * All methods return Observables; the AuditLogViewer handles orchestration.
 *
 * NOTE: Audit responses are paginated — the full envelope { data, pagination }
 * is kept as-is per the project convention.
 */
@Service()
export class AuditClient {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  private buildParams(params: AuditListParams): HttpParams {
    let httpParams = new HttpParams()
      .set('page', (params.page ?? 1).toString())
      .set('limit', (params.limit ?? 20).toString());

    if (params.entityType) httpParams = httpParams.set('entityType', params.entityType);
    if (params.action) httpParams = httpParams.set('action', params.action);
    if (params.actorId) httpParams = httpParams.set('actorId', params.actorId);
    if (params.sort) httpParams = httpParams.set('sort', params.sort);

    return httpParams;
  }

  /** List audit events for a project (paginated, enriched with human-readable labels) */
  listByProject(projectId: string, params: AuditListParams = {}): Observable<PaginatedResponse<AuditEvent>> {
    return this.http.get<PaginatedResponse<AuditEvent>>(`${this.apiBaseUrl}/projects/${projectId}/audit`, {
      params: this.buildParams(params),
    });
  }

  // `listByTenant()` was removed as dead code — the audit log is only ever
  // opened per project (`listByProject`). Note the `listByTenant` identifiers in
  // `sprint-list.spec.ts` are a SprintClient mock, a different object.
}
