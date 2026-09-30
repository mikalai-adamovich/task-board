import { Service, signal, computed, inject, effect, DestroyRef } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { DEFAULT_THEME_ID } from '@task-board/shared';
import type {
  DateFormatPreference,
  TaskTableColumnKey,
  ThemeMode,
  TimeFormatPreference,
  UpdateUserPreferences,
  UserPreferences,
  UserProjectBoardPreference,
} from '@task-board/shared';
import { toDatePipeDateFormat, toDatePipeDateTimeFormat } from '@app/utils/date-format';
import { UserPreferencesClient } from '@services/user-preferences-client';
import { AuthStore } from '@stores/auth-store';
import { ThemeLoader } from '@services/theme-loader';
import { ThemeRegistry } from '@services/theme-registry';

/** localStorage key for the mode-aware theme preferences (v2). */
const THEME_PREFS_KEY = 'taskboard_theme_v2';
/** Legacy localStorage key holding a single theme id (pre-mode model). */
const LEGACY_THEME_KEY = 'taskboard_theme';

/** Shape persisted to localStorage for pre-auth theme restoration. */
interface StoredThemePrefs {
  themeMode: ThemeMode;
  lightTheme: string | null;
  darkTheme: string | null;
}

/**
 * Signal-based preferences store.
 * Manages per-user UI settings: zoom, theme (mode-aware), language, and per-project board preferences.
 * Uses UserPreferencesClient for all HTTP calls — the store only handles orchestration and state.
 *
 * Theme model: `themeMode` ('auto' | 'light' | 'dark') plus per-mode theme choices
 * (`lightTheme` / `darkTheme`). The effective theme is resolved centrally:
 * - 'light' → lightTheme ?? 'light'
 * - 'dark'  → darkTheme ?? 'dark'
 * - 'auto'  → browser prefers-color-scheme ? (darkTheme ?? 'dark') : (lightTheme ?? 'light')
 * In 'auto' mode the store listens to matchMedia 'change' and re-applies live.
 */
@Service()
export class PreferencesStore {
  private readonly client = inject(UserPreferencesClient);
  private readonly authStore = inject(AuthStore);
  private readonly transloco = inject(TranslocoService);
  private readonly themeLoader = inject(ThemeLoader);
  private readonly themeRegistry = inject(ThemeRegistry);
  private readonly destroyRef = inject(DestroyRef);
  readonly zoom = signal<number>(100);
  /** Theme mode: 'auto' (default) follows the browser's prefers-color-scheme. */
  readonly themeMode = signal<ThemeMode>('auto');
  /** Theme applied in light mode (null = default 'light'). */
  readonly lightTheme = signal<string | null>(null);
  /** Theme applied in dark mode (null = default 'dark'). */
  readonly darkTheme = signal<string | null>(null);
  /** Live view of the browser's prefers-color-scheme (drives 'auto' mode). */
  readonly systemPrefersDark = signal<boolean>(false);
  /** Legacy single-theme id being migrated (cleared once resolved against the manifest). */
  private readonly legacyThemeId = signal<string | null>(null);
  /** Effective theme id resolved from mode + per-mode choices + system scheme. */
  readonly effectiveTheme = computed<string>(() => {
    const legacy = this.legacyThemeId();

    if (legacy) return legacy;

    switch (this.themeMode()) {
      case 'light':
        return this.lightTheme() ?? DEFAULT_THEME_ID;

      case 'dark':
        return this.darkTheme() ?? 'dark';

      default:
        return this.systemPrefersDark() ? (this.darkTheme() ?? 'dark') : (this.lightTheme() ?? DEFAULT_THEME_ID);
    }
  });
  /**
   * The theme id shown as "selected" for the current mode: the per-mode choice
   * in light/dark mode; the effective (browser-driven) theme in auto mode.
   */
  readonly selectedTheme = computed<string>(() => {
    switch (this.themeMode()) {
      case 'light':
        return this.lightTheme() ?? DEFAULT_THEME_ID;

      case 'dark':
        return this.darkTheme() ?? 'dark';

      default:
        return this.effectiveTheme();
    }
  });
  readonly language = signal<string>('en');
  readonly pageSize = signal<number>(20);
  /** Preferred date display format (null = not set → ISO fallback). */
  readonly dateFormat = signal<DateFormatPreference | null>(null);
  /** Preferred time display format (null = not set → 24h fallback). */
  readonly timeFormat = signal<TimeFormatPreference | null>(null);
  /** DatePipe token for date-only rendering, derived from the preference. */
  readonly datePipeFormat = computed(() => toDatePipeDateFormat(this.dateFormat()));
  /** DatePipe token for timestamp rendering, derived from both preferences. */
  readonly dateTimePipeFormat = computed(() => toDatePipeDateTimeFormat(this.dateFormat(), this.timeFormat()));
  /** Per-project visible task-table columns. Map of projectId → column keys (or null = default). */
  private readonly projectTaskTableColumns = signal<Record<string, TaskTableColumnKey[] | null>>({});
  /**
   * Per-project preferences cache: projectId → resolved request promise.
   * A `null` payload (the user never saved prefs for this project — the server
   * answers `{ data: null }`) is a VALID cached result, not a cache miss.
   * Failures are NOT cached — the entry is dropped so a later call retries.
   * Refreshed in place by the mutation methods below.
   */
  private readonly projectPrefsCache = new Map<string, Promise<UserProjectBoardPreference | null>>();
  /**
   * The session-scoped preferences load is an `rxResource`, not an
   * `effect` + hand-rolled promise. The request is cancelled when the session
   * changes (no stale write after logout), and a failure lands in `error()`
   * instead of becoming an unhandled promise rejection.
   */
  private readonly remotePrefsResource = rxResource({
    params: () => ({ authenticated: this.authStore.isAuthenticated() }),
    stream: ({ params }) => (params.authenticated ? this.client.getPreferences() : of(null)),
    defaultValue: null as UserPreferences | null,
  });
  /** Last backend payload already handed to `applyPreferences` (dedupes re-applies). */
  private lastAppliedRemote: UserPreferences | null = null;
  /** Tracks the last zoom applied locally but not yet persisted to the backend. */
  private pendingZoom: number | null = null;
  /** Tracks the pending theme-preferences partial to be flushed to the backend on commit. */
  private pendingThemePrefs: Partial<Pick<UpdateUserPreferences, 'themeMode' | 'lightTheme' | 'darkTheme'>> | null =
    null;
  /** Last theme id applied via the ThemeLoader (dedupes reactive re-application). */
  private lastAppliedTheme: string | null = null;

