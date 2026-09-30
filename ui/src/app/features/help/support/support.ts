import { Component, signal, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { form, FormRoot, FormField, schema, required, email, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { SupportClient } from '@services/support-client';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

interface SupportModel {
  name: string;
  email: string;
  message: string;
}

@Component({
  selector: 'ui-support',
  imports: [
    FieldControl,
    HlmAlertImports,
    TranslocoPipe,
    FormRoot,
    FormField,
    HlmFieldImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmButtonImports,
    HlmSpinnerImports,
  ],
  templateUrl: './support.html',
})
export class Support {
  private readonly supportClient = inject(SupportClient);
  private readonly error = signal('');
  private readonly success = signal(false);
  private readonly model = signal<SupportModel>({ name: '', email: '', message: '' });
  private readonly createdAt = signal(Date.now());
  protected readonly supportForm = form(
    this.model,
    schema<SupportModel>((field) => {
      required(field.name, { message: 'validation.nameRequired' });
      maxLength(field.name, 200, { message: 'validation.nameMax' });
      required(field.email, { message: 'validation.emailRequired' });
      email(field.email, { message: 'validation.emailInvalid' });
      required(field.message, { message: 'validation.messageRequired' });
      maxLength(field.message, 2000, { message: 'validation.messageMax' });
    }),
    {
      submission: {
        action: async (f) => {
          this.error.set('');
          this.success.set(false);

          this.supportClient
            .submit({
              ...this.model(),
              createdAt: this.createdAt(),
            })
            .subscribe({
              next: () => {
                this.success.set(true);
                f().reset({ name: '', email: '', message: '' });
                this.createdAt.set(Date.now());
              },
              error: (err) => {
                this.error.set(getErrorMessage(err));
              },
            });
        },
      },
    },
  );
}
