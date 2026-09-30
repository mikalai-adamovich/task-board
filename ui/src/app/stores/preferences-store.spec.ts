import { firstValueFrom } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { importProvidersFrom } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { PreferencesStore } from './preferences-store';
import { AuthStore } from './auth-store';
import { ThemeLoader } from '@services/theme-loader';
import { ThemeRegistry } from '@services/theme-registry';
import { API_BASE_URL } from '@app/api-url.token';
import type {
  TaskTableColumnKey,
  ThemeManifestItem,
  User,
  UserPreferences,
  UserProjectBoardPreference,
} from '@task-board/shared';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('PreferencesStore (theme mode model)', () => {
  let httpMock: HttpTestingController;
  let themeLoader: { loadTheme: ReturnType<typeof vi.fn> };
  const manifestItem = (id: string, mode: 'light' | 'dark'): ThemeManifestItem => ({
    id,
    name: id,
    mode,
    css: `${id}.css`,
    preview: { primary: '#000', muted: '#111', foreground: '#222', card: '#333', border: '#444' },
  });

  async function createModule() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        importProvidersFrom(
          TranslocoTestingModule.forRoot({
            preloadLangs: true,
            langs: { en: {}, pl: {}, de: {} },
            translocoConfig: { availableLangs: ['en', 'pl', 'de'], defaultLang: 'en' },
          }),
        ),
        { provide: ThemeLoader, useValue: { loadTheme: vi.fn() } },
        {
          provide: ThemeRegistry,
          useValue: {
            load: vi.fn(async () => undefined),
            findById: vi.fn((id: string) => (id === 'nord' ? manifestItem('nord', 'dark') : undefined)),
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    httpMock = TestBed.inject(HttpTestingController);
    themeLoader = TestBed.inject(ThemeLoader) as unknown as { loadTheme: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('font-size');
  });

  afterEach(() => {
    httpMock?.verify();
    localStorage.clear();
    document.documentElement.style.removeProperty('font-size');
  });

  function seedAuthUser(store: AuthStore): void {
    store.setSession({
      token: 'fake-jwt',
      user: { id: 'user-1', email: 'test@example.com', displayName: 'Test' } as User,
    });
  }

  it('should default to Auto mode with browser-driven resolution', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    expect(store.themeMode()).toBe('auto');
    expect(store.lightTheme()).toBeNull();
    expect(store.darkTheme()).toBeNull();
    // jsdom has no matchMedia → system scheme treated as light → default light theme.
    expect(store.effectiveTheme()).toBe('light');
    expect(themeLoader.loadTheme).toHaveBeenCalledWith('light');
  });

  it('should restore mode-aware theme preferences from localStorage', async () => {
    localStorage.setItem(
      'taskboard_theme_v2',
      JSON.stringify({ themeMode: 'dark', lightTheme: null, darkTheme: 'nord' }),
    );
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    expect(store.themeMode()).toBe('dark');
    expect(store.darkTheme()).toBe('nord');
    expect(store.effectiveTheme()).toBe('nord');
    expect(themeLoader.loadTheme).toHaveBeenCalledWith('nord');
  });

  it('should apply the resolved theme at bootstrap even with nothing persisted (P8-13)', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    expect(store.effectiveTheme()).toBe('light');
    expect(themeLoader.loadTheme).toHaveBeenCalledWith('light');
  });

  it('should resolve auto mode from the system color-scheme signal', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    store.systemPrefersDark.set(true);
    expect(store.effectiveTheme()).toBe('dark');

    store.systemPrefersDark.set(false);
    expect(store.effectiveTheme()).toBe('light');
  });

  it('should resolve explicit light/dark modes from the per-mode choices', async () => {
    localStorage.setItem(
      'taskboard_theme_v2',
      JSON.stringify({ themeMode: 'light', lightTheme: 'github-light', darkTheme: 'nord' }),
    );
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    expect(store.effectiveTheme()).toBe('github-light');

    store.setThemeModeLocal('dark');
    expect(store.effectiveTheme()).toBe('nord');
  });

  it('should migrate a legacy localStorage theme id to the mode model', async () => {
    localStorage.setItem('taskboard_theme', 'nord');
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    // Legacy theme is applied immediately (pre-auth appearance unchanged)…
    expect(themeLoader.loadTheme).toHaveBeenCalledWith('nord');

    // …then migrated once the manifest resolves the theme's mode.
    await vi.waitFor(() => expect(store.themeMode()).toBe('dark'));

    expect(store.themeMode()).toBe('dark');
    expect(store.darkTheme()).toBe('nord');
    expect(store.lightTheme()).toBeNull();
    expect(store.effectiveTheme()).toBe('nord');
    expect(JSON.parse(localStorage.getItem('taskboard_theme_v2') ?? '{}')).toEqual({
      themeMode: 'dark',
      lightTheme: null,
      darkTheme: 'nord',
    });
  });

  it('should load mode-aware preferences from the backend', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);
    const promise = store.loadPreferences();
    const req = httpMock.expectOne('http://localhost/api/preferences');

    expect(req.request.method).toBe('GET');

    const mockPrefs: UserPreferences = {
      userId: 'user-1',
      zoom: 125,
      theme: 'dark',
      themeMode: 'dark',
      lightTheme: null,
      darkTheme: 'nord',
      language: 'pl',
      pageSize: 20,
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '12h',
      updatedAt: new Date().toISOString(),
    };

    req.flush({ data: mockPrefs });
    await promise;

    expect(store.zoom()).toBe(125);
    expect(store.themeMode()).toBe('dark');
    expect(store.darkTheme()).toBe('nord');
    expect(store.effectiveTheme()).toBe('nord');
    expect(store.language()).toBe('pl');
    expect(store.datePipeFormat()).toBe('dd/MM/yyyy');
    expect(store.dateTimePipeFormat()).toBe('dd/MM/yyyy h:mm a');
    expect(themeLoader.loadTheme).toHaveBeenCalledWith('nord');
    expect(document.documentElement.style.getPropertyValue('font-size')).toBe('125%');
    expect(JSON.parse(localStorage.getItem('taskboard_theme_v2') ?? '{}')).toEqual({
      themeMode: 'dark',
      lightTheme: null,
      darkTheme: 'nord',
    });
  });

  it('should migrate a legacy backend payload (theme only) to the mode model', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);
    const promise = store.loadPreferences();
    const req = httpMock.expectOne('http://localhost/api/preferences');

    // Legacy server payload: only the single `theme` field, no mode fields yet.
    req.flush({
      data: {
        userId: 'user-1',
        zoom: 100,
        theme: 'nord',
        language: 'en',
        pageSize: 20,
        dateFormat: null,
        timeFormat: null,
        updatedAt: new Date().toISOString(),
      },
    });
    await promise;

    await vi.waitFor(() => expect(store.themeMode()).toBe('dark'));

    expect(store.darkTheme()).toBe('nord');

    // The authenticated migration persists the migrated mode model to the backend.
    const put = httpMock.expectOne('http://localhost/api/preferences');

    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ themeMode: 'dark', lightTheme: null, darkTheme: 'nord' });
    put.flush({} as UserPreferences);
  });

  it('should set zoom locally without backend call, then persist on commit', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);

    store.setZoomLocal(150);

    expect(store.zoom()).toBe(150);
    expect(document.documentElement.style.getPropertyValue('font-size')).toBe('150%');

    httpMock.expectNone('http://localhost/api/preferences');

    store.commitZoom();

    const req = httpMock.expectOne('http://localhost/api/preferences');

    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ zoom: 150 });
    req.flush({} as UserPreferences);
  });

  it('should set the theme mode locally without backend call, then persist on commit', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);

    store.setThemeModeLocal('dark');

    expect(store.themeMode()).toBe('dark');
    expect(JSON.parse(localStorage.getItem('taskboard_theme_v2') ?? '{}').themeMode).toBe('dark');

    // No HTTP request yet — setThemeModeLocal only applies locally
    httpMock.expectNone('http://localhost/api/preferences');

    store.commitTheme();

    const req = httpMock.expectOne('http://localhost/api/preferences');

    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ themeMode: 'dark' });
    req.flush({} as UserPreferences);
  });

  it('should store a theme choice per mode and persist it on commit', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);

    store.setThemeChoiceLocal('nord', 'dark');

    expect(store.darkTheme()).toBe('nord');
    expect(store.lightTheme()).toBeNull();
    expect(JSON.parse(localStorage.getItem('taskboard_theme_v2') ?? '{}').darkTheme).toBe('nord');

    httpMock.expectNone('http://localhost/api/preferences');

    store.commitTheme();

    const req = httpMock.expectOne('http://localhost/api/preferences');

    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ darkTheme: 'nord' });
    req.flush({} as UserPreferences);

    // A light choice lands in lightTheme and both pendings flush together.
    store.setThemeChoiceLocal('github-light', 'light');
    store.commitTheme();

    const req2 = httpMock.expectOne('http://localhost/api/preferences');

    expect(req2.request.body).toEqual({ lightTheme: 'github-light' });
    req2.flush({} as UserPreferences);
  });

  it('should keep the applied theme browser-driven in auto mode while storing a per-mode choice', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);

    // Auto + light system scheme → light applied.
    expect(store.effectiveTheme()).toBe('light');

    // Picking a dark theme in auto mode stores darkTheme but keeps the light theme applied.
    store.setThemeChoiceLocal('nord', 'dark');

    expect(store.darkTheme()).toBe('nord');
    expect(store.effectiveTheme()).toBe('light');
    expect(store.selectedTheme()).toBe('light');

    // Flipping the system scheme to dark applies the stored dark theme.
    store.systemPrefersDark.set(true);
    expect(store.effectiveTheme()).toBe('nord');
  });

  it('should set language and persist to backend', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    seedAuthUser(authStore);

    const store = TestBed.inject(PreferencesStore);

    store.setLanguage('de');

    expect(store.language()).toBe('de');

    const req = httpMock.expectOne('http://localhost/api/preferences');

    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ language: 'de' });
    req.flush({} as UserPreferences);
  });
});

