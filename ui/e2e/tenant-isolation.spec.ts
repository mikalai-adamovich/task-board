/**
 * Cross-tenant isolation (the highest-value gap in the previous suite).
 *
 * Two independent workspaces exist: the `owner` fixture and the `stranger`
 * fixture, each with its own user, tenant and project. Nothing may leak between
 * them, neither in the UI (route guards) nor at the API (tenant context).
 */
import { test, expect } from './fixtures/test';
import { API_URL, main } from './helpers';

test.describe('Cross-tenant isolation', () => {
  test('a workspace of another tenant is not reachable by its slug', async ({ page, owner, stranger }) => {
    await page.goto(`/w/${owner.tenantSlug}`);
    await expect(main(page).locator('h1')).toHaveText('E2E Owner workspace');

    await page.goto(`/w/${stranger.tenantSlug}`);

    // `tenantGuard` refuses a slug the session has no membership for and sends
    // the browser back to the entry route, which lands on the OWN workspace.
    await expect(page).toHaveURL(new RegExp(`/w/${owner.tenantSlug}`));
    await expect(main(page).getByText('E2E Stranger workspace')).toHaveCount(0);
  });

  test('a project of another tenant is not reachable by deep link', async ({ page, owner, stranger }) => {
    await page.goto(`/w/${stranger.tenantSlug}/projects/${stranger.project.key}`);

    await expect(page).toHaveURL(new RegExp(`/w/${owner.tenantSlug}`));
    await expect(main(page).getByText(stranger.project.name)).toHaveCount(0);
  });

  test('the API refuses a read scoped to a foreign tenant', async ({ request, owner, stranger }) => {
    const forbidden = await request.get(`${API_URL}/projects/${stranger.project.id}`, {
      headers: { authorization: `Bearer ${owner.token}`, 'x-tenant-id': stranger.tenantId },
    });

    // `tenantContextMiddleware` rejects a non-member before the handler runs.
    expect(forbidden.status()).toBe(403);
  });

  test('the API refuses a foreign project read inside the caller tenant', async ({ request, owner, stranger }) => {
    const response = await request.get(`${API_URL}/projects/${stranger.project.id}`, {
      headers: { authorization: `Bearer ${owner.token}`, 'x-tenant-id': owner.tenantId },
    });

    // A project of another tenant simply does not exist in this scope.
    expect([403, 404]).toContain(response.status());
  });
});
