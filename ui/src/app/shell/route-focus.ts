import { DestroyRef, Directive, inject, Service } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * The documented focus target after a route change.
 *
 * It is deliberately the `<main id="main-content">` the app shell already renders
 * and already makes programmatically focusable (`tabindex="-1"`) for the skip
 * link — not the routed page's `<h1>`. The h1 lives inside a lazily loaded page
 * component, so it may not exist yet when `NavigationEnd` fires and its
 * focusability would have to be arranged per page; `<main>` is present on every
 * route and is a landmark, so the move is announced as "main" either way.
 *
 * Exported as a constant so the guardrail asserts the *same* target the code
 * uses, instead of a second copy of the string that can drift.
 */
export const ROUTE_FOCUS_TARGET_ID = 'main-content';

/**
 * Moves focus to the routed page on every completed navigation.
 *
 * One mechanism, in one place: the app had four scattered `.focus()` calls and
 * three `NavigationEnd` subscribers, none of which touched focus, so a route
 * change was silent for a screen-reader or keyboard user — focus stayed wherever
 * it was, usually in the sidebar link that was just activated.
 */
@Service()
export class RouteFocus {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const sub = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => this.focusCurrentPage());

    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  /** Focus the documented target, if the shell has rendered it. */
  focusCurrentPage(): void {
    const target = this.document.getElementById(ROUTE_FOCUS_TARGET_ID);

    // The shell renders `<main>` around the outlet, so it exists before the first
    // NavigationEnd; the guard is for a unit test that mounts the service alone.
    target?.focus();
  }
}

/**
 * Activator: a bare directive whose only job is to instantiate `RouteFocus` from
 * the shell markup. It keeps the wiring to one element in `app-shell.html` and
 * leaves the service testable on its own.
 */
@Directive({ selector: '[uiRouteFocus]' })
export class RouteFocusActivator {
  protected readonly routeFocus = inject(RouteFocus);
}
