import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { TenantClient } from '@services/tenant-client';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import type { MyInvitation } from '@app/types/frontend';

// Sub-views
import { LandingPage } from './landing-page/landing-page';
import { WelcomeView } from './welcome-view/welcome-view';
import { InvitationView } from './invitation-view/invitation-view';

type DashboardState = 'visitor' | 'new-user' | 'pending-invitations' | 'redirecting';

/**
 * Root entry (`/`, DEC-033).
 *
 * - Visitor → landing page.
 * - Authenticated with accessible tenants → redirect to the last-selected
 *   (or first) tenant home `/w/:tenantSlug` (last-selection preference is
 *   persisted by the TenantStore in localStorage).
 * - Authenticated without tenants → welcome view; with only pending
 *   invitations → invitation view. Both behaviors are preserved.
 */
@Component({
  selector: 'ui-dashboard',
  imports: [HlmSpinnerImports, LandingPage, WelcomeView, InvitationView],
  templateUrl: './dashboard.html',
})
export class Dashboard implements OnInit {
  private readonly authStore = inject(AuthStore);
  private readonly tenantStore = inject(TenantStore);
  private readonly tenantClient = inject(TenantClient);
  private readonly router = inject(Router);
  private readonly invitations = signal<MyInvitation[]>([]);
  private readonly loading = signal(true);
  protected readonly dashboardState = computed<DashboardState>(() => {
    if (!this.authStore.isAuthenticated()) return 'visitor';
    if (this.tenantStore.tenants().length > 0) return 'redirecting';
    if (this.invitations().length > 0) return 'pending-invitations';
    return 'new-user';
  });

  async ngOnInit(): Promise<void> {
    // Cold load: the token is restored from localStorage but the session is
    // not initialized. bootstrap() fetches the user AND the tenant list in
    // ONE round-trip (replaces the sequential /auth/me → /tenants chain).
    // Post-login (user already set) only the tenant list may be missing —
    // bootstrap covers that too, so no separate /tenants call is needed.
    if (this.authStore.token() && (!this.authStore.currentUser() || !this.tenantStore.tenantsLoaded())) {
      try {
        await this.authStore.bootstrap();
      } catch {
        // 401 → bootstrap triggers logout(); other errors → still not authenticated
        this.loading.set(false);
        return;
      }
    }

    if (!this.authStore.isAuthenticated()) {
      this.loading.set(false);
      return;
    }

    // Fallback: session initialized without the tenant list (should not
    // normally happen — bootstrap seeds both stores).
    if (!this.tenantStore.tenantsLoaded()) {
      try {
        await this.tenantStore.loadTenants();
      } catch {
        this.loading.set(false);
        return;
      }
    }

    // Redirect to the last-selected (or first) tenant home
    {
      const active = this.tenantStore.activeTenant();

      if (this.tenantStore.tenants().length > 0 && active) {
        await this.router.navigate(['/w', active.slug], { replaceUrl: true });
        return;
      }
    }

    // No tenants — load pending invitations for the welcome/invitation views
    try {
      const invitationsRes = await firstValueFrom(this.tenantClient.getMyInvitations());

      if (invitationsRes) {
        this.invitations.set(invitationsRes);
      }
    } catch {
      // Silently handle errors
    } finally {
      this.loading.set(false);
    }
  }

  /** Reload tenants after an invitation was accepted/declined */
  protected async onInvitationHandled(): Promise<void> {
    this.loading.set(true);

    try {
      const tenants = await this.tenantStore.loadTenants();
      const active = this.tenantStore.activeTenant();

      if (tenants.length > 0 && active) {
        await this.router.navigate(['/w', active.slug], { replaceUrl: true });
        return;
      }

      const invitationsRes = await firstValueFrom(this.tenantClient.getMyInvitations());

      this.invitations.set(invitationsRes ?? []);
    } catch {
      // keep current state
    } finally {
      this.loading.set(false);
    }
  }
}
