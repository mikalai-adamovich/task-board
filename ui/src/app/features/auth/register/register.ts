import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormField, FormRoot, schema, required, email, minLength, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { AuthStore } from '@stores/auth-store';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface RegisterModel {
  displayName: string;
  email: string;
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
  ],
  selector: 'ui-register',
  templateUrl: './register.html',
})
export class Register {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly error = signal('');
  private readonly model = signal<RegisterModel>({
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  protected readonly registerForm = form(
    this.model,
    schema<RegisterModel>((field) => {
      required(field.displayName, { message: 'validation.nameRequired' });
      maxLength(field.displayName, 100, { message: 'validation.displayNameMax' });
      required(field.email, { message: 'validation.emailRequired' });
      email(field.email, { message: 'validation.emailInvalid' });
      required(field.password, { message: 'validation.passwordRequired' });
      minLength(field.password, 8, { message: 'validation.passwordMin' });
      maxLength(field.password, 128, { message: 'validation.passwordMax' });
      required(field.confirmPassword, { message: 'validation.confirmPasswordRequired' });
    }),
    {
      submission: {
        action: async () => {
          this.error.set('');

          const modelValue = this.model();

          if (modelValue.password !== modelValue.confirmPassword) {
            this.error.set('validation.passwordsMustMatch');
            return;
          }

          try {
            await this.authStore.register({
              displayName: modelValue.displayName,
              email: modelValue.email,
              password: modelValue.password,
            });
            await this.router.navigateByUrl('/');
          } catch (err) {
            this.error.set(getErrorMessage(err));
          }
        },
      },
    },
  );
}
