import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  DATE_FORMAT_PREFERENCES,
  DEFAULT_THEME_ID,
  TIME_FORMAT_PREFERENCES,
  isValidDateFormat,
} from '@task-board/shared';
import type { DateFormatPreference, TimeFormatPreference } from '@task-board/shared';
import { injectThemePickToasts } from '@app/shared/utils/theme-pick-toast';
import { PreferencesStore } from '@stores/preferences-store';
import { ThemeRegistry } from '@services/theme-registry';
import { ThemeModeSwitch } from '@app/shared/theme-mode-switch/theme-mode-switch';
import { ZOOM_VALUES } from '@shell/header/zoom.util';

interface LanguageOption {
  id: string;
  label: string;
}

/**
 * User preferences page: theme, zoom and language selection.
 * All changes are applied immediately via the PreferencesStore.
 */
@Component({
  selector: 'ui-settings',
  imports: [
    TranslocoPipe,
    HlmCardImports,
    HlmSelectImports,
    HlmButtonImports,
    HlmInputImports,
    ThemeModeSwitch,
    NgIcon,
  ],
  providers: [provideIcons({ lucideCheck })],
  templateUrl: './settings.html',
})
export class Settings implements OnInit {
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly themeRegistry = inject(ThemeRegistry);
  private readonly transloco = inject(TranslocoService);
  protected readonly zoom = this.preferencesStore.zoom;
  /** Auto/Light/Dark mode (default Auto — follows the browser). */
  protected readonly themeMode = this.preferencesStore.themeMode;
  /** Per-mode raw choices — BOTH are marked in the dropdown regardless of the active mode. */
  private readonly lightTheme = this.preferencesStore.lightTheme;
  private readonly darkTheme = this.preferencesStore.darkTheme;
  private readonly notify = injectThemePickToasts();
  protected readonly language = this.preferencesStore.language;
  /** Date/time display format preferences */
  private readonly dateFormat = this.preferencesStore.dateFormat;
  protected readonly timeFormat = this.preferencesStore.timeFormat;
  protected readonly dateFormatValues = DATE_FORMAT_PREFERENCES;
  protected readonly timeFormatValues = TIME_FORMAT_PREFERENCES;
  private readonly themes = this.themeRegistry.themes;
  /** Two separate pickers: one per mode — both are always visible. */
  protected readonly lightThemes = computed(() => this.themes().filter((t) => t.mode === 'light'));
  protected readonly darkThemes = computed(() => this.themes().filter((t) => t.mode === 'dark'));
  /** Closed-trigger values for the two per-mode dropdowns (defaults when unset). */
  private readonly selectedLightTheme = computed(() => this.lightTheme() ?? DEFAULT_THEME_ID);
  private readonly selectedDarkTheme = computed(() => this.darkTheme() ?? 'dark');
  private readonly availableLangs = computed(() => this.transloco.getAvailableLangs() as LanguageOption[]);
  protected readonly zoomValues = ZOOM_VALUES;
  /** Free-form custom date format, validated live against the shared whitelist */
  private readonly customFormat = signal('');
  /** Empty means "untouched" — only non-empty values are validated */
  protected readonly customFormatInvalid = computed(() => {
    const value = this.customFormat();

    return value !== '' && !isValidDateFormat(value);
  });

  ngOnInit(): void {
    void this.themeRegistry.load();
    // Prefill the custom input with the stored format (custom values are not presets)
    this.customFormat.set(this.dateFormat() ?? '');
  }

  /** V5-3: itemToString — closed trigger shows the theme name, not the raw id */
  protected readonly themeName = (id: string): string => this.themes().find((t) => t.id === id)?.name ?? id;
  /** V5-3: itemToString — closed trigger shows "100%", not the raw number */
  protected readonly zoomLabel = (z: number | string): string => `${z}%`;
  /** V5-3: itemToString — closed trigger shows the language name, not the locale code */
  protected readonly languageLabel = (code: string): string =>
    this.availableLangs().find((l) => l.id === code)?.label ?? code;
  /** V7-5: itemToString — closed time-format trigger shows the option label, not the stored "12h"/"24h" */
  protected readonly timeFormatLabel = (value: string): string =>
    this.transloco.translate(value === '24h' ? 'settings.timeFormat24h' : 'settings.timeFormat12h');

  protected onZoomChange(value: string | number): void {
    const zoom = Number(value);

    if (Number.isFinite(zoom)) {
      this.preferencesStore.setZoomLocal(zoom);
      this.preferencesStore.commitZoom();
    }
  }

  /** Pick from the "Light themes" dropdown — always stores the light-mode choice. */
  protected onLightThemeChange(themeId: string): void {
    this.preferencesStore.setThemeChoiceLocal(themeId, 'light');
    this.preferencesStore.commitTheme();
    this.notify.warnIfDeferred(themeId, 'light', this.preferencesStore.effectiveTheme());
  }

  /** Pick from the "Dark themes" dropdown — always stores the dark-mode choice. */
  protected onDarkThemeChange(themeId: string): void {
    this.preferencesStore.setThemeChoiceLocal(themeId, 'dark');
    this.preferencesStore.commitTheme();
    this.notify.warnIfDeferred(themeId, 'dark', this.preferencesStore.effectiveTheme());
  }

  /**
   * Whether the theme is the per-mode selection for ITS dropdown — marked with a
   * checkmark + semibold name regardless of the active mode.
   */
  protected isLightSelected(themeId: string): boolean {
    return themeId === this.selectedLightTheme();
  }

  protected isDarkSelected(themeId: string): boolean {
    return themeId === this.selectedDarkTheme();
  }

  protected onLanguageChange(lang: string): void {
    this.preferencesStore.setLanguage(lang);
  }

  /** V7-5/P12: itemToString — a stored custom format shows verbatim in the closed trigger */
  protected readonly dateFormatLabel = (value: string): string => value;

  /** Persist the preferred date display format */
  protected onDateFormatChange(value: string | DateFormatPreference | null): void {
    this.preferencesStore.setDateFormat(value as DateFormatPreference);
    // Keep the custom input in sync with the preset pick
    this.customFormat.set(value ?? '');
  }

  /** Live-validate the custom format; persist only whitelisted values */
  protected onCustomDateFormatChange(value: string): void {
    this.customFormat.set(value);

    if (isValidDateFormat(value)) {
      this.preferencesStore.setDateFormat(value);
    }
  }

  /** Persist the preferred time display format */
  protected onTimeFormatChange(value: string | TimeFormatPreference | null): void {
    this.preferencesStore.setTimeFormat(value as TimeFormatPreference);
  }
}
