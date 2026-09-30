/**
 * Tests for the Register component Signal Form validation.
 *
 * Validates that the form enforces the same rules as the Zod RegisterRequestSchema:
 * - displayName: required, max 100 characters
 * - email: required, valid email format
 * - password: required, min 8 characters, max 128 characters
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { Register } from './register';
import { API_BASE_URL } from '@app/api-url.token';

describe('Register form validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<Register>;

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

    fixture = TestBed.createComponent(Register);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  interface Model {
    displayName: string;
    email: string;
    password: string;
  }

  // ── Display Name validation ──────────────────────────────────────────────

  describe('displayName', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.registerForm.displayName().invalid()).toBe(true);
    });

    it('should be valid for single character', () => {
      component.model.update((m: Model) => ({ ...m, displayName: 'A' }));

      expect(component.registerForm.displayName().valid()).toBe(true);
    });

    it('should be valid at maximum boundary (100 chars)', () => {
      component.model.update((m: Model) => ({ ...m, displayName: 'a'.repeat(100) }));

      expect(component.registerForm.displayName().valid()).toBe(true);
    });

    it('should be invalid when exceeding 100 characters', () => {
      component.model.update((m: Model) => ({ ...m, displayName: 'a'.repeat(101) }));

      expect(component.registerForm.displayName().invalid()).toBe(true);
    });
  });

  // ── Email validation ─────────────────────────────────────────────────────

  describe('email', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.registerForm.email().invalid()).toBe(true);
    });

    it('should be valid for standard email', () => {
      component.model.update((m: Model) => ({ ...m, email: 'user@example.com' }));

      expect(component.registerForm.email().valid()).toBe(true);
    });

    it('should be valid for email without TLD (test@test)', () => {
      component.model.update((m: Model) => ({ ...m, email: 'test@test' }));

      expect(component.registerForm.email().valid()).toBe(true);
    });

    it('should be invalid for email without @ sign', () => {
      component.model.update((m: Model) => ({ ...m, email: 'not-an-email' }));

      expect(component.registerForm.email().invalid()).toBe(true);
    });
  });

  // ── Password validation ──────────────────────────────────────────────────

  describe('password', () => {
    beforeEach(() => setup());

    it('should be invalid when empty', () => {
      expect(component.registerForm.password().invalid()).toBe(true);
    });

    it('should be invalid when shorter than 8 characters', () => {
      component.model.update((m: Model) => ({ ...m, password: 'short' }));

      expect(component.registerForm.password().invalid()).toBe(true);
    });

    it('should be valid at minimum boundary (8 chars)', () => {
      component.model.update((m: Model) => ({ ...m, password: '12345678' }));

      expect(component.registerForm.password().valid()).toBe(true);
    });

    it('should be valid at maximum boundary (128 chars)', () => {
      component.model.update((m: Model) => ({ ...m, password: 'a'.repeat(128) }));

      expect(component.registerForm.password().valid()).toBe(true);
    });

    it('should be invalid when exceeding 128 characters', () => {
      component.model.update((m: Model) => ({ ...m, password: 'a'.repeat(129) }));

      expect(component.registerForm.password().invalid()).toBe(true);
    });
  });

  // ── Form-level validation ────────────────────────────────────────────────

  describe('form validity', () => {
    beforeEach(() => setup());

    it('should be invalid when all fields are empty', () => {
      expect(component.registerForm().invalid()).toBe(true);
    });

    it('should be valid when all fields are correctly filled', () => {
      component.model.update(() => ({
        displayName: 'John Doe',
        email: 'john@example.com',
        password: 'securePass123',
      }));

      expect(component.registerForm().valid()).toBe(true);
    });

    it('should be invalid when displayName is missing', () => {
      component.model.update(() => ({
        displayName: '',
        email: 'john@example.com',
        password: 'securePass123',
      }));

      expect(component.registerForm().invalid()).toBe(true);
    });

    it('should be invalid when email is missing', () => {
      component.model.update(() => ({
        displayName: 'John Doe',
        email: '',
        password: 'securePass123',
      }));

      expect(component.registerForm().invalid()).toBe(true);
    });

    it('should be invalid when password is too short', () => {
      component.model.update(() => ({
        displayName: 'John Doe',
        email: 'john@example.com',
        password: 'short',
      }));

      expect(component.registerForm().invalid()).toBe(true);
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
