import { DOCUMENT, Service, inject, signal } from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { fromEvent } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// Deep import: the `@spartan-ng/helm/sidebar` barrel re-exports every sidebar
// component (and, transitively, `helm/input` → `brain/field` → `@angular/forms`).
// This root-provided service only needs the service file itself, keeping the
// sidebar component library out of the initial bundle.
import { HlmSidebarService } from '@spartan-ng/helm/sidebar/service';

/**
 * Global keyboard shortcuts for the
 * authenticated shell.
 *
 * - `c` → navigate to the create-task page of the active project (only when a
 *   project context is active — the same route the "New Task" buttons use).
 * - `t` → navigate to the tasks table of the active project.
 * - `b` → navigate to the active project's board (preferences default board →
 *   first board; with no boards, to the board manager in project settings).
 * - `/` → focus the search input on the tasks table page (when present).
 * - `m` / `w` / `p` → toggle the user menu / workspace switcher / project
 *   switcher dropdowns. The service only bumps a counter signal; the owning
 *   component reacts with an `effect` and calls its `HlmDropdownMenuTrigger`'s
 *   `toggle()` — no DOM hacking, and the component keeps ownership of its menu.
 * - `x` → minimize/maximize the sidebar (`HlmSidebarService.toggleSidebar()`).
 * - `?` / `F1` → open the shortcut-help dialog (rendered by the app shell).
 *
 * Letter hotkeys are case-insensitive (`C` = Shift+c works too); combos with
 * Ctrl/Cmd/Alt are always ignored. Shortcuts are ignored while focus sits
 * inside an editable element (input/textarea/select/contenteditable — covers
 * the Milkdown editor) and while any CDK overlay (dialog/sheet/popover/menu)
 * is open — so `m`/`w`/`p` only OPEN via hotkey; while the menu is open the
 * overlay guard routes keys to the menu (Esc closes it). The service is
 * provided in the ROOT injector (`app.config.ts`) so that both the app shell
 * (dialog binding) and the header's help menu (Hotkeys item) resolve the SAME
 * instance — providing it in AppShell would give HelpMenu a second instance
 * whose `helpOpen` is not bound to the dialog.
 *
 * Repo rules forbid `@HostListener`/`@HostBinding` — the listener is a plain
 * `fromEvent(document, 'keydown')` subscription torn down via
 * `takeUntilDestroyed()`.
 */

/** Marker attribute on the tasks-table search input (`/` focuses it). */
export const TASK_SEARCH_INPUT_SELECTOR = '[data-task-table-search]';

/**
 * True when the event target is an editable element that must receive keystrokes.
 * Checks BOTH `isContentEditable` and the raw attribute — some environments
 * (jsdom) do not reflect `contenteditable` into the property.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;

  if (!el) return false;

  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true ||
    el.hasAttribute('contenteditable')
  );
}

/**
 * True while any CDK overlay pane (dialog/sheet/popover/menu) is open.
 * V9-7: hlmTooltip eagerly creates EMPTY detached panes in the DOM — a pane
 * with no element children is ignored. A visible TOOLTIP pane is passive and
 * must not block shortcuts either.
 */
export function hasOpenOverlay(doc: Document): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>('.cdk-overlay-pane')).some((pane) => {
    if (!pane.firstElementChild) return false;

    return !pane.querySelector('[role="tooltip"]');
  });
}

/**
 * Depth-first search for a route parameter across the activated route tree.
 * Path params are not inherited downwards, so every segment must be checked.
 */
export function findRouteParam(root: ActivatedRouteSnapshot, name: string): string {
  const stack: ActivatedRouteSnapshot[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as ActivatedRouteSnapshot;
    const value = node.paramMap.get(name);

    if (value) return value;

    stack.push(...node.children);
  }

  return '';
}

@Service()
export class KeyboardShortcuts {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly sidebarService = inject(HlmSidebarService);
  /** Bound to the shell's help dialog (`[state]`). */
  readonly helpOpen = signal(false);
  /**
   * Toggle counters for the shell dropdowns. `m`/`w`/`p`
   * increment these; the owning component (UserMenu / TenantSwitcher /
   * ProjectSwitcher) reacts with an `effect` and opens/closes its dropdown via
   * its `HlmDropdownMenuTrigger` (state-aware — see `openFocused`/`close`).
   * Counter (not boolean) so repeated presses always fire the effect even when
   * the value would be unchanged.
   */
  readonly userMenuToggle = signal(0);
  readonly workspaceMenuToggle = signal(0);
  readonly projectMenuToggle = signal(0);
  /**
   * Live open state of the three shell dropdowns, reported by the owning
   * components via the trigger's `hlmDropdownMenuOpened`/`hlmDropdownMenuClosed`
   * outputs. Lets `m`/`w`/`p` pass the overlay guard while THEIR OWN menu is
   * open (to close it) without re-enabling hotkeys while other overlays
   * (dialogs/popovers/other menus) are open.
   */
  readonly userMenuOpen = signal(false);
  readonly workspaceMenuOpen = signal(false);
  readonly projectMenuOpen = signal(false);

