import { Component, computed, effect, inject, untracked } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmSidebarImports } from '@spartan-ng/helm/sidebar';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCalendar,
  lucideHistory,
  lucideLayoutDashboard,
  lucidePanelLeft,
  lucidePanelLeftClose,
  lucidePanelLeftOpen,
  lucideSettings,
  lucideUsers,
  lucideHome,
  lucideListTodo,
  lucideUserCog,
} from '@ng-icons/lucide';
import { TenantRole } from '@task-board/shared';
import { AuthStore } from '@stores/auth-store';
import { canManageProject, hasMinTenantRole } from '@app/shared/utils/role-utils';
import { TenantStore } from '@stores/tenant-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { TenantSwitcher } from '../tenant-switcher/tenant-switcher';
import { ProjectSwitcher } from '../project-switcher/project-switcher';

@Component({
  selector: 'ui-sidebar',
  imports: [
    RouterLink,
    RouterLinkActive,
    HlmSidebarImports,
    HlmButtonImports,
    HlmTooltipImports,
    NgIcon,
    TenantSwitcher,
    ProjectSwitcher,
    TranslocoPipe,
  ],
  providers: [
    provideIcons({
      lucidePanelLeft,
      lucidePanelLeftClose,
      lucidePanelLeftOpen,
      lucideCalendar,
      lucideSettings,
      lucideUsers,
      lucideLayoutDashboard,
      lucideHistory,
      lucideHome,
      lucideListTodo,
      lucideUserCog,
    }),
  ],
  templateUrl: './sidebar.html',
})
export class Sidebar {
  /** localStorage key for the persisted collapsed state */
  private static readonly COLLAPSED_STORAGE_KEY = 'task-board.sidebar-collapsed';
  protected readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly router = inject(Router);
  private readonly preferencesStore = inject(PreferencesStore);
  /** Spartan sidebar state service — single source of truth for expanded/collapsed */
  private readonly sidebarService = inject(HlmSidebarService);
  /** Whether the desktop sidebar is currently collapsed (icon mode) */
  private readonly isCollapsed = computed(() => this.sidebarService.state() === 'collapsed');
  /** Reactive signal of the current URL for project context detection */
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** Extract projectKey from the current URL (null when not in project context) */
  protected readonly currentProjectKey = computed(() => {
    const match = this.currentUrl().match(/\/projects\/([^/?#]+)/);

    return match?.[1] ?? null;
  });
  /**
   * Whether the current user can manage project settings (PROJECT_ADMIN+).
   * Tenant OWNER/ADMIN bypass project role checks.
   */
  protected readonly canManageProject = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  /** V2-10: workspace Settings/Members nav is admin-only — hidden from MEMBERs. */
  protected readonly isTenantAdmin = computed(() => hasMinTenantRole(this.authStore.tenantRole(), TenantRole.ADMIN));

  constructor() {
    // DEC-052a: any route navigation closes the mobile offcanvas sheet
    // (covers sidebar links, switchers and programmatic navigation alike).
    // openMobile is read untracked — tracking it would make this effect fire
    // on every open and immediately re-close the sheet (hamburger no-op bug).
    effect(() => {
      this.currentUrl();

      if (untracked(() => this.sidebarService.openMobile())) {
        this.sidebarService.setOpenMobile(false);
      }
    });

    // Load project board preferences whenever the project context changes.
    effect(() => {
      const projectId = this.projectStore.activeProject()?.id;

      if (projectId) {
        this.preferencesStore.loadProjectPreferences(projectId);
      }
    });

    // Restore the persisted collapsed state (overrides the cookie-based default).
    if (typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem(Sidebar.COLLAPSED_STORAGE_KEY);

        if (stored !== null) {
          this.sidebarService.setOpen(stored !== 'true');
        }
      } catch {
        // Storage unavailable — fall back to the default (expanded)
      }
    }

    // Persist collapsed state on every change.
    effect(() => {
      const collapsed = this.isCollapsed();

      if (typeof localStorage === 'undefined') return;

      try {
        localStorage.setItem(Sidebar.COLLAPSED_STORAGE_KEY, String(collapsed));
      } catch {
        // Storage unavailable — persistence is best-effort only
      }
    });
  }

  protected toggleCollapsed(): void {
    this.sidebarService.toggleSidebar();
  }
}
