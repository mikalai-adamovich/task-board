import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormField, FormRoot, submit, schema, required, email } from '@angular/forms/signals';
import { AuthStore } from '@stores/auth-store';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { FieldControl } from '@app/shared/field-control/field-control';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface LoginModel {
  email: string;
  password: string;
}

@Component({
  imports: [
    HlmAlertImports,
    RouterLink,
    TranslocoPipe,
    FieldControl,
    FormField,
    FormRoot,
    HlmCardImports,
    HlmFieldImports,
    HlmInputImports,
    HlmButtonImports,
    HlmSpinnerImports,
  ],
  selector: 'ui-login',
  templateUrl: './login.html',
})
export class Login {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly error = signal('');
  private readonly model = signal<LoginModel>({ email: '', password: '' });
  private readonly loginForm = form(
    this.model,
    schema<LoginModel>((field) => {
      required(field.email, { message: 'validation.emailRequired' });
      email(field.email, { message: 'validation.emailInvalid' });
      required(field.password, { message: 'validation.passwordRequired' });
    }),
    {
      submission: {
        action: async () => {
          this.error.set('');

          try {
            await this.authStore.login(this.model());
            await this.router.navigateByUrl('/');
          } catch (err) {
            this.error.set(getErrorMessage(err));
          }
        },
      },
    },
  );

  protected onSubmit(): void {
    submit(this.loginForm);
  }
}
