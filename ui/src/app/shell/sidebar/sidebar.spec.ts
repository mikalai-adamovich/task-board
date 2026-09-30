/**
 * Tests for the Sidebar shell component.
 *
 * Covers:
 * - tenant group ordering (Overview → Members → Settings, V2-10 admin gating kept)
 * - Board item ALWAYS visible in project context (default board → first board
 *   → board-manager fallback link)
 * - switchers remain rendered in desktop collapsed-icon mode (icon buttons)
 */
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { Component } from '@angular/core';
import { BrnTooltip } from '@spartan-ng/brain/tooltip';
import { firstValueFrom } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { TenantRole } from '@task-board/shared';
import type { Project } from '@task-board/shared';
import type { TenantWithRole } from '@app/types/frontend';
import { API_BASE_URL } from '@app/api-url.token';
import { Sidebar } from './sidebar';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { BoardClient } from '@services/board-client';
import { settle } from '@app/shared/testing/zoneless';

/** Route target that is never instantiated (no router-outlet in the test DOM). */
@Component({
  selector: 'ui-dummy-route',
  /* eslint-disable-next-line @angular-eslint/component-max-inline-declarations */
  template: '',
})
class DummyRoute {}

function makeTenant(): TenantWithRole {
  return { id: 'tenant-1', slug: 'acme', name: 'Acme', role: TenantRole.OWNER } as TenantWithRole;
}

