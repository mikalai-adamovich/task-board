/**
 * E2E for workspace (tenant) creation — the wizard a brand-new account is sent to.
 *
 * `create-workspace.html` is a three-step flow (details → plan → mock checkout →
 * confirmation); the earlier version of this spec asserted a single submit landed
 * on `/w/:slug`, which the product has never done.
 *
 * Selectors: `#workspace-form` and its `#workspace-name` / `#workspace-slug` inputs
 * plus the first button of the card footer, which is the forward action on every
 * step (continue / confirm) and the submit on the first.
 */
import { anonTest as test, expect } from './fixtures/test';
import { apiRegister, seedSession, uniqueSlug } from './helpers';

/** The forward action of the current wizard step (submit / continue / confirm). */
function wizardAction(page: import('@playwright/test').Page) {
  return page.locator('hlm-card-footer button[hlmBtn]').first();
}

/**
 * Wait until the debounced slug-availability check has resolved.
 *
 * `create-workspace.ts` refuses to advance while the check is in flight, so a
 * test that clicks immediately only proves the guard works. The "available"
 * confirmation is the only green element of the slug field, which is why the
 * handle keys on that class — it is a state marker, not translatable copy.
 */
function slugAvailabilitySettled(page: import('@playwright/test').Page) {
  return page.locator('#workspace-slug').locator('xpath=../following-sibling::p[contains(@class, "text-green")]');
}

test.describe('Workspace creation', () => {
  test('requires authentication', async ({ page }) => {
    await page.goto('/workspace/create');

    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('the details step exposes name, slug and a continue action', async ({ page, request }) => {
    const user = await apiRegister(request, 'wsform');

    await seedSession(page, { token: user.token, tenantId: '' });
    await page.goto('/workspace/create');

    await expect(page.locator('#workspace-form')).toBeVisible();
    await expect(page.locator('#workspace-name')).toBeVisible();
    await expect(page.locator('#workspace-slug')).toBeVisible();
    await expect(wizardAction(page)).toBeEnabled();
  });

  test('walking the wizard creates the workspace and lands inside it', async ({ page, request }) => {
    const user = await apiRegister(request, 'wsmagic');
    const name = `E2E Workspace ${Date.now().toString(36)}`;
    const slug = uniqueSlug('magic');

    await seedSession(page, { token: user.token, tenantId: '' });
    await page.goto('/workspace/create');

    await page.locator('#workspace-name').fill(name);
    await page.locator('#workspace-slug').fill(slug);
    await expect(slugAvailabilitySettled(page)).toBeVisible();

    // details → plan
    await wizardAction(page).click();
    await expect(page.locator('#workspace-form')).toHaveCount(0);
    // plan → checkout
    await wizardAction(page).click();
    // checkout → tenant home
    await wizardAction(page).click();

    await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
    await expect(page.locator('main h1')).toHaveText(name);
  });

  test('a created workspace is still reachable after a reload', async ({ page, request }) => {
    const user = await apiRegister(request, 'wsreload');
    const name = `E2E Reload ${Date.now().toString(36)}`;
    const slug = uniqueSlug('reload');

    await seedSession(page, { token: user.token, tenantId: '' });
    await page.goto('/workspace/create');
    await page.locator('#workspace-name').fill(name);
    await page.locator('#workspace-slug').fill(slug);
    await expect(slugAvailabilitySettled(page)).toBeVisible();
    await wizardAction(page).click();
    await wizardAction(page).click();
    await wizardAction(page).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

    // A hard reload proves the workspace was persisted, not just held in a store.
    await page.reload();

    await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
    await expect(page.locator('main h1')).toHaveText(name);
  });
});
