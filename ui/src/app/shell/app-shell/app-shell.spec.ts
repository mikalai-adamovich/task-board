/**
 * a11y tests for the app shell.
 *
 * The shell is the only place that can offer a keyboard bypass for the
 * sidebar + header, and the only place a `<main>` landmark can exist for the
 * router outlet. Both are asserted on the RENDERED DOM (not the template
 * source) so a broken `#main-content` target fails here.
 *
 * Zoneless (Angular 22): no `detectChanges()` — `settle()` after setup.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '@app/api-url.token';
import { AppShell } from './app-shell';
import { KeyboardShortcuts } from '@app/shared/keyboard-shortcuts/keyboard-shortcuts';
import { settle } from '@app/shared/testing/zoneless';

const MAIN_ID = 'main-content';

describe('AppShell accessibility (F20)', () => {
  let fixture: ComponentFixture<AppShell>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: { en: { a11y: { skipToContent: 'Skip to content' } } },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        KeyboardShortcuts,
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(AppShell);
    await settle(fixture);
  });

  function el<T extends HTMLElement>(selector: string): T | null {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  }

  it('renders exactly one main landmark', () => {
    // A page must never end up with zero or several <main>s — that is what the
    // landmark is for.
    expect(fixture.nativeElement.querySelectorAll('main').length).toBe(1);
  });

  it('gives the main landmark the id the skip link targets', () => {
    expect(el('main')?.id).toBe(MAIN_ID);
  });

  it('makes the main landmark programmatically focusable', () => {
    // A skip link only moves the CARET (not just the scroll position) when the
    // target can take focus.
    expect(el('main')?.getAttribute('tabindex')).toBe('-1');
  });

  it('renders a skip link as the first focusable element', () => {
    const skip = el<HTMLAnchorElement>('a[href="#main-content"]');

    expect(skip).not.toBeNull();
    expect(skip?.textContent?.trim()).toBe('Skip to content');

    // Keyboard users must reach it before the 40-odd controls of the header
    // and sidebar, so it has to come first in DOM order.
    const focusables = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );

    expect(focusables[0]).toBe(skip);
  });

  it('reveals the skip link on focus instead of leaving it permanently hidden', () => {
    // `sr-only` clips it; `focus:not-sr-only` un-clips it. A skip link that can
    // never be seen is not a skip link.
    const classes = el('a[href="#main-content"]')?.className ?? '';

    expect(classes).toContain('sr-only');
    expect(classes).toContain('focus:not-sr-only');
  });
});
