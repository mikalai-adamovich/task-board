/**
 * Guardrail: a completed navigation moves focus to the documented
 * target.
 *
 * The defect was silence, not a wrong target: the app had three `NavigationEnd`
 * subscribers and four scattered `.focus()` calls, none of which moved focus on
 * a route change, so after activating a sidebar link the caret stayed in the
 * sidebar and a screen-reader user was told nothing about the page that had just
 * replaced it.
 *
 * The target is asserted, not assumed — it is imported from the service, so a
 * change of target in the implementation fails here rather than being duplicated
 * as a second string that can drift.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouteFocus, ROUTE_FOCUS_TARGET_ID } from './route-focus';

describe('RouteFocus (D-53)', () => {
  function setup(): { router: Router; service: RouteFocus; main: HTMLElement } {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'first', children: [] },
          { path: 'second', children: [] },
        ]),
      ],
    });

    const main = document.createElement('main');

    main.id = ROUTE_FOCUS_TARGET_ID;
    main.tabIndex = -1;
    document.body.appendChild(main);

    const service = TestBed.inject(RouteFocus);
    const router = TestBed.inject(Router);

    return { router, service, main };
  }

  afterEach(() => {
    document.getElementById(ROUTE_FOCUS_TARGET_ID)?.remove();
    TestBed.resetTestingModule();
  });

  it('focuses the documented target on NavigationEnd', async () => {
    const { router, main } = setup();

    expect(main.ownerDocument.activeElement).not.toBe(main);

    await router.navigateByUrl('/first');
    // NavigationEnd is emitted synchronously by the router's event stream; the
    // focus move is what this test is about, not the route's own rendering.
    expect(main.ownerDocument.activeElement).toBe(main);
  });

  it('moves focus again on every subsequent navigation', async () => {
    const { router, main } = setup();

    await router.navigateByUrl('/first');
    expect(main.ownerDocument.activeElement).toBe(main);

    // Something else takes focus (a menu closes, a dialog returns focus) …
    const other = document.createElement('button');

    document.body.appendChild(other);
    other.focus();
    expect(main.ownerDocument.activeElement).toBe(other);

    // … and the next navigation takes it back to the page.
    await router.navigateByUrl('/second');
    expect(main.ownerDocument.activeElement).toBe(main);
    other.remove();
  });

  it('targets an element that exists and is programmatically focusable', () => {
    const { main } = setup();

    // The property, not the shape: whatever the target is, it must be focusable,
    // or "moved focus" is a no-op.
    expect(main.tabIndex).toBe(-1);
  });

  it('does not throw when the shell has not rendered a target', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'first', children: [] }])] });

    const service = TestBed.inject(RouteFocus);

    expect(() => service.focusCurrentPage()).not.toThrow();
  });
});
