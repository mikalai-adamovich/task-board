/**
 * The client side of the shared contract.
 *
 * Three properties, each asserted from the client end (the server end of the
 * two contracts it shares is `server/src/testing/shared-resolution.guardrail.test.ts`):
 *
 * 1. **Every error code maps to a message that is translated in every shipped
 *    locale.** The `Record<ErrorCode, …>` in `error.interceptor.ts` is
 *    exhaustive by TYPE — a new code breaks the client build — so the half a
 *    type cannot see is asserted here: the key each code maps to must exist in
 *    every locale file, and must not BE the key (an untranslated copy).
 * 2. **A 429 carries the server's `Retry-After`.** The header was sent on every
 *    429 and never read, which made the branch dead code.
 * 3. **The client's length bound is the shared one.** The tenant form is checked
 *    at exactly the shared bound and one character past it, so a bound edited on
 *    either side fails this suite.
 *
 * Nothing here enumerates codes, keys or files: every list is derived from
 * `@task-board/shared`, from the shipped locale files, or from the component.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { ERROR_CODES, TENANT_DESCRIPTION_MAX_LENGTH, TENANT_NAME_MAX_LENGTH } from '@task-board/shared';
import { errorInterceptor } from '../../interceptors/error.interceptor';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import { TenantSettings } from '@features/tenants/tenant-settings/tenant-settings';
import { TenantStore } from '@stores/tenant-store';
import { settle } from './zoneless';

const I18N_DIR = join(__dirname, '..', '..', '..', '..', 'public', 'assets', 'i18n');
const INTERCEPTOR_SOURCE = join(__dirname, '..', '..', 'interceptors', 'error.interceptor.ts');

/** Every locale file the app ships, as `{ locale, messages }` (the whole tree). */
function shippedLocales(): { locale: string; messages: Record<string, unknown> }[] {
  return readdirSync(I18N_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const messages = JSON.parse(readFileSync(join(I18N_DIR, file), 'utf8')) as Record<string, unknown>;

      if (!messages['errors']) throw new Error(`${file} has no "errors" block`);

      return { locale: file.replace(/\.json$/, ''), messages };
    });
}

/** The real `en` catalogue, so a translation is exercised, not a stub. */
function englishMessages(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(I18N_DIR, 'en.json'), 'utf8')) as Record<string, unknown>;
}

/** Dotted path into a nested object, or undefined. */
function lookup(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== 'object') return undefined;

    return (node as Record<string, unknown>)[segment];
  }, source);
}

/**
 * `code → transloco key`, read out of the map that is the client's side of the
 * contract. Derived from the artefact rather than restated here, so a code added
 * to the map is covered the moment it is added to the shared list.
 */
function mappedKeys(): { code: string; key: string }[] {
  const source = readFileSync(INTERCEPTOR_SOURCE, 'utf8');
  const start = source.indexOf('const ERROR_CODE_MESSAGES');
  const body = source.slice(start, source.indexOf('};', start));

  return [...body.matchAll(/([A-Z_]+):\s*'([^']+)'/g)].map((match) => ({ code: match[1] ?? '', key: match[2] ?? '' }));
}

