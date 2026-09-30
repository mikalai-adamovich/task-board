/**
 * Tests for the Login component Signal Form validation.
 *
 * Validates that the form enforces the same rules as the Zod LoginRequestSchema:
 * - email: required, valid email format
 * - password: required (no length restriction at login)
 *
 * Also covers the `uiFieldControl` bridge: Spartan's
 * `HlmFieldError` self-hides unless a `BrnFieldControl` registered with the
 * enclosing `<hlm-field>`, so before the bridge every error slot rendered
 * `[hidden]` and the DOM carried zero visible validation messages.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { clickUntil, settle } from '@app/shared/testing/zoneless';
import { Login } from './login';
import { API_BASE_URL } from '@app/api-url.token';

/** `hlm-field-error` is a component with `data-slot="field-error"`. */
const ERROR_SELECTOR = '[data-slot="field-error"]';

describe('Login form validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<Login>;

  async function setup() {
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ langs: { en: {} }, preloadLangs: true })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(Login);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  // ── Email validation ─────────────────────────────────────────────────────

  describe('email', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.loginForm.email().invalid()).toBe(true);
      expect(component.loginForm.email().errors().length).toBeGreaterThan(0);
    });

    it('should be valid for standard email', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, email: 'user@example.com' }));

      expect(component.loginForm.email().valid()).toBe(true);
    });

    it('should be valid for email without TLD (test@test)', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, email: 'test@test' }));

      expect(component.loginForm.email().valid()).toBe(true);
    });

    it('should be valid for email with subdomain', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, email: 'user@sub.domain.com' }));

      expect(component.loginForm.email().valid()).toBe(true);
    });

    it('should be invalid for email without @ sign', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, email: 'not-an-email' }));

      expect(component.loginForm.email().invalid()).toBe(true);
    });
  });

  // ── Password validation ──────────────────────────────────────────────────

  describe('password', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.loginForm.password().invalid()).toBe(true);
    });

    it('should be valid for single character (no min length at login)', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, password: 'a' }));

      expect(component.loginForm.password().valid()).toBe(true);
    });

    it('should be valid for long password', () => {
      component.model.update((m: { email: string; password: string }) => ({ ...m, password: 'a'.repeat(200) }));

      expect(component.loginForm.password().valid()).toBe(true);
    });
  });

  // ── Form-level validation ────────────────────────────────────────────────

  describe('form validity', () => {
    beforeEach(() => setup());

    it('should be invalid when both fields are empty', () => {
      expect(component.loginForm().invalid()).toBe(true);
    });

    it('should be valid when both fields are filled', () => {
      component.model.update(() => ({ email: 'user@example.com', password: 'secret' }));

      expect(component.loginForm().valid()).toBe(true);
    });

    it('should be invalid when only email is filled', () => {
      component.model.update(() => ({ email: 'user@example.com', password: '' }));

      expect(component.loginForm().invalid()).toBe(true);
    });

    it('should be invalid when only password is filled', () => {
      component.model.update(() => ({ email: '', password: 'secret' }));

      expect(component.loginForm().invalid()).toBe(true);
    });
  });

  // ── Field error rendering + a11y wiring ───────────────────────────────────

  describe('field error display', () => {
    beforeEach(() => setup());

    /** The `hlm-field-error` hosts currently in the DOM. */
    function errorNodes(): HTMLElement[] {
      return Array.from(fixture.nativeElement.querySelectorAll(ERROR_SELECTOR)) as HTMLElement[];
    }

    /** Spartan hides the message host with the `hidden` attribute. */
    function visibleErrors(): HTMLElement[] {
      return errorNodes().filter((el) => !el.hasAttribute('hidden'));
    }

    function control(id: string): HTMLInputElement {
      return fixture.nativeElement.querySelector(`input#${id}`) as HTMLInputElement;
    }

    it('renders no error slot before the form is touched', () => {
      expect(errorNodes()).toHaveLength(0);
    });

    it('renders the error text in the DOM after an empty submit', async () => {
      await clickUntil(
        () => (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click(),
        () => expect(visibleErrors().length).toBe(2),
      );
      await settle(fixture);

      const texts = visibleErrors().map((el) => el.textContent?.trim());

      expect(texts.some((t) => !!t)).toBe(true);
    });

    it('marks the control aria-invalid after an empty submit', async () => {
      await clickUntil(
        () => (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click(),
        () => expect(control('email').getAttribute('aria-invalid')).toBe('true'),
      );
      await settle(fixture);

      expect(control('email').getAttribute('aria-invalid')).toBe('true');
      expect(control('password').getAttribute('aria-invalid')).toBe('true');
    });

    it('associates each control with its error via aria-describedby', async () => {
      await clickUntil(
        () => (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click(),
        () => expect(control('email').getAttribute('aria-describedby')).toBeTruthy(),
      );
      await settle(fixture);

      const describedBy = control('email').getAttribute('aria-describedby') as string;
      const error = fixture.nativeElement.querySelector(`#${CSS.escape(describedBy)}`) as HTMLElement;

      expect(describedBy.split(' ').length).toBeGreaterThan(0);
      expect(error).toBeTruthy();
      expect(error.matches(ERROR_SELECTOR)).toBe(true);
      expect(error.hasAttribute('hidden')).toBe(false);
    });

    it('shows no error once the form is valid', async () => {
      component.model.update(() => ({ email: 'user@example.com', password: 'secret' }));
      await settle(fixture);

      await clickUntil(
        () => (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click(),
        () => expect(control('email').getAttribute('aria-invalid')).toBeNull(),
      );
      await settle(fixture);

      expect(visibleErrors()).toHaveLength(0);
      expect(control('email').getAttribute('aria-invalid')).toBeNull();
      expect(control('password').getAttribute('aria-invalid')).toBeNull();
    });
  });

  // ── Layout ───────────────────────────────────────────────────────────────

  describe('layout', () => {
    beforeEach(() => setup());

    it('sizes the page container to the viewport minus the app header (no scrollbar)', () => {
      const container = fixture.nativeElement.querySelector('div');

      expect(container.classList.contains('min-h-[calc(100dvh-var(--header-height))]')).toBe(true);
      expect(container.classList.contains('min-h-screen')).toBe(false);
    });
  });
});
