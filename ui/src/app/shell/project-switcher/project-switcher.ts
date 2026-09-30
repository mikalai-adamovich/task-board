import { Component, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideCheck, lucideFolderKanban, lucidePlus } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports, HlmDropdownMenuTrigger } from '@spartan-ng/helm/dropdown-menu';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { TenantRole } from '@task-board/shared';
import type { Project } from '@task-board/shared';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { ProjectStore } from '@stores/project-store';
import { hasMinTenantRole } from '@app/shared/utils/role-utils';
import { KeyboardShortcuts } from '../../shared/keyboard-shortcuts/keyboard-shortcuts';

/**
 * Sidebar project switcher — heads the project group.
 * Styled 1:1 on the tenant switcher (outline lg w-full trigger, chevron,
 * active checkmark). In collapsed-icon mode renders as an icon button with
 * a tooltip. Selecting a project navigates to `/w/:slug/projects/:key`.
 */
@Component({
  selector: 'ui-project-switcher',
  imports: [NgIcon, HlmButtonImports, HlmDropdownMenuImports, HlmDropdownMenuTrigger, HlmSidebarImports, TranslocoPipe],
  providers: [provideIcons({ lucideChevronDown, lucideCheck, lucideFolderKanban, lucidePlus })],
  templateUrl: './project-switcher.html',
})
export class ProjectSwitcher {
  private readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  private readonly sidebarService = inject(HlmSidebarService);
  private readonly projectStore = inject(ProjectStore);
  private readonly router = inject(Router);
  /** `p` hotkey coordination — see the effect below. */
  private readonly shortcuts = inject(KeyboardShortcuts);
  private readonly menuTrigger = viewChild(HlmDropdownMenuTrigger);
  /**
   * Projects of the active tenant come from the SHARED tenant-scoped cache
   * in ProjectStore (same cache as TenantHome — one GET /projects per tenant
   * session, no duplicate fetch, and create/update mutations are visible here
   * immediately via upsertProject).
   */
  private readonly activeTenantId = computed(() => this.tenantStore.activeTenant()?.id ?? '');
  private readonly projects = computed(() => this.projectStore.projectList(this.activeTenantId()));
  /** Reactive signal of the current URL for active-project detection */
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** Extract projectKey from the current URL (null when not in project context) */
  private readonly currentProjectKey = computed(() => this.currentUrl().match(/\/projects\/([^/?#]+)/)?.[1] ?? null);
  /** Collapsed-icon mode (desktop only) — render as icon button with tooltip */
  protected readonly isCollapsedIconMode = computed(
    () => this.sidebarService.state() === 'collapsed' && !this.sidebarService.isMobile(),
  );
  /** Tooltip label in collapsed mode: active project name, else a generic hint */
  protected readonly collapsedTooltip = computed(() => {
    const key = this.currentProjectKey();
    const active = key ? this.projects().find((p) => p.key === key) : undefined;

    return active?.name ?? null;
  });

  protected isActive(project: Project): boolean {
    return this.currentProjectKey() === project.key;
  }

  constructor() {
    // Load the project list through the shared cache. Reading
    // projectList() keeps the effect reactive — after invalidateProjectList()
    // the effect re-runs and refetches.
    effect(() => {
      const tenantId = this.activeTenantId();

      if (!tenantId) return;

      this.projectStore.projectList(tenantId);
      void this.projectStore.ensureProjectList(tenantId).catch(() => {
        // Non-critical: the switcher just shows an empty list; a later open retries.
      });
    });

    // The global `p` hotkey bumps `projectMenuToggle`.
    // React STATE-AWARE: read the trigger's actual `isOpen()` and call
    // `openFocused()`/`close()` explicitly — a blind `toggle()` double-fired
    // (open+close) left the menu stuck, and programmatic open never focused
    // the menu so Esc/arrow keys were dead. The `lastHandled` guard makes the
    // effect idempotent even if it re-runs for the same counter bump.
    // `untracked` keeps the trigger query out of the effect's deps.
    effect(() => {
      const bump = this.shortcuts.projectMenuToggle();

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
    this.shortcuts.projectMenuOpen.set(true);
  }

  /** Report closed state to KeyboardShortcuts (wired in the template). */
  protected onMenuClosed(): void {
    this.shortcuts.projectMenuOpen.set(false);
  }

  /** Same rule tenant-home uses to gate its create-project dialog (OWNER/ADMIN) */
  protected readonly canCreateProject = computed(() => hasMinTenantRole(this.authStore.tenantRole(), TenantRole.ADMIN));

  protected selectProject(project: Project): void {
    const slug = this.tenantStore.activeTenant()?.slug;

    if (!slug) return;

    this.router.navigate(['/w', slug, 'projects', project.key]);
  }

  /** Navigate to the tenant home where the create-project dialog lives */
  protected navigateToCreateProject(): void {
    const slug = this.tenantStore.activeTenant()?.slug;

    if (!slug) return;

    this.router.navigate(['/w', slug]);
  }
}