// ─── Per-project preferences cache (dedupe + invalidation) ───────────────────

describe('PreferencesStore (per-project preferences cache)', () => {
  let httpMock: HttpTestingController;

  async function createModule() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        importProvidersFrom(
          TranslocoTestingModule.forRoot({
            preloadLangs: true,
            langs: { en: {} },
            translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          }),
        ),
        { provide: ThemeLoader, useValue: { loadTheme: vi.fn() } },
        { provide: ThemeRegistry, useValue: { load: vi.fn(async () => undefined), findById: vi.fn() } },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    httpMock = TestBed.inject(HttpTestingController);
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('font-size');
  });

  afterEach(() => {
    httpMock?.verify();
    localStorage.clear();
    document.documentElement.style.removeProperty('font-size');
  });

  const prefsUrl = (projectId: string): string => `http://localhost/api/projects/${projectId}/preferences`;
  const makePrefs = (projectId: string, taskTableColumns: TaskTableColumnKey[] | null): UserProjectBoardPreference => ({
    id: `pref-${projectId}`,
    userId: 'user-1',
    projectId,
    taskTableColumns,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('should dedupe two concurrent loadProjectPreferences calls into ONE HTTP request', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const first = store.loadProjectPreferences('p1');
    const second = store.loadProjectPreferences('p1');
    const req = httpMock.expectOne(prefsUrl('p1'));

    expect(req.request.method).toBe('GET');
    req.flush({ data: makePrefs('p1', ['key', 'title']) });

    await Promise.all([first, second]);

    expect(store.getTaskTableColumns('p1')).toEqual(['key', 'title']);
  });

  it('should NOT issue a new request when the project was already loaded (cache hit)', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const initial = store.loadProjectPreferences('p1');

    httpMock.expectOne(prefsUrl('p1')).flush({ data: makePrefs('p1', ['key', 'title']) });
    await initial;

    await store.loadProjectPreferences('p1');
    await store.loadProjectPreferences('p1');

    httpMock.expectNone(prefsUrl('p1'));
    expect(store.getTaskTableColumns('p1')).toEqual(['key', 'title']);
  });

  it('should cache `data: null` as a VALID result, not a cache miss', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const initial = store.loadProjectPreferences('p1');

    httpMock.expectOne(prefsUrl('p1')).flush({ data: null });
    await initial;

    expect(store.getTaskTableColumns('p1')).toBeNull();

    // Repeat read must be served from cache — no second request.
    await store.loadProjectPreferences('p1');
    httpMock.expectNone(prefsUrl('p1'));
  });

  it('should keep independent cache entries for different projectIds', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const p1 = store.loadProjectPreferences('p1');
    const p2 = store.loadProjectPreferences('p2');

    httpMock.expectOne(prefsUrl('p1')).flush({ data: makePrefs('p1', ['key']) });
    httpMock.expectOne(prefsUrl('p2')).flush({ data: makePrefs('p2', ['title']) });

    await Promise.all([p1, p2]);

    // Repeated reads for BOTH projects stay cached.
    await store.loadProjectPreferences('p1');
    await store.loadProjectPreferences('p2');
    httpMock.expectNone(prefsUrl('p1'));
    httpMock.expectNone(prefsUrl('p2'));

    expect(store.getTaskTableColumns('p1')).toEqual(['key']);
    expect(store.getTaskTableColumns('p2')).toEqual(['title']);
  });

  it('should refresh the cache after a successful setTaskTableColumns mutation', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const initial = store.loadProjectPreferences('p1');

    httpMock.expectOne(prefsUrl('p1')).flush({ data: makePrefs('p1', null) });
    await initial;

    const mutation = store.setTaskTableColumns('p1', ['title', 'status']);
    const patch = httpMock.expectOne(prefsUrl('p1'));

    expect(patch.request.method).toBe('PATCH');
    patch.flush({ data: makePrefs('p1', ['title', 'status']) });
    await mutation;

    expect(store.getTaskTableColumns('p1')).toEqual(['title', 'status']);

    await store.loadProjectPreferences('p1');
    httpMock.expectNone(prefsUrl('p1'));
  });

  it('should NOT cache failures — a later call retries the request', async () => {
    await createModule();

    const store = TestBed.inject(PreferencesStore);
    const failed = store.loadProjectPreferences('p1');

    httpMock.expectOne(prefsUrl('p1')).flush(null, { status: 500, statusText: 'Server Error' });
    await failed; // silently ignored

    // The failed entry was dropped — the next call issues a fresh request.
    const retry = store.loadProjectPreferences('p1');

    httpMock.expectOne(prefsUrl('p1')).flush({ data: makePrefs('p1', ['key', 'title']) });
    await retry;

    expect(store.getTaskTableColumns('p1')).toEqual(['key', 'title']);
  });

  // ── The session load is an rxResource, not an effect + promise ─────────────

  it('should load preferences once the session becomes authenticated (F21)', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    authStore.setSession({
      token: 'fake-jwt',
      user: { id: 'user-1', email: 'test@example.com', displayName: 'Test' } as User,
    });

    const store = TestBed.inject(PreferencesStore);

    // The resource issues the request on the first flush — no effect, no
    // hand-rolled promise, and no second request when the payload arrives.
    TestBed.tick();

    const req = httpMock.expectOne('http://localhost/api/preferences');

    req.flush({
      data: {
        userId: 'user-1',
        zoom: 130,
        theme: 'dark',
        themeMode: 'dark',
        lightTheme: null,
        darkTheme: 'nord',
        language: 'en',
        pageSize: 50,
        dateFormat: null,
        timeFormat: null,
        updatedAt: new Date().toISOString(),
      },
    });
    await Promise.resolve();
    TestBed.tick();

    expect(store.zoom()).toBe(130);
    expect(store.pageSize()).toBe(50);
    expect(store.darkTheme()).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('font-size')).toBe('130%');
  });

  it('should NOT request preferences while logged out (F21)', async () => {
    await createModule();

    TestBed.inject(PreferencesStore);
    TestBed.tick();

    httpMock.expectNone('http://localhost/api/preferences');
  });

  it('should swallow a failed session load instead of leaking an unhandled rejection (F21)', async () => {
    await createModule();

    const authStore = TestBed.inject(AuthStore);

    authStore.setSession({
      token: 'fake-jwt',
      user: { id: 'user-1', email: 'test@example.com', displayName: 'Test' } as User,
    });

    const store = TestBed.inject(PreferencesStore);

    TestBed.tick();

    const req = httpMock.expectOne('http://localhost/api/preferences');

    req.flush({ error: { message: 'boom' } }, { status: 500, statusText: 'Server Error' });
    await Promise.resolve();
    TestBed.tick();

    // Defaults are untouched and nothing was applied. Before the fix this path
    // was a bare `loadPreferences()` call whose rejected promise nobody caught —
    // Vitest reports that as an unhandled rejection and fails the run.
    expect(store.zoom()).toBe(100);
    expect(store.pageSize()).toBe(20);
  });
});
