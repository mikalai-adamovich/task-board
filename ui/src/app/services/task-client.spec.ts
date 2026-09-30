/**
 * Tests for TaskClient query-param construction.
 *
 * Regression: the list request used to send `sprintId=` (an empty
 * string) whenever the caller passed `sprintId: null`. The server's
 * `TaskQuerySchema.sprintId` is `uuid().optional()`, so the empty string failed
 * validation → 400 on every visit to the Sprints page, which then rendered a
 * false "Backlog — 0 tasks" on a project with thousands of tasks.
 *
 * The invariant locked in here: a blank/absent filter value means the parameter
 * is OMITTED, never sent as an empty value. "Empty means absent" is the
 * convention the rest of the client (and every other *-client.ts) already uses.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { API_BASE_URL } from '@app/api-url.token';
import { TaskClient } from './task-client';

describe('TaskClient list query params', () => {
  let httpMock: HttpTestingController;
  let client: TaskClient;
  const listUrl = 'https://api.test/api/projects/project-1/tasks';
  const boardUrl = 'https://api.test/api/projects/project-1/tasks/board';
  /**
   * Match on the path only: `expectOne(url)` compares against the FULL url
   * including the serialized query string, so it cannot distinguish
   * "sprintId absent" from "sprintId present but empty".
   */
  const byUrl = (url: string) => (req: { url: string }) => req.url === url;
  const emptyPage = { data: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 0 } };

  beforeEach(() => {
    // Zoneless Angular 22 unit-test builder: TestBed is NOT auto-torn-down
    // between tests, so reset explicitly before reconfiguring.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    client = TestBed.inject(TaskClient);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('sprintId (M-028 / M-255)', () => {
    it('omits the sprintId param entirely when sprintId is null (the Sprints-page call)', () => {
      // The call this test was written for — `sprintId: null, limit: 1` from
      // sprint-list.ts — used to serialize as `?limit=1&sprintId=` and 400.
      // F7 changed that call site to `hasSprint: false` (see the hasSprint
      // block below), but the "blank means absent" rule is unchanged and still
      // applies to every other `sprintId: null` caller.
      client.list('project-1', { sprintId: null, limit: 1 }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      // Regression guard: the param must not be present AT ALL. `get()`
      // returning null would NOT catch `sprintId=` — HttpParams serializes an
      // empty value as a present-but-empty key, which is exactly the 400 case.
      expect(req.request.params.keys()).toEqual(['limit']);
      req.flush(emptyPage);
    });

    it('omits the sprintId param when sprintId is an empty string', () => {
      client.list('project-1', { sprintId: '' }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys()).toEqual([]);
      req.flush(emptyPage);
    });

    it('omits the sprintId param when sprintId is whitespace', () => {
      client.list('project-1', { sprintId: '   ' }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys()).toEqual([]);
      req.flush(emptyPage);
    });

    it('keeps the other params when sprintId is null (only the blank one is dropped)', () => {
      client.list('project-1', { sprintId: null, limit: 1, excludeDescription: true }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys().sort()).toEqual(['excludeDescription', 'limit']);
      expect(req.request.params.get('limit')).toBe('1');
      expect(req.request.params.get('excludeDescription')).toBe('true');
      req.flush(emptyPage);
    });

    it('still sends a real sprintId', () => {
      client.list('project-1', { sprintId: 'a1b2c3d4-1111-4222-8333-444455556666' }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys()).toEqual(['sprintId']);
      expect(req.request.params.get('sprintId')).toBe('a1b2c3d4-1111-4222-8333-444455556666');
      req.flush(emptyPage);
    });
  });

  /**
   * The explicit "no sprint" (backlog) filter.
   *
   * The whole point of the new param: `sprintId` omitted means "no sprint
   * filtering" (every project task), NOT "tasks without a sprint". The Sprints
   * page Backlog counter therefore needs its own `hasSprint=false` request,
   * which must survive serialization as the literal string `'false'` — NOT be
   * dropped by the "blank means absent" convention, and NOT collapse to `true`
   * through a naive truthiness check.
   */
  describe('hasSprint (F7 — the backlog filter)', () => {
    it('sends hasSprint=false (the Sprints-page Backlog call)', () => {
      client.list('project-1', { hasSprint: false, limit: 1 }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys().sort()).toEqual(['hasSprint', 'limit']);
      expect(req.request.params.get('hasSprint')).toBe('false');
      expect(req.request.params.get('limit')).toBe('1');
      req.flush(emptyPage);
    });

    it('sends hasSprint=true when the caller asks for sprinted tasks only', () => {
      client.list('project-1', { hasSprint: true }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.get('hasSprint')).toBe('true');
      req.flush(emptyPage);
    });

    it('omits the param entirely when hasSprint is undefined (no sprint filtering)', () => {
      client.list('project-1', { limit: 1 }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys()).toEqual(['limit']);
      req.flush(emptyPage);
    });

    it('sends hasSprint=false even when a blank sprintId is also passed (the two are separate filters)', () => {
      // The server rejects sprintId + hasSprint together, but a blank sprintId is
      // omitted before the request leaves — so this stays a valid backlog query.
      client.list('project-1', { sprintId: null, hasSprint: false, limit: 1 }).subscribe();

      const req = httpMock.expectOne(byUrl(listUrl));

      expect(req.request.params.keys().sort()).toEqual(['hasSprint', 'limit']);
      req.flush(emptyPage);
    });

    it('does not add hasSprint to the board-page request (the board has no backlog column)', () => {
      client.listBoardPages('project-1', { sprintId: 'a1b2c3d4-1111-4222-8333-444455556666' }).subscribe();

      const req = httpMock.expectOne(byUrl(boardUrl));

      expect(req.request.params.keys()).toEqual(['sprintId']);
      req.flush({ data: {} });
    });
  });

  describe('board pages (listBoardPages)', () => {
    it('omits a blank sprintId on the board-page request too', () => {
      client.listBoardPages('project-1', { sprintId: '' }).subscribe();

      const req = httpMock.expectOne(byUrl(boardUrl));

      expect(req.request.params.keys()).toEqual([]);
      req.flush({ data: {} });
    });
  });
});
