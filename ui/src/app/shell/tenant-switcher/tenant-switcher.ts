import { Component, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideCheck, lucidePlus, lucideBuilding2 } from '@ng-icons/lucide';
import { NgIcon } from '@ng-icons/core';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports, HlmDropdownMenuTrigger } from '@spartan-ng/helm/dropdown-menu';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import type { TenantWithRole } from '@app/types/frontend';
import { KeyboardShortcuts } from '../../shared/keyboard-shortcuts/keyboard-shortcuts';

/**
 * Sidebar workspace switcher. In desktop collapsed-icon mode renders as a
 * compact icon button (same dropdown menu) with a tooltip showing the active
 * workspace name; expanded mode keeps the full-width trigger.
 */
@Component({
  selector: 'ui-tenant-switcher',
  imports: [NgIcon, HlmButtonImports, HlmDropdownMenuImports, HlmDropdownMenuTrigger, HlmSidebarImports, TranslocoPipe],
  providers: [provideIcons({ lucideChevronDown, lucideCheck, lucidePlus, lucideBuilding2 })],
  templateUrl: './tenant-switcher.html',
})
export class TenantSwitcher {
  private readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly router = inject(Router);
  private readonly sidebarService = inject(HlmSidebarService);
  /** `w` hotkey coordination — see the effect below. */
  private readonly shortcuts = inject(KeyboardShortcuts);
  private readonly menuTrigger = viewChild(HlmDropdownMenuTrigger);
  /** Collapsed-icon mode (desktop only) — render as icon button with tooltip */
  protected readonly isCollapsedIconMode = computed(
    () => this.sidebarService.state() === 'collapsed' && !this.sidebarService.isMobile(),
  );
  /** Tooltip label in collapsed mode: active workspace name, else a generic hint */
  protected readonly collapsedTooltip = computed(() => this.tenantStore.activeTenant()?.name ?? null);

  constructor() {
    // The global `w` hotkey bumps `workspaceMenuToggle`.
    // React STATE-AWARE: read the trigger's actual `isOpen()` and call
    // `openFocused()`/`close()` explicitly — a blind `toggle()` double-fired
    // (open+close) left the menu stuck, and programmatic open never focused
    // the menu so Esc/arrow keys were dead. The `lastHandled` guard makes the
    // effect idempotent even if it re-runs for the same counter bump.
    // `untracked` keeps the trigger query out of the effect's deps.
    effect(() => {
      const bump = this.shortcuts.workspaceMenuToggle();

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
    this.shortcuts.workspaceMenuOpen.set(true);
  }

  /** Report closed state to KeyboardShortcuts (wired in the template). */
  protected onMenuClosed(): void {
    this.shortcuts.workspaceMenuOpen.set(false);
  }

  protected selectTenant(tenant: TenantWithRole): void {
    this.tenantStore.setActiveTenant(tenant);
    this.authStore.setTenantRole(tenant.role);
    // Navigate to the tenant home by slug and clear project context (IA §2.1)
    this.projectStore.clearProject();
    this.router.navigate(['/w', tenant.slug]);
  }

  protected isActive(tenant: TenantWithRole): boolean {
    return this.tenantStore.activeTenant()?.id === tenant.id;
  }

  protected navigateToCreate(): void {
    this.router.navigate(['/workspace/create']);
  }
}
