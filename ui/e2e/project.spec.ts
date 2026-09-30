/**
 * E2E for project creation and navigation, on top of the shared owner workspace.
 *
 * The create-project dialog is opened from the tenant home. Its trigger is the
 * first action button of the page header row (`firstMainAction`), and the form
 * fields carry stable ids (`#project-name`, `#project-key`).
 *
 * NOTE ON THE EXPECTED OUTCOME: creating a project does NOT navigate away — the
 * dialog closes and the tenant home shows the new card. The previous spec
 * expected a jump to `/projects/:key`, which is why it could never pass.
 */
import { test, expect } from './fixtures/test';
import { firstMainAction, main, pageHeading } from './helpers';

/** Fill the create-project dialog and submit it. */
async function createProjectThroughUi(page: import('@playwright/test').Page, name: string, key: string): Promise<void> {
  await firstMainAction(page).click();

  const dialog = page.getByRole('dialog');

  await expect(dialog).toBeVisible();
  await dialog.locator('#project-name').fill(name);
  await dialog.locator('#project-key').fill(key);
  await dialog.locator('button[type="submit"][form="create-project-form"]').click();
}

test.describe('Projects', () => {
  test('the tenant home lists the workspace projects', async ({ page, owner }) => {
    await page.goto(`/w/${owner.tenantSlug}`);

    // The seeded project card renders its name as a heading inside the grid.
    await expect(pageHeading(page, owner.project.name)).toBeVisible();
  });

  test('creates a project through the dialog and lists it', async ({ page, owner }) => {
    const name = `E2E Project ${Date.now().toString(36)}`;
    const key = `EP${Date.now()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')}`.slice(0, 10);

    await page.goto(`/w/${owner.tenantSlug}`);
    await createProjectThroughUi(page, name, key);

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(pageHeading(page, name)).toBeVisible();
    await expect(main(page).locator(`a[href$="/projects/${key}"]`)).toBeVisible();
  });

  test('opens a project from the tenant home list', async ({ page, owner }) => {
    await page.goto(`/w/${owner.tenantSlug}`);
    await main(page).locator(`a[href$="/projects/${owner.project.key}"]`).click();

    await expect(page).toHaveURL(new RegExp(`/w/${owner.tenantSlug}/projects/${owner.project.key}`));
    // The project name is the page heading. Addressing it by its accessible name
    // instead of by heading level: level 2 inside `<main>` is shared by the four
    // widget card titles (Task summary / Active sprint / Recent tasks / Members),
    // so a level selector is a strict-mode violation here (F26).
    await expect(pageHeading(page, owner.project.name)).toHaveText(owner.project.name);
  });
});
