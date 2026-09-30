/**
 * Tests for `TranslocoTitleStrategy`.
 *
 * The whole point of the strategy is that a route's `title` is a translation
 * KEY, not a literal, and that the browser tab never shows the raw key — not
 * even on the first navigation, while the catalogue is still in flight (which
 * is exactly what a synchronous `translate()` would do).
 *
 * Driven through a real `Router` rather than by poking the strategy, because
 * `updateTitle(RouterStateSnapshot)` is only meaningful with a resolved route
 * tree.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, provideRouter, Router } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { TranslocoTitleStrategy } from './title.strategy';

@Component({
  /* eslint-disable-next-line @angular-eslint/component-max-inline-declarations */
  template: '',
})
class Dummy {}

describe('TranslocoTitleStrategy', () => {
  /** The `<title>` shipped in `index.html`; the strategy composes page + app. */
  const APP_TITLE = 'Task Board';

  beforeEach(() => {
    // jsdom keeps one document for the whole file, and the strategy reads
    // `document.title` as the app name — reset it so each test starts from the
    // real "app title" state.
    document.title = APP_TITLE;
  });

  async function setup() {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: {
            en: { faq: { title: 'FAQ' } },
            pl: { faq: { title: 'FAQ (pl)' } },
          },
          translocoConfig: { availableLangs: ['en', 'pl'], defaultLang: 'en' },
        }),
      ],
      providers: [
        provideRouter([
          { path: 'faq', component: Dummy, title: 'faq.title' },
          { path: 'no-title', component: Dummy },
        ]),
        { provide: TitleStrategy, useClass: TranslocoTitleStrategy },
      ],
    });

    // Warm the catalogue before navigating: the strategy must also cope with a
    // cold catalogue, but the assertion here is about the resolved text.
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    return { router: TestBed.inject(Router), title: TestBed.inject(Title) };
  }

  it('should publish the TRANSLATED title, never the raw key', async () => {
    const { router, title } = await setup();

    await router.navigateByUrl('/faq');

    expect(title.getTitle()).toBe(`FAQ - ${APP_TITLE}`);
    expect(title.getTitle()).not.toContain('faq.title');
  });

  it('should follow the active language', async () => {
    const { router, title } = await setup();

    await router.navigateByUrl('/faq');
    expect(title.getTitle()).toBe(`FAQ - ${APP_TITLE}`);

    TestBed.inject(TranslocoService).setActiveLang('pl');
    await firstValueFrom(TestBed.inject(TranslocoService).langChanges$);
    // The catalogue is fetched through the loader; give the load a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(title.getTitle()).toBe(`FAQ (pl) - ${APP_TITLE}`);
  });

  it('should keep the document title when the route declares none', async () => {
    const { router, title } = await setup();

    await router.navigateByUrl('/faq');

    const withTitle = title.getTitle();

    await router.navigateByUrl('/no-title');

    // No title on the route → DefaultTitleStrategy's own contract applies (it
    // only writes when `buildTitle` returns something), so the previous title
    // stays. What must NOT happen is a raw key or a doubled app name.
    expect(title.getTitle()).toBe(withTitle);
    expect(title.getTitle()).not.toContain('no-title');
  });
});
