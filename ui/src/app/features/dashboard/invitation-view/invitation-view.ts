import { Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { TenantClient } from '@services/tenant-client';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucideMail, lucideBuilding2 } from '@ng-icons/lucide';
import { finalize } from 'rxjs';
import type { MyInvitation } from '@app/types/frontend';
import { roleBadgeVariant } from '@app/constants/priority';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

@Component({
  selector: 'ui-invitation-view',
  imports: [
    RouterLink,
    DatePipe,
    TranslocoPipe,
    HlmCardImports,
    HlmButtonImports,
    HlmBadgeImports,
    HlmSpinnerImports,
    NgIcon,
  ],
  providers: [provideIcons({ lucideMail, lucideBuilding2 })],
  templateUrl: './invitation-view.html',
})
export class InvitationView {
  private readonly tenantClient = inject(TenantClient);
  private readonly notify = injectToasts();
  readonly invitations = input<MyInvitation[]>([]);
  readonly invitationHandled = output();
  private readonly acceptingId = signal<string | null>(null);
  private readonly decliningId = signal<string | null>(null);
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

  protected declineInvitation(invitation: MyInvitation): void {
    this.decliningId.set(invitation.id);
    this.tenantClient
      .declineInvitation(invitation.id)
      .pipe(finalize(() => this.decliningId.set(null)))
      .subscribe({
        next: () => {
          this.invitationHandled.emit();
        },
        error: (err) => this.notify.error(getErrorMessage(err)),
      });
  }
}
