/**
 * E2E for the authentication journeys, driven through the real forms
 * (Signal Forms + Spartan Helm fields) against the running API.
 *
 * These are the only tests that register through the UI on purpose: the register
 * form itself must be covered. The workspace/tenant that the rest of the suite
 * uses is created by the shared fixture instead (see `fixtures/test.ts`).
 *
 * Selectors are structural ids from `register.html` / `login.html`.
 */
import { anonTest as test, expect } from './fixtures/test';
import {
  apiCreateTenant,
  apiRegister,
  UI_URL,
  loginThroughUi,
  logoutUser,
  registerThroughUi,
  seedSession,
  TEST_PASSWORD,
  uniqueEmail,
  uniqueSlug,
} from './helpers';

test.describe('Registration', () => {
  test('the form exposes every field the account needs', async ({ page }) => {
    await page.goto('/auth/register');

    await expect(page.locator('#displayName')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#confirmPassword')).toBeVisible();
    await expect(page.locator('button[type="submit"][form="register-form"]')).toBeEnabled();
  });

  test('a mismatched confirmation blocks submission and shows the field error', async ({ page }) => {
    await page.goto('/auth/register');
    await page.locator('#displayName').fill('E2E User');
    await page.locator('#email').fill(uniqueEmail('mismatch'));
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.locator('#confirmPassword').fill('Different123!');
    await page.locator('button[type="submit"][form="register-form"]').click();

    // `register.ts` refuses a mismatch at submit time and renders the message in
    // the card alert — the visible proof that no account was created.
    await expect(page.locator('hlm-alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/register/);
  });

  test('registering authenticates the new account', async ({ page }) => {
    await registerThroughUi(page, uniqueEmail('register'));

    // Out of the auth section…
    await expect(page).not.toHaveURL(/\/auth\//);
    // …and signed in: `header-actions.html` renders the user menu only for an
    // authenticated session and the sign-in button only for an anonymous one.
    await expect(page.locator('ui-user-menu')).toHaveCount(1);
  });
});

test.describe('Sign in', () => {
  test('the form exposes e-mail, password and a submit button', async ({ page }) => {
    await page.goto('/auth/login');

    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"][form="login-form"]')).toBeEnabled();
  });

  test('a wrong password is rejected with a visible error', async ({ page, request }) => {
    const user = await apiRegister(request, 'badpassword');

    await loginThroughUi(page, user.email, 'WrongPassword123!');

    // The auth cards render a destructive alert on failure (hlm-alert + variant).
    await expect(page.locator('hlm-alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.locator('ui-user-menu')).toHaveCount(0);
  });

  test('signing in takes the user into their workspace', async ({ page, request }) => {
    const user = await apiRegister(request, 'signin');
    const tenant = await apiCreateTenant(request, user.token, 'Sign in workspace', uniqueSlug('si'));

    await loginThroughUi(page, user.email, user.password);

    // An authenticated user with an accessible workspace is forwarded into it.
    await expect(page).toHaveURL(new RegExp(`/w/${tenant.slug}`));
    await expect(page.locator('main h1')).toHaveText('Sign in workspace');
  });
});

test.describe('Sign out', () => {
  test('signing out returns to the sign-in page and drops the stored session', async ({ page, request }) => {
    const user = await apiRegister(request, 'logout');
    const tenant = await apiCreateTenant(request, user.token, 'Sign out workspace', uniqueSlug('so'));

    await seedSession(page, { token: user.token, tenantId: tenant.id });
    await page.goto(`/w/${tenant.slug}`);
    await expect(page.locator('main h1')).toHaveText('Sign out workspace');

    await logoutUser(page);

    await expect(page.locator('ui-user-menu')).toHaveCount(0);
    await expect(page.locator('ui-sign-in-button')).toHaveCount(1);
    // The JWT is really gone from storage — not merely hidden by the header.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('taskboard_token'))).toBeNull();
  });

  test('a tenant route redirects to sign-in for an anonymous visitor', async ({ browser, request }) => {
    const user = await apiRegister(request, 'guard');
    const tenant = await apiCreateTenant(request, user.token, 'Guard workspace', uniqueSlug('gd'));
    // A context with no injected session: the auth guard has nothing to work with.
    const context = await browser.newContext({ baseURL: UI_URL });
    const page = await context.newPage();

    try {
      await page.goto(`/w/${tenant.slug}`);

      await expect(page).toHaveURL(/\/auth\/login/);
    } finally {
      await context.close();
    }
  });
});
