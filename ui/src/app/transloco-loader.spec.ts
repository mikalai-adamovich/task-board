import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslocoHttpLoader } from './transloco-loader';

/**
 * The translation file name is content-hashed in a release, so the
 * loader cannot build the URL from the language code alone. These are the two
 * directions that matter: a hashed build must be followed, and a build with no
 * manifest (the dev server, every other test in this suite) must still work.
 */
describe('TranslocoHttpLoader', () => {
  let loader: TranslocoHttpLoader;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), TranslocoHttpLoader],
    });
    loader = TestBed.inject(TranslocoHttpLoader);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** The loader reads the name map first; every test starts there. */
  const answerManifest = (files: Record<string, string> | null): void => {
    const req = http.expectOne('/assets/i18n/manifest.json');

    if (files === null) req.flush('not found', { status: 404, statusText: 'Not Found' });
    else req.flush(files);
  };

  it('requests the content-hashed file the manifest names', () => {
    let result: unknown;

    loader.getTranslation('en').subscribe((t) => (result = t));
    answerManifest({ en: 'en.1a2b3c4d.json', pl: 'pl.9f8e7d6c.json' });

    const req = http.expectOne('/assets/i18n/en.1a2b3c4d.json');

    req.flush({ hello: 'world' });
    expect(result).toEqual({ hello: 'world' });
  });

  it('falls back to <lang>.json when nothing was hashed (dev server)', () => {
    let result: unknown;

    loader.getTranslation('pl').subscribe((t) => (result = t));
    answerManifest(null);

    const req = http.expectOne('/assets/i18n/pl.json');

    req.flush({ hello: 'cześć' });
    expect(result).toEqual({ hello: 'cześć' });
  });

  it('falls back for a language the manifest does not list', () => {
    // A manifest that 404s and a manifest that is simply incomplete are the
    // same failure from a user's side: the interface must still switch.
    let result: unknown;

    loader.getTranslation('ja').subscribe((t) => (result = t));
    answerManifest({ en: 'en.1a2b3c4d.json' });

    const req = http.expectOne('/assets/i18n/ja.json');

    req.flush({ hello: 'こんにちは' });
    expect(result).toEqual({ hello: 'こんにちは' });
  });

  it('reads the name map once, however many languages are loaded', () => {
    loader.getTranslation('en').subscribe();
    answerManifest({ en: 'en.1a2b3c4d.json' });
    http.expectOne('/assets/i18n/en.1a2b3c4d.json').flush({});

    loader.getTranslation('pl').subscribe();
    http.expectOne('/assets/i18n/pl.json').flush({});

    // A second fetch of the map would be a second request the cache policy now
    // promises is unnecessary; `shareReplay` is what makes the count one.
    http.expectNone('/assets/i18n/manifest.json');
  });
});
