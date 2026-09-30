/**
 * How many toasts a single failure may produce.
 *
 * The global `errorInterceptor` owns 5xx and network failures; a 4xx is the
 * caller's to report (AGENTS.md §UI). Nothing asserted that split, so the task
 * list and the board toasted a 5xx locally AND globally: two toasts for one
 * failure, on the two most-used surfaces.
 *
 * The property asserted here is the GLOBAL half — "a failure produces at most
 * one toast from the interceptor, and a 4xx produces none". The caller half
 * lives with the caller (`task-table.spec.ts` asserts a 5xx list failure is not
 * toasted locally and a 403 is). Together they mean exactly one toast per
 * failure; neither file pins a list of components or a number of toasts.
 */
import { firstValueFrom } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { errorInterceptor } from './error.interceptor';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import { toast } from '@spartan-ng/brain/sonner';

vi.mock('@spartan-ng/brain/sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('error toast count (D-41)', () => {
  let httpMock: HttpTestingController;
  let http: HttpClient;

  /** Number of error toasts raised since the last reset. */
  function toastCount(): number {
    return vi.mocked(toast.error).mock.calls.length;
  }

  /** Fire one request and fail it with `status` (0 = network failure). */
  function failRequest(status: number): void {
    http.get('/api/boards').subscribe({ error: () => undefined });

    const req = httpMock.expectOne('/api/boards');

    if (status === 0) {
      // A transport failure: no response, which HttpClient reports as status 0.
      req.error(new ProgressEvent('error'));

      return;
    }

    req.flush({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status, statusText: 'Failed' });
  }

  beforeEach(async () => {
    localStorage.clear();
    vi.mocked(toast.error).mockClear();

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([{ path: 'auth/login', redirectTo: '/' }]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: AuthStore, useValue: { logout: vi.fn() } },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    httpMock = TestBed.inject(HttpTestingController);
    http = TestBed.inject(HttpClient);

    // The interceptor imports sonner dynamically — let the import resolve
    // before any assertion on toast counts.
    await import('@spartan-ng/brain/sonner');
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    httpMock.verify();
  });

  // The table is a property table: each row states who OWNS the failure, and the
  // expectation follows from that ownership. Adding a status class is a new row,
  // not a change to an existing expectation.
  const CASES: { status: number; globalToasts: number; why: string }[] = [
    { status: 400, globalToasts: 0, why: 'a client error is the caller’s to report' },
    { status: 403, globalToasts: 0, why: 'forbidden is the caller’s to report' },
    { status: 404, globalToasts: 0, why: 'not found is the caller’s to report' },
    { status: 409, globalToasts: 0, why: 'a conflict is the caller’s to report' },
    { status: 422, globalToasts: 0, why: 'a validation error is the caller’s to report' },
    { status: 500, globalToasts: 1, why: 'a server error is the global layer’s' },
    { status: 502, globalToasts: 1, why: 'a bad gateway is the global layer’s' },
    { status: 503, globalToasts: 1, why: 'an unavailable service is the global layer’s' },
    { status: 0, globalToasts: 1, why: 'a network failure is the global layer’s' },
  ];

  for (const { status, globalToasts, why } of CASES) {
    it(`raises ${globalToasts} toast(s) for a ${status === 0 ? 'network failure' : status} — ${why}`, async () => {
      failRequest(status);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(toastCount()).toBe(globalToasts);
    });
  }

  it('raises exactly one toast per failure, not one per attempt', async () => {
    failRequest(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    failRequest(500);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toastCount()).toBe(2);
  });

  it('raises no toast at all for a successful request', async () => {
    http.get('/api/boards').subscribe();
    httpMock.expectOne('/api/boards').flush({ data: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toastCount()).toBe(0);
  });
});