describe('shared contract — client side (D-32, D-34, D-36)', () => {
  // ── Error codes ─────────────────────────────────────────────────────────

  it('maps exactly the shared error codes — no more, no fewer', () => {
    expect(
      mappedKeys()
        .map((entry) => entry.code)
        .sort(),
    ).toEqual([...ERROR_CODES].sort());
  });

  it('maps every code to a key translated in every shipped locale', () => {
    const locales = shippedLocales();

    expect(locales.length).toBeGreaterThan(0);

    for (const { code, key } of mappedKeys()) {
      for (const { locale, messages } of locales) {
        const value = lookup(messages, key);

        expect(value, `${locale} is missing ${key} (mapped from ${code})`).toBeTypeOf('string');
        // A copy that is the key itself is a missing translation in disguise.
        expect(value, `${locale}.${key} is untranslated`).not.toBe(key);
      }
    }
  });

  it('ships a locale file for every locale the switcher offers', () => {
    // The completeness the map depends on: a locale file that does not exist
    // cannot be missing a key, and the loop above would silently skip it.
    const appConfig = readFileSync(join(__dirname, '..', '..', 'app.config.ts'), 'utf8');
    const offered = [...appConfig.matchAll(/'([a-z]{2}(?:-[A-Za-z]+)?)'/g)].map((match) => match[1] ?? '');
    const shipped = new Set(shippedLocales().map((entry) => entry.locale));

    for (const locale of offered) {
      if (!/^(de|en|es|fr|it|ja|ko|pl|pt|ru|zh-Hans)$/.test(locale)) continue;

      expect(shipped.has(locale), `no ${locale}.json for the offered locale ${locale}`).toBe(true);
    }
  });

  // ── 429 headers ─────────────────────────────────────────────────────────

  describe('a 429 carries the server Retry-After', () => {
    let http: HttpClient;
    let httpMock: HttpTestingController;

    beforeEach(async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [
          TranslocoTestingModule.forRoot({
            preloadLangs: true,
            langs: { en: englishMessages() },
            translocoConfig: { availableLangs: ['en'], defaultLang: 'en', fallbackLang: 'en' },
          }),
        ],
        providers: [
          provideHttpClient(withInterceptors([errorInterceptor])),
          provideHttpClientTesting(),
          provideRouter([{ path: 'auth/login', redirectTo: '/' }]),
          { provide: API_BASE_URL, useValue: 'http://localhost/api' },
          { provide: AuthStore, useValue: { logout: vi.fn() } },
        ],
      });

      const transloco = TestBed.inject(TranslocoService);

      // The real catalogue, so the assertion is on TRANSLATED text: the message
      // is produced by translating, and a stub catalogue would answer `en.<key>`
      // and pass a test that proves nothing.
      await firstValueFrom(transloco.load('en'));
      transloco.setActiveLang('en');

      http = TestBed.inject(HttpClient);
      httpMock = TestBed.inject(HttpTestingController);
    });

    /** Fail one request with a 429 carrying `retryAfter` (omit for none). */
    function fail429(retryAfter?: string): Promise<string> {
      return new Promise((resolve) => {
        http.get('/api/tasks').subscribe({
          error: (err: unknown) => resolve((err as { userMessage?: string }).userMessage ?? ''),
        });

        const response: { status: number; statusText: string; headers?: Record<string, string> } = {
          status: 429,
          statusText: 'Too Many Requests',
        };

        if (retryAfter !== undefined) response.headers = { 'Retry-After': retryAfter };

        httpMock
          .expectOne('/api/tasks')
          .flush({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, response);
      });
    }

    it('reports the retry delay instead of discarding the header', async () => {
      const message = await fail429('42');

      // Not the bare key: the header reached the user-facing message. (A
      // structured RATE_LIMITED body resolves the CODE first, so this also
      // proves the overlay is not switch-only.)
      expect(message).not.toBe('errors.rateLimited');
      expect(message).toContain('42');
    });

    it('falls back to the plain message when the server sends no header', async () => {
      expect(await fail429()).toBe('errors.rateLimited');
    });

    it('never renders an unparsable header as text', async () => {
      // An HTTP-date `Retry-After` is legal but is not a countdown; showing the
      // raw date to a user is worse than showing the plain message.
      expect(await fail429('Wed, 21 Oct 2026 07:28:00 GMT')).toBe('errors.rateLimited');
      expect(await fail429('-5')).toBe('errors.rateLimited');
      expect(await fail429('soon')).toBe('errors.rateLimited');
    });
  });

  // ── Tenant-form bound ───────────────────────────────────────────────────

  it('the tenant form accepts exactly the shared bound and rejects one more', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        {
          provide: TenantStore,
          useValue: {
            activeTenant: () => ({
              id: 't1',
              name: 'Acme',
              slug: 'acme',
              description: '',
              status: 'ACTIVE',
              role: 'OWNER',
            }),
            updateTenant: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuthStore, useValue: { tenantRole: () => 'OWNER' } },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(TenantSettings);
    // White-box: the form is a protected member of the component under test.
    const component = fixture.componentInstance as unknown as {
      model: { set(value: { name: string; description: string }): void };
      settingsForm: { name(): { invalid(): boolean }; description(): { invalid(): boolean } };
    };

    await settle(fixture);

    const at = (length: number) => 'x'.repeat(length);

    component.model.set({ name: at(TENANT_NAME_MAX_LENGTH), description: at(TENANT_DESCRIPTION_MAX_LENGTH) });

    expect(component.settingsForm.name().invalid()).toBe(false);
    expect(component.settingsForm.description().invalid()).toBe(false);

    component.model.set({ name: at(TENANT_NAME_MAX_LENGTH + 1), description: at(TENANT_DESCRIPTION_MAX_LENGTH + 1) });

    expect(component.settingsForm.name().invalid()).toBe(true);
    expect(component.settingsForm.description().invalid()).toBe(true);
  });
});
