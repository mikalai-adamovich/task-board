import { Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ExpandState } from '@task-board/shared';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGlobe, lucideLogOut, lucidePalette, lucideSettings } from '@ng-icons/lucide';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuTrigger,
} from '@spartan-ng/helm/dropdown-menu';
import { AuthStore } from '@stores/auth-store';
import { KeyboardShortcuts } from '../../../shared/keyboard-shortcuts/keyboard-shortcuts';
import { LanguageSwitcher } from '../language-switcher/language-switcher';
import { getRoleColor } from '../role-color.util';
import { UserMenuZoomControls } from './user-menu-zoom-controls/user-menu-zoom-controls';
import { UserMenuThemeSheet } from './user-menu-theme-sheet/user-menu-theme-sheet';

@Component({
  selector: 'ui-user-menu',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    HlmAvatarImports,
    HlmButtonImports,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuTrigger,
    LanguageSwitcher,
    // Only referenced inside the `@defer` block in the template — the compiler
    // extracts it (with its @angular/forms + sonner dependency graph) into a
    // lazy chunk instead of the initial bundle.
    UserMenuThemeSheet,
    UserMenuZoomControls,
  ],
  providers: [provideIcons({ lucideGlobe, lucidePalette, lucideSettings, lucideLogOut })],
  templateUrl: './user-menu.html',
})
export class UserMenu {
  protected readonly ExpandState = ExpandState;
  private readonly authStore = inject(AuthStore);
  /** `m` hotkey coordination — see the effect below. */
  private readonly shortcuts = inject(KeyboardShortcuts);
  private readonly menuTrigger = viewChild(HlmDropdownMenuTrigger);
  private readonly user = computed(() => this.authStore.currentUser());
  private readonly role = computed(() => this.authStore.tenantRole());
  protected readonly roleColor = computed(() => getRoleColor(this.role()));
  protected readonly roleLabel = computed(() => {
    const r = this.role();

    if (!r) return 'Member';
    return r.charAt(0).toUpperCase() + r.slice(1);
  });
  protected readonly initials = computed(() => {
    const name = this.user()?.displayName ?? '';

    return name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2);
  });
  protected readonly themeSheetOpen = signal<ExpandState>(ExpandState.Closed);

  constructor() {
    // The global `m` hotkey bumps `userMenuToggle`.
    // React STATE-AWARE: read the trigger's actual `isOpen()` and call
    // `openFocused()`/`close()` explicitly — a blind `toggle()` double-fired
    // (open+close) left the menu stuck, and programmatic open never focused
    // the menu so Esc/arrow keys were dead. The `lastHandled` guard makes the
    // effect idempotent even if it re-runs for the same counter bump.
    // `untracked` keeps the trigger query out of the effect's deps.
    effect(() => {
      const bump = this.shortcuts.userMenuToggle();

      if (bump === 0 || bump === this.lastHandledToggle) return;

      this.lastHandledToggle = bump;

      untracked(() => {
        const trigger = this.menuTrigger();

        if (!trigger) return;

        if (trigger.isOpen()) trigger.close();
        else trigger.openFocused();
      });
    });
  }

  /** Counter value already consumed — guards against double effect runs. */
  private lastHandledToggle = 0;

  /** Report open state to KeyboardShortcuts (wired in the template). */
  protected onMenuOpened(): void {
    this.shortcuts.userMenuOpen.set(true);
  }

  /** Report closed state to KeyboardShortcuts (wired in the template). */
  protected onMenuClosed(): void {
    this.shortcuts.userMenuOpen.set(false);
  }

  protected logout(): void {
    this.authStore.logout();
  }
}
