import { firstValueFrom } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { errorInterceptor } from './error.interceptor';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';

describe('errorInterceptor', () => {
  let httpMock: HttpTestingController;
  let http: HttpClient;

  beforeEach(async () => {
    localStorage.clear();

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([{ path: 'auth/login', redirectTo: '/' }]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    httpMock = TestBed.inject(HttpTestingController);
    http = TestBed.inject(HttpClient);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should call authStore.logout() on 401', () => {
    const store = TestBed.inject(AuthStore);
    const logoutSpy = vi.spyOn(store, 'logout');

    // Set a token so logout has something to clear
    store.setSession({
      token: 'test',
      user: {
        id: '1',
        email: 'a@b.com',
        displayName: 'A',
        avatarUrl: null,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
      },
    });

    http.get('/api/boards').subscribe({
      error: (err) => {
        expect(err.status).toBe(401);
      },
    });

    const req = httpMock.expectOne('/api/boards');

    req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

    expect(logoutSpy).toHaveBeenCalled();
    expect(store.token()).toBeNull();
  });

  it('should pass through successful responses', () => {
    http.get<{ id: string }>('/api/boards').subscribe((res) => {
      expect(res.id).toBe('board-1');
    });

    const req = httpMock.expectOne('/api/boards');

    req.flush({ id: 'board-1' });
  });

  it('should handle structured VALIDATION_ERROR response', () => {
    const errorBody = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { email: 'Invalid email format' },
      },
    };

    http.get('/api/boards').subscribe({
      error: (err) => {
        expect(err.status).toBe(422);
        expect(err.userMessage).toBe('errors.validation');
      },
    });

    const req = httpMock.expectOne('/api/boards');

    req.flush(errorBody, { status: 422, statusText: 'Unprocessable Entity' });
  });

  it('should map INVALID_CREDENTIALS to neutral invalid-credentials copy (V1-8)', () => {
    const errorBody = {
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
    };

    http.post('/api/auth/login', {}).subscribe({
      error: (err) => {
        expect(err.status).toBe(401);
        expect(err.userMessage).toBe('errors.invalidCredentials');
      },
    });

    const req = httpMock.expectOne('/api/auth/login');

    req.flush(errorBody, { status: 401, statusText: 'Unauthorized' });
  });

  it('should handle structured NOT_FOUND response', () => {
    const errorBody = {
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
      },
    };

    http.get('/api/tasks/999').subscribe({
      error: (err) => {
        expect(err.status).toBe(404);
        expect(err.userMessage).toBe('errors.notFound');
      },
    });

    const req = httpMock.expectOne('/api/tasks/999');

    req.flush(errorBody, { status: 404, statusText: 'Not Found' });
  });

  it('should handle structured TASK_VERSION_CONFLICT response', () => {
    const errorBody = {
      error: {
        code: 'TASK_VERSION_CONFLICT',
        message: 'Task has been modified by another user',
      },
    };

    http.patch('/api/tasks/1', {}).subscribe({
      error: (err) => {
        expect(err.status).toBe(409);
        expect(err.userMessage).toBe('errors.taskVersionConflict');
      },
    });

    const req = httpMock.expectOne('/api/tasks/1');

    req.flush(errorBody, { status: 409, statusText: 'Conflict' });
  });

  it('should handle 403 permission denied', () => {
    const errorBody = {
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission',
      },
    };

    http.delete('/api/tenants/1').subscribe({
      error: (err) => {
        expect(err.status).toBe(403);
        expect(err.userMessage).toBe('errors.forbidden');
      },
    });

    const req = httpMock.expectOne('/api/tenants/1');

    req.flush(errorBody, { status: 403, statusText: 'Forbidden' });
  });

  // This case USED TO assert that an unknown code surfaces the server's
  // English prose as the user-facing message. That is the defect: the string was
  // handed to the translation pipeline, so the user saw untranslated English on
  // exactly the conditions (two of them 5xx) an operator most wants read. The
  // replacement asserts the correct behaviour — a transloco key — and that the
  // server's prose is NOT what reaches the UI.
  it('should map an unknown error code to a transloco key, never to the server prose', () => {
    const errorBody = {
      error: {
        code: 'UNKNOWN_CODE',
        message: 'Something went wrong',
      },
    };
    // Asserted AFTER the flush, not inside the callback: an assertion inside an
    // `error:` handler that never fires is a test that passes for the wrong
    // reason — and this file's older cases have exactly that shape.
    let userMessage: string | undefined;
    let serverText: string | undefined;

    http.get('/api/boards').subscribe({
      error: (err) => {
        userMessage = err.userMessage;
        serverText = (err.error as typeof errorBody).error.message;
      },
    });

    const req = httpMock.expectOne('/api/boards');

    req.flush(errorBody, { status: 500, statusText: 'Internal Server Error' });

    expect(userMessage).toBe('errors.unknown');
    expect(userMessage).not.toBe(errorBody.error.message);
    // The raw server text is still on the error for logging, not for display.
    expect(serverText).toBe('Something went wrong');
  });

  it('should map each of the codes the client used to be missing (D-32)', () => {
    const cases = [
      { code: 'INVALID_RESET_TOKEN', key: 'errors.invalidResetToken', status: 400 },
      { code: 'RATE_LIMITED', key: 'errors.rateLimited', status: 429 },
      { code: 'QUERY_TIMEOUT', key: 'errors.queryTimeout', status: 503 },
      { code: 'TASK_NUMBER_UNAVAILABLE', key: 'errors.taskNumberUnavailable', status: 503 },
      // The body cap's own code. Without this entry a 413 would fall through to
      // `errors.unknown` — a raw-code-shaped failure the user cannot act on.
      { code: 'PAYLOAD_TOO_LARGE', key: 'errors.payloadTooLarge', status: 413 },
    ];

    for (const { code, key, status } of cases) {
      let message = '';

      http.get(`/api/case-${code}`).subscribe({
        error: (err) => {
          message = err.userMessage ?? '';
        },
      });
      httpMock
        .expectOne(`/api/case-${code}`)
        .flush({ error: { code, message: 'server prose' } }, { status, statusText: 'Failed' });

      expect(message, `${code} → ${key}`).toBe(key);
    }
  });
});
