/**
 * E2E for the project audit log.
 *
 * The audit viewer had no journey coverage at all. The assertion is deliberately
 * relative — the number of rows grows when the owner performs a new action — so
 * it does not depend on the order the specs ran in, nor on the translated column
 * headers.
 */
import { test, expect } from './fixtures/test';
import { apiCreateTask, main } from './helpers';

test.describe('Audit log', () => {
  test('records the actions of the workspace owner', async ({ page, request, owner }) => {
    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/audit`);

    const rows = main(page).locator('table tbody tr');

    await expect(rows.first()).toBeVisible();

    const before = await rows.count();

    // A real, audited action by the owner of this very workspace.
    await apiCreateTask(request, owner, owner.project, `E2E Audited ${Date.now().toString(36)}`);
    await page.reload();

    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  });
});
