import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormField, FormRoot, submit, schema, required, email } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { AuthClient } from '@services/auth-client';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { getErrorMessage } from '@app/shared/utils/error-utils';

interface ForgotPasswordModel {
  email: string;
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
  ],
  selector: 'ui-forgot-password',
  templateUrl: './forgot-password.html',
})
export class ForgotPassword {
  private readonly authClient = inject(AuthClient);
  private readonly error = signal('');
  /** Set once a request has been made — shows the neutral confirmation afterwards */
  private readonly submitted = signal(false);
  private readonly model = signal<ForgotPasswordModel>({ email: '' });
  private readonly forgotForm = form(
    this.model,
    schema<ForgotPasswordModel>((field) => {
      required(field.email, { message: 'validation.emailRequired' });
      email(field.email, { message: 'validation.emailInvalid' });
    }),
    {
      submission: {
        action: async () => {
          await this.requestReset();
        },
      },
    },
  );

  private async requestReset(): Promise<void> {
    this.error.set('');

    try {
      await this.authClient.forgotPassword(this.model().email).toPromise();
      this.submitted.set(true);
    } catch (err) {
      // Only genuine failures (network/5xx) surface — the server responds
      // neutrally for both known and unknown emails (anti-enumeration).
      this.error.set(getErrorMessage(err, 'auth.forgotPassword.failed'));
    }
  }

  protected onSubmit(): void {
    submit(this.forgotForm);
  }
}
