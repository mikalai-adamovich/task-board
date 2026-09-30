/**
 * Tests for the user-menu theme sheet.
 *
 * Covers:
 * - BOTH per-mode selections (light + dark) are marked as selected regardless
 *   of the active mode (the Auto-mode "hidden selection" UX fix)
 * - A cross-mode pick (theme that will NOT be applied right now, e.g. Auto
 *   mode + browser scheme differing from the picked theme's mode) fires a
 *   neutral warning toast (with alert icon); a same-mode pick does not
 * - Keyboard navigation between the mode selector and the theme listbox:
 *   Up from the top row hands focus back to the mode selector (active mode),
 *   Down from the mode selector enters the listbox on its first item, and
 *   in-listbox arrows move REAL DOM focus together with the highlight
 * - Highlight continuity: the highlight follows real focus and is NOT reset by
 *   a pick (arrows continue from the picked theme instead of jumping to the
 *   selection)
 * - Single-region highlight: the listbox highlight is cleared whenever focus
   leaves the grid (mode switch or elsewhere) and restored to the LAST
   highlighted theme when focus returns (Down handoff); no highlight on open
 * - Scrolling: arrow navigation smooth-scrolls the highlighted button into
 *   view (block: 'end') without moving DOM focus (focus() scrolling jumps)
 * - No focus-visible ring on theme buttons (the preview's ring-2 ring-primary
 *   for the active theme is sufficient)
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslocoTestingModule, TranslocoService } from '@jsverse/transloco';
import { signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toast } from '@spartan-ng/brain/sonner';
import { buttonVariants } from '@spartan-ng/helm/button';
import { twMerge } from 'tailwind-merge';
import { ExpandState } from '@task-board/shared';
import { UserMenuThemeSheet } from './user-menu-theme-sheet';
import { PreferencesStore } from '@stores/preferences-store';
import { ThemeRegistry } from '@services/theme-registry';
import { ToastAlertIcon } from '@app/shared/toast-alert-icon/toast-alert-icon';
import { settle } from '@app/shared/testing/zoneless';

describe('UserMenuThemeSheet', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<UserMenuThemeSheet>;
  let preferencesStoreMock: {
    themeMode: ReturnType<typeof signal<string>>;
    lightTheme: ReturnType<typeof signal<string | null>>;
    darkTheme: ReturnType<typeof signal<string | null>>;
    selectedTheme: ReturnType<typeof signal<string>>;
    effectiveTheme: ReturnType<typeof signal<string>>;
    setThemeChoiceLocal: ReturnType<typeof vi.fn>;
    commitTheme: ReturnType<typeof vi.fn>;
  };
  let themeRegistryMock: {
    themes: ReturnType<typeof signal>;
    findById: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };

  async function setup(): Promise<void> {
    preferencesStoreMock = {
      themeMode: signal('auto'),
      lightTheme: signal('light'),
      darkTheme: signal('dark'),
      selectedTheme: signal('light'),
      effectiveTheme: signal('light'),
      // Simulate Auto mode with a light-preferring browser: light picks apply
      // immediately, dark picks stay deferred (effective theme unchanged).
      setThemeChoiceLocal: vi.fn((id: string, mode: 'light' | 'dark') => {
        if (mode === 'light') preferencesStoreMock.effectiveTheme.set(id);
      }),
      commitTheme: vi.fn(),
    };

    // `preview` colors are needed because opening the sheet actually renders
    // the theme grid template in the test bed.
    const themes = ['light', 'ocean', 'dark', 'contrast'].map((id, i) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      mode: i < 2 ? ('light' as const) : ('dark' as const),
      preview: { card: '#fff', border: '#000', foreground: '#111', muted: '#eee', primary: '#333' },
    }));

    themeRegistryMock = {
      themes: signal(themes),
      findById: vi.fn((id: string) => themes.find((t) => t.id === id)),
      load: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: {
            en: {
              themes: {
                modeLight: 'Light',
                modeDark: 'Dark',
                deferredToast:
                  'Theme saved. It will be applied when Auto switches to {{mode}}, or switch the mode to {{mode}} now.',
              },
            },
          },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        { provide: PreferencesStore, useValue: preferencesStoreMock },
        { provide: ThemeRegistry, useValue: themeRegistryMock },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(UserMenuThemeSheet);
    component = fixture.componentInstance;
    await settle(fixture);
  }

  beforeEach(() => {
    vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Both per-mode selections are marked, regardless of the active mode ───

  it('should mark BOTH per-mode selections as selected in auto mode', async () => {
    await setup();

    expect(component.isSelected('light')).toBe(true);
    expect(component.isSelected('dark')).toBe(true);
    // Non-selected themes are not marked
    expect(component.isSelected('ocean')).toBe(false);
    expect(component.isSelected('contrast')).toBe(false);
  });

  it('should mark both selections even when the effective theme is only one of them', async () => {
    // Auto mode, browser prefers light → effective is the light selection,
    // but the dark selection must still be marked.
    preferencesStoreMock.effectiveTheme.set('light');
    preferencesStoreMock.selectedTheme.set('light');
    await setup();

    expect(component.isSelected('dark')).toBe(true);
    expect(component.isSelected('light')).toBe(true);
  });

  it('should fall back to the default theme ids when a per-mode choice is unset', async () => {
    preferencesStoreMock.lightTheme.set(null);
    preferencesStoreMock.darkTheme.set(null);
    await setup();

    expect(component.isSelected('light')).toBe(true);
    expect(component.isSelected('dark')).toBe(true);
    expect(component.isSelected('ocean')).toBe(false);
  });

  // ── Neutral warning toast on a "hidden" (cross-mode) pick ────────────────

  it('should show a neutral warning toast when the picked theme will not be applied now', async () => {
    await setup();
    // Preload the lang so synchronous translate() resolves real strings
    await firstValueFrom(TestBed.inject(TranslocoService).selectTranslate('themes.deferredToast'));

    // Auto mode, browser prefers light → picking a dark theme is deferred
    component.selectTheme('contrast');

    expect(preferencesStoreMock.setThemeChoiceLocal).toHaveBeenCalledWith('contrast', 'dark');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      'Theme saved. It will be applied when Auto switches to Dark, or switch the mode to Dark now.',
      expect.objectContaining({ icon: ToastAlertIcon }),
    );
  });

  it('should NOT show a toast when the picked theme is applied immediately', async () => {
    await setup();

    // Auto mode, browser prefers light → picking a light theme applies at once
    component.selectTheme('ocean');

    expect(preferencesStoreMock.setThemeChoiceLocal).toHaveBeenCalledWith('ocean', 'light');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  // ── Keyboard navigation: mode selector ⇄ theme listbox ───────────────────

  /** jsdom reports clientWidth 0 → force a deterministic 2-column grid via a fake element. */
  interface FakeThemeButton {
    focus: ReturnType<typeof vi.fn>;
    scrollIntoView: ReturnType<typeof vi.fn>;
    getBoundingClientRect: () => { width: number };
    getAttribute: (name: string) => string | null;
  }

  function makeGrid(): { grid: Record<string, unknown>; buttons: Record<string, FakeThemeButton> } {
    const buttons: Record<string, FakeThemeButton> = {};

    for (const id of ['light', 'ocean', 'dark', 'contrast']) {
      buttons[id] = {
        focus: vi.fn(),
        scrollIntoView: vi.fn(),
        // 184px wide buttons + 392px clientWidth → floor((392+24)/(184+24)) = 2 columns
        getBoundingClientRect: () => ({ width: 184 }),
        getAttribute: (name: string) => (name === 'data-theme' ? id : null),
      };
    }

    const grid = {
      clientWidth: 392,
      contains: vi.fn(() => false),
      querySelector: vi.fn((selector: string) => {
        if (selector === 'button[data-theme]') return buttons['light'];

        const match = selector.match(/\[data-theme="(.+)"\]/);

        return match && match[1] ? buttons[match[1]] : null;
      }),
    };

    return { grid, buttons };
  }

  function makeGridEvent(key: string, grid: Record<string, unknown>): KeyboardEvent {
    return { key, preventDefault: vi.fn(), currentTarget: grid } as unknown as KeyboardEvent;
  }

  function makeFocusoutEvent(grid: Record<string, unknown>, relatedTarget: EventTarget | null): FocusEvent {
    return { currentTarget: grid, relatedTarget } as unknown as FocusEvent;
  }

  it('should hand focus back to the mode selector (active mode) on ArrowUp from the top row', async () => {
    await setup();

    const focusActive = vi.fn();

    // Stub the private viewChild signal — the sheet portal content is not rendered in unit tests.
    component.modeSwitch = signal({ focusActive });

    const { grid } = makeGrid();

    component.focusedTheme.set('light'); // index 0 → top row

    component.onThemeKeydown(makeGridEvent('ArrowUp', grid));

    expect(focusActive).toHaveBeenCalledTimes(1);
    expect(component.focusedTheme()).toBeNull();
  });

  it('should move the highlight up on ArrowUp from a non-top row and smooth-scroll it into view', async () => {
    await setup();

    const { grid, buttons } = makeGrid();

    component.focusedTheme.set('dark'); // index 2 → row 1

    component.onThemeKeydown(makeGridEvent('ArrowUp', grid));

    expect(component.focusedTheme()).toBe('light');
    // Scrolling is driven by an explicit smooth scrollIntoView (focus() jumps).
    expect(buttons['light']?.focus).not.toHaveBeenCalled();
    expect(buttons['light']?.scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
  });

  it('should move the highlight on horizontal arrows and smooth-scroll it into view', async () => {
    await setup();

    const { grid, buttons } = makeGrid();

    component.focusedTheme.set('light'); // index 0

    component.onThemeKeydown(makeGridEvent('ArrowRight', grid));

    expect(component.focusedTheme()).toBe('ocean');
    expect(buttons['ocean']?.focus).not.toHaveBeenCalled();
    expect(buttons['ocean']?.scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
  });

  it('should focus the FIRST theme item on focusThemeGrid when nothing was highlighted before', async () => {
    await setup();

    const { grid, buttons } = makeGrid();

    // Stub the private viewChild signal — the sheet portal content is not rendered in unit tests.
    component.themeGrid = signal({ nativeElement: grid });

    component.focusThemeGrid();

    expect(buttons['light']?.focus).toHaveBeenCalledTimes(1);
    expect(component.focusedTheme()).toBe('light');
    // Native focus() scrolling only — no explicit scrollIntoView.
    expect(buttons['light']?.scrollIntoView).not.toHaveBeenCalled();
  });

  it('should RESTORE the last highlighted theme on focusThemeGrid (Down handoff after focus-out)', async () => {
    await setup();

    const { grid, buttons } = makeGrid();

    component.themeGrid = signal({ nativeElement: grid });

    // Navigate to 'ocean' (records it as the last highlighted theme)…
    component.focusedTheme.set('light');
    component.onThemeKeydown(makeGridEvent('ArrowRight', grid));
    expect(component.focusedTheme()).toBe('ocean');

    // …then focus leaves the grid (highlight cleared, memory kept)…
    component.onGridFocusout(makeFocusoutEvent(grid, null));
    expect(component.focusedTheme()).toBeNull();

    // …and the Down handoff restores the LAST highlighted theme.
    (buttons['ocean']?.focus as ReturnType<typeof vi.fn>).mockClear();
    component.focusThemeGrid();

    expect(buttons['ocean']?.focus).toHaveBeenCalledTimes(1);
    expect(component.focusedTheme()).toBe('ocean');
  });

  // ── Highlight continuity: independent of the selection ───────────────────

  it('should NOT highlight any theme when the sheet opens (focus starts on the mode switch)', async () => {
    await setup();

    preferencesStoreMock.effectiveTheme.set('ocean');
    component.open.set(ExpandState.Open);
    await settle(fixture); // flush the open-effect

    // Only one region highlights at a time: with focus on the mode switch the
    // listbox shows no highlight (previously it fell back to the selection).
    expect(component.getHighlightedTheme()).toBeNull();
  });

  it('should KEEP the highlight on the picked theme after a pick (no reset to the selection)', async () => {
    await setup();

    const { grid } = makeGrid();

    // Navigate to the dark theme (index 3) and pick it. In the Auto +
    // light-browser mock the selection stays 'light' — the highlight must not
    // jump back to it.
    component.focusedTheme.set('contrast');
    component.onThemeKeydown(makeGridEvent('Enter', grid));

    expect(preferencesStoreMock.setThemeChoiceLocal).toHaveBeenCalledWith('contrast', 'dark');
    expect(component.getHighlightedTheme()).toBe('contrast');

    // Arrows continue from the picked theme, not from the selection.
    component.onThemeKeydown(makeGridEvent('ArrowUp', grid));
    expect(component.focusedTheme()).toBe('ocean');
  });

  it('should sync the highlight when a theme button receives real focus', async () => {
    await setup();

    component.onThemeFocus('dark');

    expect(component.focusedTheme()).toBe('dark');
    expect(component.getHighlightedTheme()).toBe('dark');
  });

  it('should CLEAR the listbox highlight when focus leaves the grid (no double highlight with the mode switch)', async () => {
    await setup();

    const { grid } = makeGrid();

    component.focusedTheme.set('dark');

    // Focus moves outside the grid (e.g. to the mode switch radio).
    component.onGridFocusout(makeFocusoutEvent(grid, document.createElement('input')));

    expect(component.focusedTheme()).toBeNull();
    expect(component.getHighlightedTheme()).toBeNull();
  });

  it('should KEEP the highlight when focus moves WITHIN the grid (button → button)', async () => {
    await setup();

    const { grid } = makeGrid();

    component.focusedTheme.set('dark');

    // A real Node inside the grid (fake grid reports it as contained).
    const innerButton = document.createElement('button');

    (grid.contains as ReturnType<typeof vi.fn>).mockReturnValue(true);
    component.onGridFocusout(makeFocusoutEvent(grid, innerButton));

    expect(component.focusedTheme()).toBe('dark');
  });

  it('should remember the last highlighted theme on the Up handoff and restore it on the Down handoff', async () => {
    await setup();

    const focusActive = vi.fn();

    component.modeSwitch = signal({ focusActive });

    const { grid, buttons } = makeGrid();

    component.themeGrid = signal({ nativeElement: grid });

    // Navigate to 'ocean' (records it as the last highlighted theme), then Up
    // from the top row hands focus to the mode switch.
    component.focusedTheme.set('light');
    component.onThemeKeydown(makeGridEvent('ArrowRight', grid)); // → ocean, lastHighlighted = ocean
    component.onThemeKeydown(makeGridEvent('ArrowUp', grid)); // row 0 → handoff to mode switch

    expect(focusActive).toHaveBeenCalledTimes(1);
    expect(component.focusedTheme()).toBeNull();

    // Down from the mode switch restores the last highlighted theme.
    (buttons['ocean']?.focus as ReturnType<typeof vi.fn>).mockClear();
    component.focusThemeGrid();

    expect(buttons['ocean']?.focus).toHaveBeenCalledTimes(1);
    expect(component.focusedTheme()).toBe('ocean');
  });

  // ── Smooth scrolling ─────────────────────────────────────────────────────

  it('should smooth-scroll each navigated theme into view (block end) without moving focus', async () => {
    await setup();

    const { grid, buttons } = makeGrid();

    component.focusedTheme.set('light'); // index 0

    component.onThemeKeydown(makeGridEvent('ArrowRight', grid));

    expect(component.focusedTheme()).toBe('ocean');
    expect(buttons['ocean']?.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(buttons['ocean']?.scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
    expect(buttons['ocean']?.focus).not.toHaveBeenCalled();
  });

  // ── No focus-visible ring on theme buttons ───────────────────────────────

  it('should override the hlmBtn focus-visible ring on theme buttons (preview ring is sufficient)', () => {
    // The sheet portal content is not rendered in unit tests, so verify the
    // class override through the same merge path HlmButton uses (twMerge):
    // the theme button class must cancel the variant's focus-visible ring.
    const template = readFileSync(join(__dirname, 'user-menu-theme-sheet.html'), 'utf8');
    const buttonClass = template.match(/class="([^"]*h-40[^"]*)"/)?.[1];

    expect(buttonClass).toBeTruthy();

    const merged = twMerge(buttonVariants({ variant: 'outline' }), buttonClass);

    expect(merged).not.toContain('focus-visible:ring-3');
    expect(merged).not.toContain('focus-visible:border-ring');
    expect(merged).toContain('focus-visible:ring-0');
  });

  // ── Accessible name ───────────────────────────────────────────────────────

  it('should mark the sheet title with the hlmSheetTitle ATTRIBUTE directive', () => {
    // The sheet's `<h3 hlm-sheet-title>` was a dangling aria-labelledby.
    // BrnDialog (the CDK layer behind HlmSheetContent) puts
    // `aria-labelledby="brn-dialog-title-<id>"` on its container, and the id
    // only exists if BrnDialogTitle instantiated — which requires the vendored
    // `HlmSheetTitle`, and that is an ATTRIBUTE directive
    // (`selector: '[hlmSheetTitle]'` in ui/libs/ui/sheet/src/lib/
    // hlm-sheet-title.ts). There is no `<hlm-sheet-title>` element component,
    // and the dash-case spelling left the id unset.
    //
    // The portal body is not rendered in unit tests (see above), so this is
    // asserted on the template source — the same approach the focus-ring test
    // above already uses.
    // Comments are stripped: the explanatory comment above spells both
    // spellings out, and a comment is not markup.
    const template = readFileSync(join(__dirname, 'user-menu-theme-sheet.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );

    expect(template).toMatch(/<h[1-6]\s+hlmSheetTitle\b/);
    expect(template).not.toMatch(/\bhlm-sheet-title\b/);
  });

  it('should keep a text name on the sheet content itself', () => {
    // Belt and braces: even if the id link were lost again, the content element
    // still carries aria-label, so the dialog is never unlabelled.
    const template = readFileSync(join(__dirname, 'user-menu-theme-sheet.html'), 'utf8');

    expect(template).toMatch(/hlm-sheet-content[\s\S]*?\[attr\.aria-label\]/);
  });
});
