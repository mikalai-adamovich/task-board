import { registerLocaleData } from '@angular/common';
import { inject, type ApplicationConfig } from '@angular/core';
import { provideAppInitializer } from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideSpartanHlm } from '@spartan-ng/helm/utils';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { TranslocoHttpLoader } from './transloco-loader';

// Angular locale data for every non-en app locale so
// DatePipe renders localized month names (e.g. 'MMM' → 'авг'). `en` is the
// built-in base locale. The ids below match the Transloco `availableLangs`.
// Locale datasets are sizeable (~10 kB each), so they are
// dynamically imported instead of bundled eagerly — the ACTIVE language's
// locale is registered in an app initializer (before first paint), the rest
// on demand when the language changes.
const localeLoaders: Record<string, () => Promise<{ default: Parameters<typeof registerLocaleData>[0] }>> = {
  de: () => import('@angular/common/locales/de'),
  es: () => import('@angular/common/locales/es'),
  fr: () => import('@angular/common/locales/fr'),
  it: () => import('@angular/common/locales/it'),
  ja: () => import('@angular/common/locales/ja'),
  ko: () => import('@angular/common/locales/ko'),
  pl: () => import('@angular/common/locales/pl'),
  pt: () => import('@angular/common/locales/pt'),
  ru: () => import('@angular/common/locales/ru'),
  'zh-Hans': () => import('@angular/common/locales/zh-Hans'),
};

function registerLocale(lang: string): Promise<void> {
  const loader = localeLoaders[lang];

  if (!loader) return Promise.resolve();

  return loader().then((module) => registerLocaleData(module.default, lang));
}

/** Keep `<html lang>` in sync with the active language (a11y — screen readers). */
function syncDocumentLang(lang: string): void {
  document.documentElement.lang = lang;
}

/** Registers the active locale before first render, then follows language changes. */
function initLocales(): Promise<void> {
  const transloco = inject(TranslocoService);

  syncDocumentLang(transloco.getActiveLang());

  // App-lifetime subscription: TranslocoService is a root service, so the
  // subscription lives exactly as long as the application.
  transloco.langChanges$.subscribe((lang) => {
    syncDocumentLang(lang);
    void registerLocale(lang);
  });

  return registerLocale(transloco.getActiveLang());
}

import { routes } from './app.routes';
import { TranslocoTitleStrategy } from './title.strategy';
import { authInterceptor } from './interceptors/auth.interceptor';
import { tenantInterceptor } from './interceptors/tenant.interceptor';
import { errorInterceptor } from './interceptors/error.interceptor';
import { environment } from '../environments/environment';
import { API_BASE_URL } from './api-url.token';
import { KeyboardShortcuts } from './shared/keyboard-shortcuts/keyboard-shortcuts';

export const appConfig: ApplicationConfig = {
  providers: [
    // Register the active language's Angular locale data before first
    // paint (the remaining locales load on demand — see `localeLoaders`).
    provideAppInitializer(() => initLocales()),
    // Root-level so AppShell (dialog binding) and HelpMenu (Hotkeys item)
    // resolve the SAME instance — a shell-scoped provider would give the
    // header a second instance whose helpOpen is not bound to the dialog.
    KeyboardShortcuts,
    provideSpartanHlm(),
    provideRouter(routes, withComponentInputBinding()),
    // Localised `<title>` — route `title` values are translation KEYS, resolved
    // (and re-resolved on language change) by the strategy.
    { provide: TitleStrategy, useClass: TranslocoTitleStrategy },
    provideHttpClient(withInterceptors([authInterceptor, tenantInterceptor, errorInterceptor])),
    { provide: API_BASE_URL, useValue: environment.apiBaseUrl },
    provideTransloco({
      config: {
        prodMode: environment.production,
        availableLangs: [
          { id: 'en', label: 'English' },
          { id: 'de', label: 'Deutsch' },
          { id: 'fr', label: 'Français' },
          { id: 'es', label: 'Español' },
          { id: 'pt', label: 'Português' },
          { id: 'it', label: 'Italiano' },
          { id: 'pl', label: 'Polski' },
          { id: 'ru', label: 'Русский' },
          { id: 'ja', label: '日本語' },
          { id: 'zh-Hans', label: '简体中文' },
          { id: 'ko', label: '한국어' },
        ],
        reRenderOnLangChange: true,
        fallbackLang: 'en',
        defaultLang: 'en',
        missingHandler: {
          useFallbackTranslation: true,
          logMissingKey: !environment.production,
        },
      },
      loader: TranslocoHttpLoader,
    }),
  ],
};
