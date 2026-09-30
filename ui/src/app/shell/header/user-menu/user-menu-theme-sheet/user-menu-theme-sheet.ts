import { Component, DestroyRef, ElementRef, computed, effect, inject, model, signal, viewChild } from '@angular/core';
import { DEFAULT_THEME_ID, ExpandState } from '@task-board/shared';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { injectThemePickToasts } from '@app/shared/utils/theme-pick-toast';
import { PreferencesStore } from '@stores/preferences-store';
import { ThemeRegistry } from '@services/theme-registry';
import { ThemeModeSwitch } from '@app/shared/theme-mode-switch/theme-mode-switch';

/** Minimum button width in pixels (w-46 = 11.5rem = 184px) */
const MIN_BUTTON_WIDTH = 184;
/** Horizontal gap between grid items in pixels (gap-x-6 = 1.5rem = 24px) */
const GRID_GAP_X = 24;

@Component({
  selector: 'ui-user-menu-theme-sheet',
  standalone: true,
  imports: [HlmSheetImports, HlmButtonImports, TranslocoPipe, ThemeModeSwitch, NgIcon],
  providers: [provideIcons({ lucideCheck })],
  templateUrl: './user-menu-theme-sheet.html',
  styleUrl: './user-menu-theme-sheet.css',
})
export class UserMenuThemeSheet {
  private readonly destroyRef = inject(DestroyRef);
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly themeRegistry = inject(ThemeRegistry);
  private readonly notify = injectThemePickToasts();
  protected readonly open = model<ExpandState>(ExpandState.Closed);
  /**
   * Initial focus target when the sheet opens: the radio of the ACTIVE mode in
   * the Auto/Light/Dark selector (NOT the first theme button). The CDK dialog
   * resolves this selector inside the sheet content after it renders.
   */
  protected readonly initialFocusSelector = 'input[type="radio"]:checked';
  /** Mode selector instance — used to hand focus back on the listbox top-row Up boundary. */
  private readonly modeSwitch = viewChild(ThemeModeSwitch);
  /** Theme listbox grid element. */
  private readonly themeGrid = viewChild<ElementRef<HTMLDivElement>>('themeGrid');
  /** Minimum column width for CSS auto-fill grid */
  protected readonly minColumnWidth = `${MIN_BUTTON_WIDTH}px`;
  /**
   * Currently highlighted theme during keyboard navigation (not yet applied).
   * Non-null ONLY while real DOM focus is inside the theme grid — leaving the
   * grid (to the mode switch or anywhere else) clears it, so exactly one
   * region (listbox highlight OR mode-switch pill) highlights at a time.
   */
  private readonly focusedTheme = signal<string | null>(null);
  /** Last highlighted theme id — used to restore the highlight when focus returns to the grid. */
  private lastHighlightedId: string | null = null;
  /** Mode-aware theme list: dark mode → dark themes only, light mode → light themes only, auto → all. */
  private readonly visibleThemes = computed(() => {
    const themes = this.themeRegistry.themes();
    const mode = this.preferencesStore.themeMode();

    if (mode === 'dark') return themes.filter((t) => t.mode === 'dark');
    if (mode === 'light') return themes.filter((t) => t.mode === 'light');

    return themes;
  });
  /** Theme chosen for light mode (null → default light theme). */
  private readonly selectedLightTheme = computed(() => this.preferencesStore.lightTheme() ?? DEFAULT_THEME_ID);
  /** Theme chosen for dark mode (null → default dark theme). */
  private readonly selectedDarkTheme = computed(() => this.preferencesStore.darkTheme() ?? 'dark');

  /**
   * Whether the theme is one of the two per-mode selections — marked with a
   * checkmark + primary name chip regardless of the active mode, so in Auto
   * mode both the chosen light and the chosen dark theme stay visible.
   */
  protected isSelected(themeId: string): boolean {
    return themeId === this.selectedLightTheme() || themeId === this.selectedDarkTheme();
  }

  constructor() {
    // Load manifest only when the sheet is actually opened by the user.
    effect(() => {
      if (this.open() === ExpandState.Open) {
        this.themeRegistry.load();
        // No listbox highlight on open: initial focus sits on the mode
        // switch, and only one region may highlight at a time. The highlight
        // appears once focus enters the grid (Down handoff / Tab).
      }
    });

    // Commit pending theme preferences to backend when the sheet is closed.
    effect(() => {
      if (this.open() === ExpandState.Closed) {
        this.preferencesStore.commitTheme();
      }
    });

    // Safety net: commit on component destroy (e.g. navigation while sheet is open).
    this.destroyRef.onDestroy(() => this.preferencesStore.commitTheme());
  }

