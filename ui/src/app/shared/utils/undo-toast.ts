import { inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { toast } from '@spartan-ng/brain/sonner';
import type { Observable } from 'rxjs';
import { getErrorMessage } from './error-utils';

/**
 * How long the undo window stays open. Undo availability == toast duration:
 * once the toast is dismissed the compensating operation is no longer offered
 * (no server-side soft-delete — DEC-053).
 *
 * Global toaster duration is 7000 ms; the undo window adds 3 s on top.
 */
export const UNDO_TOAST_DURATION_MS = 11000;

/**
 * Toast helpers bound to the caller's `TranslocoService`, extended with an
 * "Undo" action toast for destructive operations.
 *
 * Must be called within an injection context (e.g. a component field initializer):
 *
 * ```ts
 * private readonly notify = injectUndoToasts();
 * // …
 * this.notify.successWithUndo('toasts.deleted', () => this.labelClient.create(pid, { name }));
 * ```
 *
 * The `undo$` factory performs the compensating create/restore call; it is
 * only invoked when the user clicks the Undo button before the toast expires.
 * Undo success shows `common.undoSuccess`; failure shows the server error or
 * `common.undoFailed`.
 */
export function injectUndoToasts() {
  const transloco = inject(TranslocoService);

  return {
    /** Show a localized success toast. */
    success: (key: string, params?: Record<string, unknown>): void => {
      toast.success(transloco.translate(key, params));
    },
    /** Show a localized error toast. */
    error: (key: string, params?: Record<string, unknown>): void => {
      toast.error(transloco.translate(key, params));
    },
    /**
     * Show a localized success toast with an Undo action button.
     *
     * @param messageKey - Transloco key for the toast message (e.g. `toasts.deleted`).
     * @param undo$ - Factory returning the compensating-operation observable.
     *   It is called lazily, at click time, so positions/lists are evaluated
     *   against current state rather than the state at delete time.
     * @param params - Optional interpolation params for `messageKey`.
     */
    successWithUndo: (messageKey: string, undo$: () => Observable<unknown>, params?: Record<string, unknown>): void => {
      toast.success(transloco.translate(messageKey, params), {
        duration: UNDO_TOAST_DURATION_MS,
        action: {
          label: transloco.translate('common.undo'),
          onClick: () => {
            undo$().subscribe({
              next: () => {
                toast.success(transloco.translate('common.undoSuccess'));
              },
              error: (err: unknown) => {
                toast.error(transloco.translate(getErrorMessage(err, 'common.undoFailed')));
              },
            });
          },
        },
      });
    },
  };
}