  constructor() {
    this.restoreThemeFromLocalStorage();
    this.initSystemThemeListener();

    // Apply the resolved theme immediately (before first paint)…
    this.applyEffectiveTheme();

    // …and re-apply reactively whenever the resolution changes (mode switch,
    // per-mode theme pick, or a live prefers-color-scheme flip in auto mode).
    effect(() => {
      if (this.effectiveTheme() !== this.lastAppliedTheme) {
        this.applyEffectiveTheme();
      }
    });

    // Apply the fetched preferences once they arrive. This effect performs NO
    // fetching: it only reads `remotePrefsResource` (the request lives in the
    // resource, which cancels it on session change) and applies the payload.
    effect(() => {
      if (!this.authStore.isAuthenticated()) {
        // Session isolation: drop all per-user project preference state on logout
        // so a subsequent login as another user never sees the previous session's cache.
        this.projectPrefsCache.clear();
        this.projectTaskTableColumns.set({});
        return;
      }

      if (!this.remotePrefsResource.hasValue()) return;

      const prefs = this.remotePrefsResource.value();

      // `hasValue()` is false in the error state; a null payload means "no
      // session payload" (the stream short-circuits when logged out).
      if (!prefs || prefs === this.lastAppliedRemote) return;

      this.lastAppliedRemote = prefs;
      this.applyPreferences(prefs);
    });
  }

  /**
   * Load project-scoped board preferences from the backend.
   * Deduped + cached per project: concurrent callers share one HTTP request,
   * and a repeated call for an already-loaded project makes NO request at all.
   */
  async loadProjectPreferences(projectId: string): Promise<void> {
    if (!projectId) return;

    const existing = this.projectPrefsCache.get(projectId);

    if (existing) {
      await existing;
      return;
    }

    const request = firstValueFrom(this.client.getProjectPreferences(projectId)).then(
      (prefs) => {
        this.applyProjectPreferences(projectId, prefs);
        return prefs;
      },
      () => {
        // Silently ignore — preferences are non-critical. Failures are NOT
        // cached: drop the entry so a later call retries.
        this.projectPrefsCache.delete(projectId);
        return null;
      },
    );

    this.projectPrefsCache.set(projectId, request);
    await request;
  }

  /** Write a fetched/updated per-project preference document into the signal map. */
  private applyProjectPreferences(projectId: string, prefs: UserProjectBoardPreference | null): void {
    // Task-table column visibility lives in the per-project document
    this.projectTaskTableColumns.update((map) => ({
      ...map,
      [projectId]: prefs?.taskTableColumns ?? null,
    }));
  }

