import { Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { AuthStore } from '@stores/auth-store';
import { TenantClient } from '@services/tenant-client';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucideBuilding2, lucideCheck, lucideMail } from '@ng-icons/lucide';
import { finalize } from 'rxjs';
import type { MyInvitation } from '@app/types/frontend';
import { roleBadgeVariant } from '@app/constants/priority';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

@Component({
  selector: 'ui-welcome-view',
  imports: [RouterLink, TranslocoPipe, HlmCardImports, HlmButtonImports, HlmBadgeImports, HlmSpinnerImports, NgIcon],
  providers: [provideIcons({ lucideBuilding2, lucideCheck, lucideMail })],
  templateUrl: './welcome-view.html',
})
export class WelcomeView {
  protected readonly authStore = inject(AuthStore);
  private readonly tenantClient = inject(TenantClient);
  private readonly notify = injectToasts();
  readonly invitations = input<MyInvitation[]>([]);
  readonly invitationHandled = output();
  private readonly acceptingId = signal<string | null>(null);
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly roleBadgeVariant = roleBadgeVariant;

  protected acceptInvitation(invitation: MyInvitation): void {
    this.acceptingId.set(invitation.id);
    this.tenantClient
      .acceptInvitationById(invitation.id)
      .pipe(finalize(() => this.acceptingId.set(null)))
      .subscribe({
        next: () => {
          this.invitationHandled.emit();
        },
        error: (err) => this.notify.error(getErrorMessage(err)),
      });
  }
}
