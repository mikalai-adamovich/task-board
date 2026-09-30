import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { HttpErrorResponse } from '@angular/common/http';
import { finalize } from 'rxjs';
import { form, FormField, FormRoot, schema, required, minLength, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { TenantClient } from '@services/tenant-client';
import { AuthStore } from '@stores/auth-store';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import type { InvitationDetails } from '@task-board/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface InvitationFormModel {
  displayName: string;
  password: string;
  confirmPassword: string;
}

@Component({
  imports: [
    FieldControl,
    HlmAlertImports,
    RouterLink,
    TranslocoPipe,
    FormField,
    FormRoot,
    HlmCardImports,
    HlmFieldImports,
    HlmInputImports,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmBadgeImports,
  ],
  selector: 'ui-accept-invitation',
  templateUrl: './accept-invitation.html',
})
export class AcceptInvitation implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tenantClient = inject(TenantClient);
  private readonly authStore = inject(AuthStore);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly invitation = signal<InvitationDetails | null>(null);
  private readonly token = signal('');
  private readonly model = signal<InvitationFormModel>({ displayName: '', password: '', confirmPassword: '' });
  protected readonly invitationForm = form(
    this.model,
    schema<InvitationFormModel>((field) => {
      required(field.displayName, { message: 'validation.displayNameRequired' });
      maxLength(field.displayName, 100, { message: 'validation.displayNameMax' });
      required(field.password, { message: 'validation.passwordRequired' });
      minLength(field.password, 8, { message: 'validation.passwordMin' });
      maxLength(field.password, 128, { message: 'validation.passwordMax' });
      required(field.confirmPassword, { message: 'validation.confirmPasswordRequired' });
    }),
    {
      submission: {
        action: async () => {
          await this.acceptAsNewUser();
        },
      },
    },
  );

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');

    if (!token) {
      this.error.set('auth.invitation.noToken');
      this.loading.set(false);
      return;
    }

    this.token.set(token);

    this.tenantClient
      .getInvitationDetails(token)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (details) => {
          this.invitation.set(details);
        },
        error: (err: HttpErrorResponse) => {
          this.error.set(err.error?.message ?? 'auth.invitation.invalidOrExpired');
        },
      });
  }

  private async acceptAsNewUser(): Promise<void> {
    const invitation = this.invitation();

    if (!invitation) return;

    const modelValue = this.model();

    if (modelValue.password !== modelValue.confirmPassword) {
      this.error.set('auth.invitation.passwordsNotMatch');
      return;
    }

    this.error.set('');

    this.tenantClient
      .acceptInvitation({
        token: this.token(),
        password: modelValue.password,
        displayName: modelValue.displayName,
      })
      .subscribe({
        next: (res) => {
          this.authStore.setSession(res);
          this.router.navigateByUrl('/');
        },
        error: (err: HttpErrorResponse) => {
          this.error.set(err.error?.message ?? 'auth.invitation.failedAccept');
        },
      });
  }

  protected async acceptAsExistingUser(): Promise<void> {
    this.error.set('');

    this.tenantClient
      .acceptInvitation({
        token: this.token(),
      })
      .subscribe({
        next: (res) => {
          this.authStore.setSession(res);
          this.router.navigateByUrl('/');
        },
        error: (err: HttpErrorResponse) => {
          this.error.set(err.error?.message ?? 'auth.invitation.failedAccept');
        },
      });
  }
}