  /** Get the persisted visible task-table columns for a project (null = default set) */
  getTaskTableColumns(projectId: string): TaskTableColumnKey[] | null {
    return this.projectTaskTableColumns()[projectId] ?? null;
  }

  /** Set and persist the visible task-table columns for a project (null resets to the default set) */
  async setTaskTableColumns(projectId: string, columns: TaskTableColumnKey[] | null): Promise<void> {
    // Optimistic update
    this.projectTaskTableColumns.update((map) => ({
      ...map,
      [projectId]: columns,
    }));

    try {
      const prefs = await firstValueFrom(
        this.client.updateProjectPreferences(projectId, { taskTableColumns: columns }),
      );

      // Sync with server response
      this.projectTaskTableColumns.update((map) => ({
        ...map,
        [projectId]: prefs.taskTableColumns,
      }));
      // Refresh the cache with the server response (no invalidation needed).
      this.projectPrefsCache.set(projectId, Promise.resolve(prefs));
    } catch {
      // Revert on failure — drop the cache entry and reload from server.
      this.projectPrefsCache.delete(projectId);
      this.loadProjectPreferences(projectId);
    }
  }

  /**
   * Restore theme preferences from localStorage and apply the resolved theme.
   * Reads the v2 mode-aware payload; falls back to migrating a legacy single-theme
   * id (its mode is resolved against the manifest once available). With nothing
   * persisted the default is Auto (browser-driven).
   * P8-13: the theme must be applied at bootstrap so the login page and landing
   * are themed from the start.
   */
  restoreThemeFromLocalStorage(): void {
    const raw = localStorage.getItem(THEME_PREFS_KEY);

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredThemePrefs>;

        this.themeMode.set(parsed.themeMode ?? 'auto');
        this.lightTheme.set(parsed.lightTheme ?? null);
        this.darkTheme.set(parsed.darkTheme ?? null);
      } catch {
        // Corrupted payload — keep defaults (Auto).
      }

