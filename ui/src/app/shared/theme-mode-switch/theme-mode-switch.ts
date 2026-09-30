import { ChangeDetectionStrategy, Component, ElementRef, inject, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMonitor, lucideMoon, lucideSun } from '@ng-icons/lucide';
import { HlmRadioGroupImports } from '@spartan-ng/helm/radio-group';
import type { ThemeMode } from '@task-board/shared';
import { PreferencesStore } from '@stores/preferences-store';

/**
 * Segmented Auto/Light/Dark mode selector built on the Spartan radio-group.
 * Auto → monitor icon (first), Light → sun icon, Dark → moon icon.
 * Writes the mode through the PreferencesStore (local apply + pending backend commit).
 *
 * Keyboard model (horizontal-only):
 * - Left/Right arrows keep the native radio-group behavior and switch the mode.
 * - Up/Down are blocked (no vertical radio movement). ArrowDown instead emits
 *   `navigateDown` so a host (e.g. the theme sheet) can move focus into the
 *   next region — the theme listbox.
 */
@Component({
  selector: 'ui-theme-mode-switch',
  imports: [TranslocoPipe, NgIcon, HlmRadioGroupImports],
  providers: [provideIcons({ lucideSun, lucideMoon, lucideMonitor })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './theme-mode-switch.html',
})
export class ThemeModeSwitch {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly preferencesStore = inject(PreferencesStore);
  /** Emitted on ArrowDown — the host moves focus to the region below (theme listbox). */
  public readonly navigateDown = output();

  protected onModeChange(mode: ThemeMode): void {
    if (mode !== this.preferencesStore.themeMode()) {
      this.preferencesStore.setThemeModeLocal(mode);
    }
  }

  /**
   * Restrict the radio group to horizontal navigation: Up/Down must not move
   * the selection (native radio behavior would). ArrowDown is repurposed as a
   * region-navigation request emitted via `navigateDown`.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.navigateDown.emit();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
    }
  }

  /** Focus the radio of the currently active mode (used for sheet initial focus and Up-boundary handoff). */
  public focusActive(): void {
    this.elementRef.nativeElement.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }
}
