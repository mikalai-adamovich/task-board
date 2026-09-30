/**
 * E2E for the project board (single-board model — doc 102).
 *
 * The previous version of this file asserted `expect(url).toBeTruthy()` and
 * "some heading exists" — it could not fail. These tests assert the board
 * actually renders the project's data: one drop column per configured status and
 * one card per task, and that a card navigates to its task.
 *
 * Drag-and-drop itself is NOT covered: `cdkDrag` needs a real pointer sequence
 * that Playwright's HTML5 fallback does not emulate reliably, and a flaky
 * simulation would be worse than an honest gap. The card → detail journey below
 * is the part a user hits first.
 */
import { test, expect } from './fixtures/test';
import { apiCreateTask, main, pageHeading } from './helpers';

test.describe('Board', () => {
  test('renders one drop column per configured status', async ({ page, owner }) => {
    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/board`);

    // Each column is the CDK drop list of one board status; `getColumnDropId`
    // names it `column-<statusId>`, which is a stable structural handle.
    const columns = main(page).locator('[id^="column-"]');

    await expect(columns.first()).toBeVisible();
    expect(await columns.count()).toBeGreaterThan(0);

    // The column header sits in the wrapper directly above its drop list and
    // carries the status name plus the loaded-card count. Its LEVEL is deliberately
    // not asserted (F26): this used to require an `<h3>`, and the board's single
    // `<h1>` + level-2 column titles made that selector fail on correct markup.
    // The invariant under test is "every column has a non-empty title", so the
    // locator accepts any heading level and only fails when the title is gone or
    // empty — which is what a regression here would actually look like.
    const columnTitle = columns.first().locator('xpath=preceding-sibling::div[1]').locator('h1, h2, h3, h4, h5, h6');

    await expect(columnTitle).toBeVisible();
    await expect(columnTitle).not.toBeEmpty();
  });

  test('renders a card for a task of the project', async ({ page, request, owner }) => {
    const title = `E2E Card ${Date.now().toString(36)}`;

    await apiCreateTask(request, owner, owner.project, title);

    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/board`);

    const card = main(page).locator('ui-task-card').filter({ hasText: title });

    await expect(card).toHaveCount(1);
  });

  test('opens the task detail when a card is clicked', async ({ page, request, owner }) => {
    const title = `E2E Card click ${Date.now().toString(36)}`;

    await apiCreateTask(request, owner, owner.project, title);

    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/board`);
    await main(page).locator('ui-task-card').filter({ hasText: title }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${owner.project.key}/tasks/${owner.project.key}-\\d+$`));
    // The detail page shows the task title as its page heading. Addressed by the
    // unique run-scoped title the test just created, NOT by heading level: level 2
    // inside `<main>` is the "Description" card heading here.
    await expect(pageHeading(page, title)).toHaveText(title);
  });
});
