/**
 * Tests for the Q9/ P13 global keyboard shortcuts service.
 *
 * Covers:
 * - `?` and `F1` open the help dialog
 * - `/` focuses the tasks-table search input (when present)
 * - `c`/`C` navigates to the create-task page only with an active project context
 * - `t` navigates to the tasks table, `b` to the resolved board (project context only)
 * - `m`/`w`/`p` bump the user-menu / workspace / project-switcher toggle counters
 * - `x`/`X` toggles the sidebar via HlmSidebarService
 * - Guards: editable targets, open CDK overlays, modifier keys (Shift alone is fine)
 * - Pure helpers: isEditableTarget / hasOpenOverlay / findRouteParam
 */
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';
import { HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { ProjectStore } from '@stores/project-store';
import {
  KeyboardShortcuts,
  TASK_SEARCH_INPUT_SELECTOR,
  findRouteParam,
  hasOpenOverlay,
  isEditableTarget,
} from './keyboard-shortcuts';

function keydown(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/** Simulate a resolved route tree with an active project context (acme/proj). */
function stubProjectRoute(router: Router): void {
  vi.spyOn(router, 'routerState', 'get').mockReturnValue({
    snapshot: {
      root: {
        paramMap: convertToParamMap({}),
        children: [
          {
            paramMap: convertToParamMap({ tenantSlug: 'acme' }),
            children: [{ paramMap: convertToParamMap({ projectKey: 'proj' }), children: [] }],
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/** Flush pending microtasks (the `b` handler resolves promises before navigating). */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('KeyboardShortcuts', () => {
  let service: KeyboardShortcuts;
  let router: Router;
  let sidebarService: HlmSidebarService;

  beforeEach(() => {
    localStorage.clear();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: ProjectStore, useValue: { activeProject: () => ({ id: 'proj-1' }) } }],
    });

    router = TestBed.inject(Router);
    sidebarService = TestBed.inject(HlmSidebarService);
    service = TestBed.inject(KeyboardShortcuts);
  });

  afterEach(() => {
    document.querySelectorAll('[data-spec-temp]').forEach((el) => el.remove());
  });

  // ── Help dialog ────────────────────────────────────────────────

  it('should not show the help dialog initially', () => {
    expect(service.helpOpen()).toBe(false);
  });

  it('should open the help dialog on "?"', () => {
    keydown('?');

    expect(service.helpOpen()).toBe(true);
  });

  it('should open the help dialog on "F1"', () => {
    const event = new KeyboardEvent('keydown', { key: 'F1', bubbles: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    document.body.dispatchEvent(event);

    expect(service.helpOpen()).toBe(true);
    // F1 is the browser help key — must not reach native handling
    expect(preventDefault).toHaveBeenCalled();
  });

  it('should open the help dialog via openHelp()', () => {
    service.openHelp();

    expect(service.helpOpen()).toBe(true);
  });

  it('should close the help dialog via closeHelp()', () => {
    keydown('?');
    service.closeHelp();

    expect(service.helpOpen()).toBe(false);
  });

  // ── Search focus ───────────────────────────────────────────────

  it('should focus the tasks-table search input on "/"', () => {
    const input = document.createElement('input');

    input.setAttribute('data-task-table-search', '');
    input.setAttribute('data-spec-temp', '');
    document.body.appendChild(input);

    keydown('/');

    expect(document.activeElement).toBe(input);
  });

  it('should do nothing on "/" when no search input exists', () => {
    expect(() => keydown('/')).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  // ── Create-task navigation ─────────────────────────────────────

  it('should not navigate on "c" without an active project context', () => {
    const navigate = vi.spyOn(router, 'navigate');

    keydown('c');

    expect(navigate).not.toHaveBeenCalled();
  });

  it('should navigate to the create-task page on "c" when a project context is active', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    // Simulate a resolved route tree by stubbing the snapshot root
    stubProjectRoute(router);

    keydown('c');

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'tasks', 'new']);
  });

  // ── Uppercase letter hotkeys ───────────────────────────────────

  it('should navigate to the create-task page on "C" (Shift+c)', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    stubProjectRoute(router);

    keydown('C');

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'tasks', 'new']);
  });

  it('should still ignore "C" pressed with Ctrl (modifier guard wins)', () => {
    const navigate = vi.spyOn(router, 'navigate');

    stubProjectRoute(router);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, bubbles: true }));

    expect(navigate).not.toHaveBeenCalled();
  });

  // ── `t` — go to tasks ──────────────────────────────────────────

  it('should navigate to the tasks table on "t" when a project context is active', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    stubProjectRoute(router);

    keydown('t');

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'tasks']);
  });

  it('should navigate to the tasks table on "T" (case-insensitive)', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    stubProjectRoute(router);

    keydown('T');

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'tasks']);
  });

  it('should not navigate on "t" without an active project context', () => {
    const navigate = vi.spyOn(router, 'navigate');

    keydown('t');

    expect(navigate).not.toHaveBeenCalled();
  });

  // ── P13/ doc 102: `b` — go to the project's single board ──

  it('should navigate straight to the project board on "b" (no board fetch)', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    stubProjectRoute(router);

    keydown('b');
    await flushMicrotasks();

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'board']);
  });

  it('should navigate straight to the project board on "B" (uppercase)', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    stubProjectRoute(router);

    keydown('B');
    await flushMicrotasks();

    expect(navigate).toHaveBeenCalledWith(['/w', 'acme', 'projects', 'proj', 'board']);
  });

  // ── `m` / `w` / `p` — dropdown toggle counters ──

  it('should bump the user-menu toggle counter on "m" and "M"', () => {
    expect(service.userMenuToggle()).toBe(0);

    keydown('m');
    keydown('M');

    expect(service.userMenuToggle()).toBe(2);
  });

  it('should bump the workspace-switcher toggle counter on "w"', () => {
    expect(service.workspaceMenuToggle()).toBe(0);

    keydown('w');

    expect(service.workspaceMenuToggle()).toBe(1);
  });

  it('should bump the project-switcher toggle counter on "p"', () => {
    expect(service.projectMenuToggle()).toBe(0);

    keydown('p');

    expect(service.projectMenuToggle()).toBe(1);
  });

  // ── `x` — toggle sidebar ───────────────────────────────────────

  it('should toggle the sidebar on "x" and "X"', () => {
    const toggle = vi.spyOn(sidebarService, 'toggleSidebar');

    keydown('x');
    keydown('X');

    expect(toggle).toHaveBeenCalledTimes(2);
  });

  // ── Guards ─────────────────────────────────────────────────────

  it('should ignore shortcuts while focus is inside an editable element', () => {
    const input = document.createElement('input');

    input.setAttribute('data-spec-temp', '');
    document.body.appendChild(input);

    keydown('?', input);

    expect(service.helpOpen()).toBe(false);
  });

  it('should ignore shortcuts inside a contenteditable element (milkdown editor)', () => {
    const editor = document.createElement('div');

    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('data-spec-temp', '');
    document.body.appendChild(editor);

    keydown('?', editor);

    expect(service.helpOpen()).toBe(false);
  });

  it('should ignore shortcuts while a CDK overlay (dialog/popover/menu) is open', () => {
    const pane = document.createElement('div');

    pane.classList.add('cdk-overlay-pane');
    pane.setAttribute('data-spec-temp', '');
    // V9-7: only panes WITH content count as open — empty eager tooltip panes don't
    pane.appendChild(document.createElement('div'));
    document.body.appendChild(pane);

    keydown('?');

    expect(service.helpOpen()).toBe(false);

    pane.remove();
  });

  // ── M/w/p close their OWN menu through the overlay guard ──

  it('should bump the user-menu toggle on "m" while the user menu itself is open', () => {
    const pane = document.createElement('div');

    pane.classList.add('cdk-overlay-pane');
    pane.setAttribute('data-spec-temp', '');
    pane.appendChild(document.createElement('div'));
    document.body.appendChild(pane);

    service.userMenuOpen.set(true);

    const before = service.userMenuToggle();

    keydown('m');

    expect(service.userMenuToggle()).toBe(before + 1);

    pane.remove();
  });

  it('should NOT bump menu toggles while a DIFFERENT overlay is open', () => {
    const pane = document.createElement('div');

    pane.classList.add('cdk-overlay-pane');
    pane.setAttribute('data-spec-temp', '');
    pane.appendChild(document.createElement('div'));
    document.body.appendChild(pane);

    const beforeUser = service.userMenuToggle();
    const beforeWorkspace = service.workspaceMenuToggle();
    const beforeProject = service.projectMenuToggle();

    // user menu open, but "w" pressed → the workspace hotkey must stay blocked
    service.userMenuOpen.set(true);
    keydown('w');

    expect(service.workspaceMenuToggle()).toBe(beforeWorkspace);
    expect(service.userMenuToggle()).toBe(beforeUser);
    expect(service.projectMenuToggle()).toBe(beforeProject);

    pane.remove();
  });

  it('should ignore shortcut keys pressed with modifiers', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', ctrlKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', metaKey: true, bubbles: true }));

    expect(service.helpOpen()).toBe(false);
  });

  // ── Pure helpers ───────────────────────────────────────────────

  describe('isEditableTarget', () => {
    it('should detect inputs, textareas, selects and contenteditable elements', () => {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const select = document.createElement('select');
      const editable = document.createElement('div');
      const div = document.createElement('div');

      editable.setAttribute('contenteditable', 'true');

      expect(isEditableTarget(input)).toBe(true);
      expect(isEditableTarget(textarea)).toBe(true);
      expect(isEditableTarget(select)).toBe(true);
      expect(isEditableTarget(editable)).toBe(true);
      expect(isEditableTarget(div)).toBe(false);
      expect(isEditableTarget(null)).toBe(false);
    });
  });

  describe('hasOpenOverlay', () => {
    it('should report false without overlay panes and true when one exists', () => {
      expect(hasOpenOverlay(document)).toBe(false);

      const pane = document.createElement('div');

      pane.classList.add('cdk-overlay-pane');
      pane.setAttribute('data-spec-temp', '');
      // V9-7: only panes WITH content count as open — empty eager tooltip panes don't
      pane.appendChild(document.createElement('div'));
      document.body.appendChild(pane);

      expect(hasOpenOverlay(document)).toBe(true);
    });

    it('should ignore empty eager tooltip panes and visible tooltips', () => {
      const empty = document.createElement('div');

      empty.classList.add('cdk-overlay-pane');
      document.body.appendChild(empty);
      expect(hasOpenOverlay(document)).toBe(false);

      const tooltip = document.createElement('div');

      tooltip.classList.add('cdk-overlay-pane');
      tooltip.innerHTML = '<ng-component role="tooltip">Filters</ng-component>';
      document.body.appendChild(tooltip);
      expect(hasOpenOverlay(document)).toBe(false);

      empty.remove();
      tooltip.remove();
    });
  });

  describe('findRouteParam', () => {
    it('should find a parameter anywhere in the route tree (depth-first)', () => {
      const root = {
        paramMap: convertToParamMap({ tenantSlug: 'acme' }),
        children: [
          { paramMap: convertToParamMap({}), children: [] },
          { paramMap: convertToParamMap({ projectKey: 'proj' }), children: [] },
        ],
      } as unknown as ActivatedRouteSnapshot;

      expect(findRouteParam(root, 'tenantSlug')).toBe('acme');
      expect(findRouteParam(root, 'projectKey')).toBe('proj');
      expect(findRouteParam(root, 'missing')).toBe('');
    });
  });

  it('should expose the search-input selector constant', () => {
    expect(TASK_SEARCH_INPUT_SELECTOR).toBe('[data-task-table-search]');
  });
});
