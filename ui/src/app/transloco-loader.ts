import { inject, Service } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { type Translation, type TranslocoLoader } from '@jsverse/transloco';
import { Observable, catchError, of, shareReplay, switchMap } from 'rxjs';

const I18N_DIR = '/assets/i18n';
/** Written by `ui/scripts/hash-runtime-assets.mjs`; absent when nothing was hashed. */
const I18N_MANIFEST_URL = `${I18N_DIR}/manifest.json`;

/**
 * Loads a translation file over HTTP.
 *
 * ── The file name comes from a generated manifest ───────────────────────────
 * A release publishes content-hashed translation files
 * (`en.1a2b3c4d.json`), so the URL cannot be built from the language code alone.
 * `/assets/i18n/manifest.json` maps language -> file; it is fetched once and
 * shared by every later request.
 *
 * Both the manifest and its absence are handled, and the fallbacks are ordinary
 * rather than defensive noise: a build that hashed nothing (`ng serve`, the unit
 * tests) has no manifest, and the language code is then the file name. A
 * manifest that fails to load, or one that does not know the requested language,
 * falls back the same way — a language switch that threw because a static file
 * 404'd would leave the interface in the previous language, which is worse than
 * requesting a file that does exist.
 */
@Service()
export class TranslocoHttpLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);
  private readonly files$ = this.http.get<Record<string, string>>(I18N_MANIFEST_URL).pipe(
    catchError(() => of(null)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  getTranslation(lang: string): Observable<Translation> {
    return this.files$.pipe(
      switchMap((files) => {
        const file = files?.[lang] ?? `${lang}.json`;

        return this.http.get<Translation>(`${I18N_DIR}/${file}`);
      }),
    );
  }
}
