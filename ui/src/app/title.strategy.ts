import { DOCUMENT, Service, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { DefaultTitleStrategy, type RouterStateSnapshot } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { Subscription } from 'rxjs';

/**
 * Localised document titles.
 *
 * Routes carry a TRANSLATION KEY in `title` (see `app.routes.ts` — the catalogue
 * is the single source of truth, the router is not the place for English
 * literals). `TranslocoService.translate()` is synchronous but only for an
 * ALREADY LOADED language, and the active language is fetched by the HTTP
 * loader — so resolving the title inside `buildTitle()` would publish the raw
 * key (`'faq.title - Task Board'`) for as long as the catalogue is in flight.
 *
 * `selectTranslate(key)` is the reactive counterpart: it loads the language,
 * emits the translated text, and re-emits on every language change. Each
 * navigation cancels the previous subscription, so exactly one observable is
 * live and the title can never be written by a stale navigation.
 */
@Service()
export class TranslocoTitleStrategy extends DefaultTitleStrategy {
  private readonly document = inject(DOCUMENT);
  private readonly transloco = inject(TranslocoService);
  /**
   * Application title from `index.html`, captured on the FIRST `updateTitle`
   * call rather than in the constructor. The router may build this strategy
   * lazily, i.e. after an earlier navigation already overwrote
   * `document.title` — capturing in the constructor would then permanently
   * treat the first page's title as the app name and produce "FAQ - FAQ".
   */
  private appTitle: string | null = null;
  private subscription: Subscription | null = null;

  constructor() {
    super(inject(Title));
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot);

    this.appTitle ??= this.document.title;

    this.subscription?.unsubscribe();
    this.subscription = null;

    if (key === undefined) {
      // No route title — keep the bare application title.
      super.updateTitle(snapshot);
      return;
    }

    this.subscription = this.transloco.selectTranslate(key).subscribe((text) => {
      const appTitle = this.appTitle ?? '';

      this.title.setTitle(appTitle && appTitle !== text ? `${text} - ${appTitle}` : text);
    });
  }
}