      return;
    }

    const legacy = localStorage.getItem(LEGACY_THEME_KEY);

    if (legacy) {
      // Legacy single-theme value: apply it right away and migrate to the
      // mode model once the manifest tells us the theme's mode.
      this.legacyThemeId.set(legacy);
      void this.migrateLegacyTheme(legacy);
    }
  }

  /**
   * Explicitly (re)load preferences from the backend and apply all settings.
   * The automatic session-scoped load goes through `remotePrefsResource`; this
   * stays the imperative entry point for a forced refresh.
   */
  async loadPreferences(): Promise<void> {
    const prefs = await firstValueFrom(this.client.getPreferences());

    this.applyPreferences(prefs);
  }

  /** Set zoom level and apply CSS — without saving to backend. */
  setZoomLocal(value: number): void {
    this.zoom.set(value);
    document.documentElement.style.setProperty('font-size', `${value}%`);
    this.pendingZoom = value;
  }

  /** Persist the pending zoom change to the backend. No-op if nothing is pending. */
  commitZoom(): void {
    if (this.pendingZoom !== null) {
      this.saveToBackend({ zoom: this.pendingZoom });
      this.pendingZoom = null;
    }
  }

  /**
   * Set the theme mode ('auto' | 'light' | 'dark'), apply the resolved theme,
   * and sync localStorage — without saving to backend.
   */
  setThemeModeLocal(mode: ThemeMode): void {
    this.themeMode.set(mode);
    this.legacyThemeId.set(null);
    this.persistThemePrefsLocal();
    this.pendingThemePrefs = { ...this.pendingThemePrefs, themeMode: mode };
  }

  /**
   * Store a theme choice for its mode (lightTheme or darkTheme depending on the
   * theme's mode), sync localStorage — without saving to backend. In 'auto' mode
   * the applied theme keeps following the browser; the choice is per-mode.
   */
  setThemeChoiceLocal(themeId: string, mode: 'light' | 'dark'): void {
    if (mode === 'light') {
      this.lightTheme.set(themeId);
    } else {
      this.darkTheme.set(themeId);
    }

    this.legacyThemeId.set(null);
    this.persistThemePrefsLocal();
    this.pendingThemePrefs = { ...this.pendingThemePrefs, [mode === 'light' ? 'lightTheme' : 'darkTheme']: themeId };
  }

  /** Persist the pending theme-preferences change to the backend. No-op if nothing is pending. */
  commitTheme(): void {
    if (this.pendingThemePrefs !== null) {
      this.saveToBackend(this.pendingThemePrefs);
      this.pendingThemePrefs = null;
    }
  }

  /** Set language, switch Transloco active lang, and persist to backend. */
  setLanguage(language: string): void {
    this.language.set(language);
    this.transloco.setActiveLang(language);
    this.saveToBackend({ language });
  }

  /** Set page size and persist to backend. */
  setPageSize(size: number): void {
    this.pageSize.set(size);
    this.saveToBackend({ pageSize: size });
  }

  /** Set the preferred date display format and persist to backend. */
  setDateFormat(format: DateFormatPreference | null): void {
    this.dateFormat.set(format);
    this.saveToBackend({ dateFormat: format });
  }

  /** Set the preferred time display format and persist to backend. */
  setTimeFormat(format: TimeFormatPreference | null): void {
    this.timeFormat.set(format);
    this.saveToBackend({ timeFormat: format });
  }

  /** Apply all preference values from a backend response. */
  private applyPreferences(prefs: UserPreferences): void {
    this.zoom.set(prefs.zoom);
    this.language.set(prefs.language);
    this.pageSize.set(prefs.pageSize ?? 20);
    this.dateFormat.set(prefs.dateFormat ?? null);
    this.timeFormat.set(prefs.timeFormat ?? null);
    this.transloco.setActiveLang(prefs.language);

    document.documentElement.style.setProperty('font-size', `${prefs.zoom}%`);

    if (prefs.themeMode) {
      // Mode-aware payload from the server.
      this.themeMode.set(prefs.themeMode);
      this.lightTheme.set(prefs.lightTheme ?? null);
      this.darkTheme.set(prefs.darkTheme ?? null);
      this.legacyThemeId.set(null);
    } else if (prefs.theme) {
      // Legacy server payload (single theme id): migrate to the mode model.
      void this.migrateLegacyTheme(prefs.theme);
    }

    this.persistThemePrefsLocal();
    // Re-apply synchronously so the resolved theme is loaded without waiting
    // for the next effect flush (the effect dedupes via lastAppliedTheme).
    this.applyEffectiveTheme();
  }

  /**
   * Migrate a legacy single-theme id to the mode model: resolve the theme's
   * mode from the manifest, set themeMode accordingly and store the id as the
   * per-mode choice. Persists locally and to the backend.
   */
  private async migrateLegacyTheme(themeId: string): Promise<void> {
    await this.themeRegistry.load();

    const mode = this.themeRegistry.findById(themeId)?.mode ?? 'light';

    this.themeMode.set(mode);

    if (mode === 'light') {
      this.lightTheme.set(themeId);
      this.darkTheme.set(null);
    } else {
      this.darkTheme.set(themeId);
      this.lightTheme.set(null);
    }

    this.legacyThemeId.set(null);
    this.persistThemePrefsLocal();
    // Only persist to the backend when there is a session to persist for.
    if (this.authStore.isAuthenticated()) {
      this.saveToBackend({ themeMode: mode, lightTheme: this.lightTheme(), darkTheme: this.darkTheme() });
    }
    // Re-apply synchronously — the effective theme may have changed with the migration.
    this.applyEffectiveTheme();
  }

  /** Subscribe to prefers-color-scheme changes so 'auto' mode reacts live. */
  private initSystemThemeListener(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');

    this.systemPrefersDark.set(mql.matches);

    const listener = (event: MediaQueryListEvent): void => {
      this.systemPrefersDark.set(event.matches);
    };

    mql.addEventListener('change', listener);
    this.destroyRef.onDestroy(() => mql.removeEventListener('change', listener));
  }

  /** Apply the currently resolved theme via the ThemeLoader. */
  private applyEffectiveTheme(): void {
    const themeId = this.effectiveTheme();

    this.lastAppliedTheme = themeId;
    void this.themeLoader.loadTheme(themeId);
  }

  /** Mirror the mode-aware theme preferences to localStorage (pre-auth restore). */
  private persistThemePrefsLocal(): void {
    const payload: StoredThemePrefs = {
      themeMode: this.themeMode(),
      lightTheme: this.lightTheme(),
      darkTheme: this.darkTheme(),
    };

    localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(payload));
  }

  /** Persist a partial preferences update to the backend. */
  private saveToBackend(data: UpdateUserPreferences): void {
    firstValueFrom(this.client.updatePreferences(data)).catch(() => {
      // Silently ignore save failures — preferences are non-critical.
    });
  }
}
