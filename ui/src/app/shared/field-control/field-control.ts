import { Directive, computed, inject } from '@angular/core';
import { BrnFieldControl, BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { FormField } from '@angular/forms/signals';

/**
 * Bridge between a Signal Forms control (`[formField]`) and Spartan's field layer.
 *
 * Spartan's `HlmFieldError` is signal-native and gates its own visibility on
 * `BrnField.controlState().spartanInvalid`, which only exists once a
 * `BrnFieldControl` has registered with the enclosing `<hlm-field>`. The app
 * uses Signal Forms, so no control carried `brnFieldControl` and every error
 * message stayed `[hidden]` — the field-level validation text was never visible
 * and never announced.
 *
 * This directive is the single composition point that closes that gap. It is
 * meant to sit on the same element as `[formField]`, inside an `<hlm-field>`:
 *
 * ```html
 * <hlm-field>
 *   <label hlmFieldLabel for="email">…</label>
 *   <input hlmInput id="email" type="email" [formField]="loginForm.email" uiFieldControl />
 *   @if (loginForm.email().touched() && loginForm.email().errors().length) {
 *     <p hlm-field-error>{{ loginForm.email().errors()[0]?.message | transloco }}</p>
 *   }
 * </hlm-field>
 * ```
 *
 * What each piece contributes:
 * - `BrnFieldControl` reads the `NgControl` that `[formField]` already provides
 *   (an `InteropNgControl`), so Spartan's `createStateTracker()` takes its
 *   `SignalStateTracker` branch. From that point on `spartanInvalid`,
 *   `data-invalid` and `data-matches-spartan-invalid` track the Signal Form
 *   field, and `HlmFieldError` shows its message on its own.
 * - `BrnFieldControlDescribedBy` merges the ids registered by
 *   `HlmFieldError` / `HlmFieldDescription` into `aria-describedby` on the
 *   control, so assistive tech announces the message with the field.
 * - The host binding below publishes `aria-invalid` for the same
 *   touched-and-invalid state, which Spartan does not set on a plain input.
 *
 * The app's own `@if` around `<hlm-field-error>` is intentionally kept: it
 * guards the *content* (the transloco pipe must never see an undefined key),
 * while Spartan guards the *visibility*. Both read the same signal state, so
 * the two gates can never disagree.
 */
@Directive({
  selector: '[uiFieldControl]',
  hostDirectives: [BrnFieldControl, BrnFieldControlDescribedBy],
  host: {
    '[attr.aria-invalid]': '_ariaInvalid() ? "true" : null',
  },
})
export class FieldControl {
  private readonly _formField = inject(FormField, { optional: true });
  /**
   * Mirrors Spartan's default `ErrorStateMatcher` (invalid **and** touched), so
   * `aria-invalid` only appears once the field has actually been interacted with
   * and never nags an untouched, empty form.
   */
  protected readonly _ariaInvalid = computed(() => {
    const state = this._formField?.state();

    return !!state && state.touched() && state.invalid();
  });
}
