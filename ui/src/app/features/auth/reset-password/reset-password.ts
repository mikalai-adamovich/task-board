import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormField, FormRoot, submit, schema, required, minLength, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { AuthClient } from '@services/auth-client';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface ResetPasswordModel {
  newPassword: string;
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
  ],
  selector: 'ui-reset-password',
  templateUrl: './reset-password.html',
})
export class ResetPassword {
  private readonly authClient = inject(AuthClient);
  private readonly router = inject(Router);
  private readonly notify = injectToasts();
  private readonly error = signal('');
  private readonly submitting = signal(false);
  /** Reset token from the `?token=` query param (bound via withComponentInputBinding) */
  readonly token = input<string>();
  protected readonly missingToken = computed(() => !this.token());
  private readonly model = signal<ResetPasswordModel>({ newPassword: '', confirmPassword: '' });
  private readonly resetForm = form(
    this.model,
    schema<ResetPasswordModel>((field) => {
      required(field.newPassword, { message: 'validation.passwordRequired' });
      minLength(field.newPassword, 8, { message: 'validation.passwordMin' });
      maxLength(field.newPassword, 128, { message: 'validation.passwordMax' });
      required(field.confirmPassword, { message: 'validation.confirmPasswordRequired' });
    }),
    {
      submission: {
        action: async () => {
          await this.resetPassword();
        },
      },
    },
  );

  private async resetPassword(): Promise<void> {
    const token = this.token();

    if (!token) return;

    const modelValue = this.model();

    if (modelValue.newPassword !== modelValue.confirmPassword) {
      this.error.set('auth.resetPassword.passwordsNotMatch');
      return;
    }

    this.error.set('');
    this.submitting.set(true);

    try {
      await this.authClient.resetPassword({ token, newPassword: modelValue.newPassword }).toPromise();
      this.notify.success('auth.resetPassword.success');
      await this.router.navigateByUrl('/auth/login');
    } catch (err) {
      this.error.set(getErrorMessage(err, 'auth.resetPassword.invalidToken'));
    } finally {
      this.submitting.set(false);
    }
  }

  protected onSubmit(): void {
    submit(this.resetForm);
  }
}