function makeProject(key = 'PROJ'): Project {
  return {
    id: 'project-1',
    tenantId: 'tenant-1',
    key,
    name: 'Project One',
    description: null,
    status: 'ACTIVE' as Project['status'],
    defaultStatusId: '',
    archiveReason: null,
    deletionScheduledAt: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('Sidebar', () => {
  async function setup() {
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } }), Sidebar],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'w/:slug', component: DummyRoute },
          { path: 'w/:slug/projects/:key', component: DummyRoute },
        ]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const router = TestBed.inject(Router);
    const tenantStore = TestBed.inject(TenantStore);
    const authStore = TestBed.inject(AuthStore);
    const projectStore = TestBed.inject(ProjectStore);
    const preferencesStore = TestBed.inject(PreferencesStore);
    const boardClient = TestBed.inject(BoardClient);
    const sidebarService = TestBed.inject(HlmSidebarService);

    return { router, tenantStore, authStore, projectStore, preferencesStore, boardClient, sidebarService };
  }

  async function enterProjectContext(
    fixture: ReturnType<typeof TestBed.createComponent<Sidebar>>,
    deps: Awaited<ReturnType<typeof setup>>,
  ): Promise<void> {
    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    deps.projectStore.activeProject.set(makeProject());
    await deps.router.navigateByUrl('/w/acme/projects/PROJ');
    await settle(fixture);
  }

  function queryAnchors(el: HTMLElement): HTMLAnchorElement[] {
    return Array.from(el.querySelectorAll('a[data-sidebar="menu-button"]'));
  }

  it('orders tenant nav Members before Settings (both admin-gated)', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    await settle(fixture);

    const anchors = queryAnchors(fixture.nativeElement as HTMLElement);
    const membersIdx = anchors.findIndex((a) => a.getAttribute('href')?.endsWith('/settings/members'));
    const settingsIdx = anchors.findIndex((a) => a.getAttribute('href')?.endsWith('/w/acme/settings'));

    expect(membersIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(membersIdx).toBeLessThan(settingsIdx);
  });

  it('hides Members and Settings for non-admin tenants', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole('MEMBER' as TenantRole);
    await deps.router.navigateByUrl('/w/acme');
    await settle(fixture);

    const hrefs = queryAnchors(fixture.nativeElement as HTMLElement).map((a) => a.getAttribute('href'));

    expect(hrefs.some((h) => h?.includes('/settings'))).toBe(false);
  });

  it('links the Board item straight to the project board (single-board, no fetch)', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);
    const boardSpy = vi.spyOn(deps.boardClient, 'getForProject');

    await enterProjectContext(fixture, deps);

    const hrefs = queryAnchors(fixture.nativeElement as HTMLElement).map((a) => a.getAttribute('href'));

    expect(hrefs.some((h) => h?.endsWith('/projects/PROJ/board'))).toBe(true);
    // Single-board model: the sidebar never resolves a board id via HTTP.
    expect(boardSpy).not.toHaveBeenCalled();
  });

  it('renders compact icon triggers for both switchers in collapsed-icon mode', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    deps.sidebarService.setOpen(false);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const switcherButtons = el.querySelectorAll<HTMLElement>(
      'ui-tenant-switcher button[data-sidebar="menu-button"], ui-project-switcher button[data-sidebar="menu-button"]',
    );

    expect(switcherButtons.length).toBe(2);
  });

  function queryFooterToggle(el: HTMLElement): HTMLButtonElement | null {
    return el.querySelector<HTMLButtonElement>('[data-slot="sidebar-footer"] button[data-slot="button"]');
  }

  it('renders the footer toggle as a square icon button aligned to the right edge', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const footer = el.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
    const toggle = queryFooterToggle(el);

    expect(footer).not.toBeNull();
    expect(toggle).not.toBeNull();
    expect(footer?.classList.contains('flex')).toBe(true);
    // HlmSidebarFooter sets `flex flex-col` — only `items-end` (cross
    // axis) pins the toggle to the bottom-RIGHT; `justify-end` was vertical.
    expect(footer?.classList.contains('items-end')).toBe(true);
    expect(footer?.classList.contains('flex-col')).toBe(true);
    // size="icon" → square (size-8); the cva also renders the ng-icon at 16×16
    expect(toggle?.classList.contains('size-8')).toBe(true);
    expect(toggle?.classList.contains('justify-center')).toBe(true);
  });

  it('binds an always-on tooltip to the footer toggle (expanded AND collapsed)', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    await settle(fixture);

    const tooltipDebug = fixture.debugElement.query(By.css('[data-slot="sidebar-footer"] button[data-slot="button"]'));

    expect(tooltipDebug).toBeTruthy();

    const tooltip = tooltipDebug.injector.get(BrnTooltip);

    // expanded: tooltip bound with the i18n key and NOT disabled
    expect(String(tooltip.brnTooltip())).toContain('toggleSidebar');
    expect(tooltip.mutableTooltipDisabled()).toBe(false);

    // collapsed: still enabled (the button has no visible text in either state)
    deps.sidebarService.setOpen(false);
    await settle(fixture);

    expect(tooltip.mutableTooltipDisabled()).toBe(false);
  });

  it('exposes hover and active accent classes on nav menu buttons', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    await settle(fixture);

    const anchors = queryAnchors(fixture.nativeElement as HTMLElement);

    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      expect(anchor.classList.contains('hover:bg-sidebar-accent')).toBe(true);
      expect(anchor.classList.contains('hover:text-sidebar-accent-foreground')).toBe(true);
      expect(anchor.classList.contains('data-active:bg-sidebar-accent')).toBe(true);
      expect(anchor.classList.contains('data-active:text-sidebar-accent-foreground')).toBe(true);
      expect(anchor.classList.contains('data-active:font-medium')).toBe(true);
    }

    // the exact-matched Overview link is on the current route → data-active="true"
    const overview = anchors.find((a) => a.getAttribute('href')?.endsWith('/w/acme'));

    expect(overview).toBeDefined();
    expect(overview?.getAttribute('data-active')).toBe('true');
  });

  it('keeps the active state visible when collapsed (icon-only mode)', async () => {
    const deps = await setup();
    const fixture = TestBed.createComponent(Sidebar);

    deps.tenantStore.setActiveTenant(makeTenant());
    deps.authStore.setTenantRole(TenantRole.OWNER);
    await deps.router.navigateByUrl('/w/acme');
    deps.sidebarService.setOpen(false);
    await settle(fixture);

    const anchors = queryAnchors(fixture.nativeElement as HTMLElement);
    const overview = anchors.find((a) => a.getAttribute('href')?.endsWith('/w/acme'));

    expect(overview).toBeDefined();
    // bg-accent approach: the data-active attribute + accent classes survive collapse
    expect(overview?.getAttribute('data-active')).toBe('true');
    expect(overview?.classList.contains('data-active:bg-sidebar-accent')).toBe(true);
  });
});