  private selectTheme(themeId: string): void {
    if (themeId !== this.preferencesStore.selectedTheme()) {
      const mode = this.themeRegistry.findById(themeId)?.mode ?? 'light';

      this.preferencesStore.setThemeChoiceLocal(themeId, mode);
      // Warn when the pick will not be applied right now (e.g. Auto mode with a
      // browser scheme differing from the picked theme's mode).
      this.notify.warnIfDeferred(themeId, mode, this.preferencesStore.effectiveTheme());
    }
    // NOTE: the highlight is intentionally NOT reset here — it stays on the
    // picked theme so keyboard navigation continues from it.
  }

  /** Set the highlight; non-null values are remembered for focus-return restore. */
  private setHighlight(themeId: string | null): void {
    if (themeId !== null) this.lastHighlightedId = themeId;
    this.focusedTheme.set(themeId);
  }

  /** Sync the keyboard-nav highlight with real DOM focus (Tab / click focus). */
  protected onThemeFocus(themeId: string): void {
    this.setHighlight(themeId);
  }

  /**
   * Focus left the grid (to the mode switch or anywhere outside): clear the
   * highlight so no theme stays ringed while another region is active. The
   * last highlighted id is kept for restore on return.
   */
  protected onGridFocusout(event: FocusEvent): void {
    const grid = event.currentTarget as HTMLElement;
    const next = event.relatedTarget;

    if (!(next instanceof Node) || !grid.contains(next)) {
      this.focusedTheme.set(null);
    }
  }

  /** Get the theme that should be visually highlighted — null when focus is outside the grid. */
  protected getHighlightedTheme(): string | null {
    return this.focusedTheme();
  }

  /**
   * Compute the current number of columns from the grid DOM layout.
   * Used for keyboard navigation (ArrowUp/ArrowDown).
   */
  private computeColumns(gridEl: HTMLElement): number {
    const firstButton = gridEl.querySelector<HTMLElement>('button[data-theme]');

    if (!firstButton) return 1;

    const buttonWidth = firstButton.getBoundingClientRect().width;

    return Math.max(1, Math.floor((gridEl.clientWidth + GRID_GAP_X) / (buttonWidth + GRID_GAP_X)));
  }

  protected onThemeKeydown(event: KeyboardEvent): void {
    const themes = this.visibleThemes();
    // Navigation resumes from the current highlight; if it was cleared (focus
    // had left the grid), resume from the last highlighted theme, else first.
    const currentHighlighted = this.focusedTheme() ?? this.lastHighlightedId ?? themes[0]?.id ?? null;
    const currentIndex = themes.findIndex((t) => t.id === currentHighlighted);
    const grid = event.currentTarget as HTMLElement;
    const cols = this.computeColumns(grid);
    const rows = Math.ceil(themes.length / cols);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') {
      const col = currentIndex % cols;

      if (col < cols - 1 && currentIndex + 1 < themes.length) {
        nextIndex = currentIndex + 1;
      }
    } else if (event.key === 'ArrowLeft') {
      const col = currentIndex % cols;

      if (col > 0) {
        nextIndex = currentIndex - 1;
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();

      const row = Math.floor(currentIndex / cols);

      if (row < rows - 1) {
        nextIndex = Math.min(currentIndex + cols, themes.length - 1);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();

      const row = Math.floor(currentIndex / cols);

      if (row === 0) {
        // Top-row boundary: hand focus back to the mode selector, onto the
        // button of the currently active mode.
        this.focusModeSwitch();
        return;
      }

      nextIndex = currentIndex - cols;
    } else if (event.key === 'Enter' || event.key === ' ') {
      // Don't scroll the block when space is pressed
      event.preventDefault();

      if (currentHighlighted) this.selectTheme(currentHighlighted);

      return;
    } else if (event.key === 'Escape') {
      // Cancel navigation, clear the highlight (restorable on next arrow)
      this.setHighlight(null);
      return;
    } else {
      return;
    }

    const nextTheme = themes[nextIndex];

    if (nextTheme) {
      this.setHighlight(nextTheme.id);

      const focusedButton = grid.querySelector<HTMLElement>(`[data-theme="${nextTheme.id}"]`);

      focusedButton?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }

  /**
   * Hand focus back to the mode selector, onto the radio of the currently
   * active mode (Up from the listbox top row). The highlight is cleared —
   * the last highlighted id stays remembered for the return trip.
   */
  private focusModeSwitch(): void {
    this.setHighlight(null);
    this.modeSwitch()?.focusActive();
  }

  /**
   * Move focus into the theme listbox (Down from the mode selector),
   * restoring the LAST highlighted theme — or the first item if none.
   */
  protected focusThemeGrid(): void {
    const gridEl = this.themeGrid()?.nativeElement;

    if (!gridEl) return;

    const restoreButton = this.lastHighlightedId
      ? gridEl.querySelector<HTMLElement>(`button[data-theme="${this.lastHighlightedId}"]`)
      : null;
    const button = restoreButton ?? gridEl.querySelector<HTMLElement>('button[data-theme]');

    if (!button) return;

    const themeId = button.getAttribute('data-theme');

    if (themeId) this.setHighlight(themeId);
    // Native focus() scrolling brings the button into view.
    button.focus();
  }
}
