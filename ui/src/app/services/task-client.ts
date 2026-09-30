import { Service, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '@app/api-url.token';
import type {
  Task,
  BoardTask,
  BoardPage,
  CreateTask,
  UpdateTask,
  BulkUpdateTasks,
  BulkUpdateTasksResult,
} from '@task-board/shared';

/**
 * Query params for filtering tasks.
 *
 * Every optional field carries `| undefined`. `TaskTable.taskQuery` is a
 * `computed` that always returns the FULL filter set, using `undefined` for
 * "no filter" (`filterStatus() || undefined`), and `exactOptionalPropertyTypes`
 * forbids that on a bare `field?: T`. `fetchList` already treats `undefined`
 * and "absent" identically (it only serialises truthy values), so this is a
 * type-level statement of the existing runtime contract, not a behaviour change.
 */
export interface TaskQuery {
  projectId?: string | undefined;
  /** Exact sprint — mutually exclusive with `hasSprint` (server rejects both together). */
  sprintId?: string | null | undefined;
  /**
   * Tri-state "has a sprint" filter, mirroring the server's
   * `TaskQuerySchema.hasSprint`. `false` requests the BACKLOG (tasks with no
   * sprint) — previously inexpressible, so the Sprints page counter silently
   * fell back to "all project tasks". `undefined` sends no filter at all.
   */
  hasSprint?: boolean | undefined;
  assigneeId?: string | undefined;
  reporterId?: string | undefined;
  statusId?: string | undefined;
  priorityLevel?: number | undefined;
  typeId?: string | undefined;
  labelId?: string | undefined;
  search?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
  /** Sort field and direction, e.g. "createdAt:desc" */
  sort?: string | undefined;
  /** Board view: lightweight card projection (dedicated BoardTask DTO) */
  view?: 'board' | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`) range filters */
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  /**
   * Omit `description` from the response (~40% smaller
   * payload for lists). Only views that render the description (the board's
   * task-card preview) must NOT set this.
   */
  excludeDescription?: boolean | undefined;
}

/** Paginated list response shape */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Board column pages request — opaque resume cursors by column id plus board filters */
export interface BoardPageQuery {
  cursors?: Record<string, string>;
  sprintId?: string | null;
  assigneeId?: string;
  priorityLevel?: number;
}

/**
 * Map a full task to the lightweight board card DTO — the same 10-field
 * shape the server board projection returns (used after DnD mutations, which
 * return the full task).
 */
export function toBoardTask(task: Task): BoardTask {
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    typeId: task.typeId,
    statusId: task.statusId,
    priorityLevel: task.priorityLevel,
    assigneeId: task.assigneeId,
    assigneeSnapshot: task.assigneeSnapshot,
    version: task.version,
  };
}

@Service()
export class TaskClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /** List tasks with optional filters (paginated — keep full envelope) */
  list(projectId: string, query: TaskQuery = {}): Observable<PaginatedResponse<Task>> {
    return this.fetchList<Task>(projectId, query);
  }

  /**
   * Board column pages: one request serves every requested column (fixed
   * `BOARD_PAGE_SIZE` cards per column, cursor/keyset pagination).
   * `cursors` carries opaque `nextCursor` strings by column id — absent
   * entries load the first page, so `{}` is the initial load of all columns.
   */
  listBoardPages(projectId: string, query: BoardPageQuery = {}): Observable<BoardPage> {
    let params = new HttpParams();

    for (const [columnId, cursor] of Object.entries(query.cursors ?? {})) {
      params = params.set(`cursor.${columnId}`, cursor);
    }

    if (query.sprintId?.trim()) params = params.set('sprintId', query.sprintId.trim());
    if (query.assigneeId) params = params.set('assigneeId', query.assigneeId);
    if (query.priorityLevel !== undefined) params = params.set('priorityLevel', String(query.priorityLevel));

    return this.http
      .get<{ data: BoardPage }>(`${this.baseUrl}/projects/${projectId}/tasks/board`, { params })
      .pipe(map((res) => res.data));
  }

  private fetchList<T>(projectId: string, query: TaskQuery): Observable<PaginatedResponse<T>> {
    let params = new HttpParams();

    // `sprintId: null` (and any blank value) means "absent" and the
    // parameter must be OMITTED, not sent as `sprintId=`. The server's
    // `TaskQuerySchema.sprintId` is `uuid().optional()` — an empty string fails
    // validation, so the whole request 400s. Same "empty means absent"
    // convention as every other param below; the trim() keeps a whitespace-only
    // value out of the query too, since `'   '` is truthy in JS but is not a
    // valid id either. To filter BY the backlog, pass `hasSprint: false` —
    // omitting `sprintId` means "no sprint filtering", not "no sprint".
    if (query.sprintId?.trim()) params = params.set('sprintId', query.sprintId.trim());
    if (query.hasSprint !== undefined) params = params.set('hasSprint', String(query.hasSprint));
    if (query.assigneeId) params = params.set('assigneeId', query.assigneeId);
    if (query.reporterId) params = params.set('reporterId', query.reporterId);
    if (query.statusId) params = params.set('statusId', query.statusId);
    if (query.priorityLevel !== undefined) params = params.set('priorityLevel', String(query.priorityLevel));
    if (query.typeId) params = params.set('typeId', query.typeId);
    if (query.labelId) params = params.set('labelId', query.labelId);
    if (query.search) params = params.set('search', query.search);
    if (query.createdFrom) params = params.set('createdFrom', query.createdFrom);
    if (query.createdTo) params = params.set('createdTo', query.createdTo);
    if (query.updatedFrom) params = params.set('updatedFrom', query.updatedFrom);
    if (query.updatedTo) params = params.set('updatedTo', query.updatedTo);
    if (query.page) params = params.set('page', query.page.toString());
    if (query.limit) params = params.set('limit', query.limit.toString());
    if (query.sort) params = params.set('sort', query.sort);
    if (query.excludeDescription) params = params.set('excludeDescription', 'true');
    if (query.view) params = params.set('view', query.view);
    return this.http.get<PaginatedResponse<T>>(`${this.baseUrl}/projects/${projectId}/tasks`, { params });
  }

  /** Per-status task counts for the project overview (one aggregation) */
  statusSummary(projectId: string): Observable<{ statusId: string; count: number }[]> {
    return this.http
      .get<{ data: { statusId: string; count: number }[] }>(
        `${this.baseUrl}/projects/${projectId}/tasks/status-summary`,
      )
      .pipe(map((res) => res.data));
  }

  /** Get a single task by ID */
  getById(id: string): Observable<Task> {
    return this.http.get<{ data: Task }>(`${this.baseUrl}/tasks/${id}`).pipe(map((res) => res.data));
  }

  /** Create a new task */
  create(projectId: string, data: CreateTask): Observable<Task> {
    return this.http
      .post<{ data: Task }>(`${this.baseUrl}/projects/${projectId}/tasks`, data)
      .pipe(map((res) => res.data));
  }

  /** Update an existing task (version required for optimistic concurrency) */
  update(id: string, data: UpdateTask): Observable<Task> {
    return this.http.patch<{ data: Task }>(`${this.baseUrl}/tasks/${id}`, data).pipe(map((res) => res.data));
  }

  /** Bulk status/assignee/sprint update for the tasks table */
  bulkUpdate(projectId: string, body: BulkUpdateTasks): Observable<BulkUpdateTasksResult> {
    return this.http
      .patch<{ data: BulkUpdateTasksResult }>(`${this.baseUrl}/projects/${projectId}/tasks/bulk`, body)
      .pipe(map((res) => res.data));
  }

  /** Delete a task */
  delete(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ data: { success: boolean } }>(`${this.baseUrl}/tasks/${id}`).pipe(map((res) => res.data));
  }

  // ─── Cross-Tenant "My Tasks" ──────────────────────────────────────────────

  /**
   * Get tasks assigned to the current user across all tenants.
   * Returns plain `Task` objects — the caller resolves tenant/project context.
   */
  getMyTasks(): Observable<Task[]> {
    return this.http.get<{ data: Task[] }>(`${this.baseUrl}/tasks/my`).pipe(map((res) => res.data));
  }
}
