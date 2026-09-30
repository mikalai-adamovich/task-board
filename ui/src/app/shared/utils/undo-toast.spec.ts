/**
 * Tests for the undo-toast helper.
 *
 * Covers:
 * - successWithUndo shows a success toast with an Undo action and the undo window duration
 * - clicking Undo runs the compensating observable and shows the undoSuccess toast
 * - a failing compensating call shows the server error or the undoFailed fallback
 * - plain success/error still work (drop-in replacement for injectToasts)
 */
import { TestBed } from '@angular/core/testing';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom, of, throwError } from 'rxjs';
import { toast } from '@spartan-ng/brain/sonner';
import { injectUndoToasts, UNDO_TOAST_DURATION_MS } from './undo-toast';

describe('injectUndoToasts', () => {
  let notify: ReturnType<typeof injectUndoToasts>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    // Spy on the sonner toast object directly — module mocking is unreliable
    // under the Angular vitest builder when several specs mock the same module.
    vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    vi.spyOn(toast, 'error').mockReturnValue('toast-id');

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: {
            en: {
              common: { undo: 'Undo', undoSuccess: 'Restored successfully', undoFailed: 'Could not undo' },
              toasts: { deleted: 'Deleted successfully' },
            },
          },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    // Preload the lang so synchronous translate() calls resolve to real strings
    await firstValueFrom(TestBed.inject(TranslocoService).selectTranslate('common.undo'));

    notify = TestBed.runInInjectionContext(() => injectUndoToasts());
  });

  // ── successWithUndo ──────────────────────────────────────

  describe('successWithUndo', () => {
    it('should show a success toast with an Undo action and the undo-window duration', () => {
      notify.successWithUndo('toasts.deleted', () => of(null));

      expect(toast.success).toHaveBeenCalledTimes(1);

      const [message, options] = vi.mocked(toast.success).mock.calls[0] ?? [];

      expect(message).toBe('Deleted successfully');
      expect(options?.duration).toBe(UNDO_TOAST_DURATION_MS);
      // Undo window == toast duration; global toaster is 7000 ms → undo gets +3 s.
      expect(UNDO_TOAST_DURATION_MS).toBe(11000);
      expect(options?.action?.label).toBe('Undo');
      expect(typeof options?.action?.onClick).toBe('function');
    });

    it('should run the compensating operation when Undo is clicked and show undoSuccess', () => {
      const undo = vi.fn(() => of(null));

      notify.successWithUndo('toasts.deleted', undo);

      const action = vi.mocked(toast.success).mock.calls[0]?.[1]?.action;

      action?.onClick?.(new MouseEvent('click'));

      expect(undo).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenLastCalledWith('Restored successfully');
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('should show the undoFailed fallback when the compensating operation fails', () => {
      notify.successWithUndo('toasts.deleted', () => throwError(() => new Error('')));

      const action = vi.mocked(toast.success).mock.calls[0]?.[1]?.action;

      action?.onClick?.(new MouseEvent('click'));

      expect(toast.error).toHaveBeenCalledWith('Could not undo');
    });

    it('should not run the compensating operation unless Undo is clicked', () => {
      const undo = vi.fn(() => of(null));

      notify.successWithUndo('toasts.deleted', undo);

      expect(undo).not.toHaveBeenCalled();
    });
  });

  // ── plain success / error ────────────────────────────────

  describe('success / error', () => {
    it('should show a localized success toast without an action', () => {
      notify.success('toasts.deleted');

      expect(toast.success).toHaveBeenCalledWith('Deleted successfully');

      const options = vi.mocked(toast.success).mock.calls[0]?.[1];

      expect(options?.action).toBeUndefined();
    });

    it('should show a localized error toast', () => {
      notify.error('toasts.deleted');

      expect(toast.error).toHaveBeenCalledWith('Deleted successfully');
    });
  });
});