  constructor() {
    fromEvent<KeyboardEvent>(this.document, 'keydown')
      .pipe(takeUntilDestroyed())
      .subscribe((event) => this.onKeydown(event));
  }

  /** Open the help dialog (also used by the header help-menu "Hotkeys" item). */
  openHelp(): void {
    this.helpOpen.set(true);
  }

  /** Close the help dialog (wired to the dialog's `stateChanged`). */
  closeHelp(): void {
    this.helpOpen.set(false);
  }

  private onKeydown(event: KeyboardEvent): void {
    // Never hijack modified keystrokes (browser/devtools shortcuts).
    // Shift alone is fine — that's how `C`/`M`/… arrive.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Typing context wins — inputs, textareas and contenteditable editors
    if (isEditableTarget(event.target)) return;

    // Letter hotkeys are case-insensitive; multi-char keys (F1, '?', '/') pass through
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    // An open overlay (dialog/popover/menu/sheet) captures the interaction —
    // EXCEPT the hotkey that owns the currently open dropdown menu, which must
    // still toggle it closed (P13b: `m` while the user menu is open closes it).
    if (hasOpenOverlay(this.document)) {
      const ownsOpenMenu =
        (key === 'm' && this.userMenuOpen()) ||
        (key === 'w' && this.workspaceMenuOpen()) ||
        (key === 'p' && this.projectMenuOpen());

      if (ownsOpenMenu) {
        event.preventDefault();
        this.bumpMenuToggle(key);
      }

      return;
    }

    switch (key) {
      case '?':
        event.preventDefault();
        this.helpOpen.set(true);
        break;

      case 'F1':
        // F1 is the browser help key — preventDefault stops the native help UI
        event.preventDefault();
        this.helpOpen.set(true);
        break;

      case '/': {
        const input = this.document.querySelector<HTMLInputElement>(TASK_SEARCH_INPUT_SELECTOR);

        if (input) {
          event.preventDefault();
          input.focus();
        }
        break;
      }

      // `c` / `t` / `b` only act when a project context is actually active
      case 'c': {
        const ctx = this.projectContext();

        if (ctx) {
          event.preventDefault();
          this.router.navigate(['/w', ctx.tenantSlug, 'projects', ctx.projectKey, 'tasks', 'new']);
        }
        break;
      }

      case 't': {
        const ctx = this.projectContext();

        if (ctx) {
          event.preventDefault();
          this.router.navigate(['/w', ctx.tenantSlug, 'projects', ctx.projectKey, 'tasks']);
        }
        break;
      }

      case 'b': {
        const ctx = this.projectContext();

        if (ctx) {
          event.preventDefault();
          this.navigateToBoard(ctx);
        }
        break;
      }

      case 'm':
        event.preventDefault();
        this.bumpMenuToggle('m');
        break;

      case 'w':
        event.preventDefault();
        this.bumpMenuToggle('w');
        break;

      case 'p':
        event.preventDefault();
        this.bumpMenuToggle('p');
        break;

      case 'x':
        event.preventDefault();
        this.sidebarService.toggleSidebar();
        break;
    }
  }

  /** Bump the toggle counter of the dropdown owned by `key` (m/w/p). */
  private bumpMenuToggle(key: string): void {
    if (key === 'm') this.userMenuToggle.update((n) => n + 1);
    else if (key === 'w') this.workspaceMenuToggle.update((n) => n + 1);
    else if (key === 'p') this.projectMenuToggle.update((n) => n + 1);
  }

  /** tenantSlug + projectKey of the active route, or null outside a project context. */
  private projectContext(): { tenantSlug: string; projectKey: string } | null {
    const root = this.router.routerState.snapshot.root;
    const tenantSlug = findRouteParam(root, 'tenantSlug');
    const projectKey = findRouteParam(root, 'projectKey');

    return tenantSlug && projectKey ? { tenantSlug, projectKey } : null;
  }

  /**
   * `b` — navigate straight to the project board. Single-board model (doc 102):
   * the project has exactly one board, so no fetch, no resolution.
   */
  private navigateToBoard(ctx: { tenantSlug: string; projectKey: string }): void {
    this.router.navigate(['/w', ctx.tenantSlug, 'projects', ctx.projectKey, 'board']);
  }
}
