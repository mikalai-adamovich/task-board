/**
 * E2E for the task table and the create-task form.
 *
 * The create form (F8) is asserted through the behaviour a user sees: a blocked
 * submission with the inline field error, and a successful submission that lands
 * on the task detail page. The "New task" CTA is located structurally — it is the
 * last button of the task-table toolbar, next to the `data-task-table-search` box.
 */
import { test, expect, taskTable } from './fixtures/test';
import { apiCreateTask, main, newTaskButton, pageHeading } from './helpers';

test.describe('Task table', () => {
  test('lists an existing task of the project', async ({ page, request, owner }) => {
    const title = `E2E Listed ${Date.now().toString(36)}`;

    await apiCreateTask(request, owner, owner.project, title);

    await page.goto(taskTable(owner.tenantSlug, owner.project.key));

    await expect(main(page).getByText(title).first()).toBeVisible();
  });

  test('offers the New task action to a user who can create tasks', async ({ page, owner }) => {
    await page.goto(taskTable(owner.tenantSlug, owner.project.key));

    await expect(newTaskButton(page)).toBeVisible();
  });
});

test.describe('Create task', () => {
  test('blocks an empty title with the inline field error', async ({ page, owner }) => {
    await page.goto(`${taskTable(owner.tenantSlug, owner.project.key)}/new`);

    await page.locator('button[type="submit"][form="create-task-form"]').click();

    // F8: the form validates instead of silently navigating away.
    await expect(page.locator('hlm-field-error').first()).toBeVisible();
    await expect(page).toHaveURL(/\/tasks\/new$/);
  });

  test('creates a task and opens its detail page', async ({ page, owner }) => {
    const title = `E2E Task ${Date.now().toString(36)}`;

    await page.goto(taskTable(owner.tenantSlug, owner.project.key));
    await newTaskButton(page).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);

    await page.locator('#create-title').fill(title);
    await page.locator('button[type="submit"][form="create-task-form"]').click();

    // The detail route is KEY-NUMBER, so the URL carries the new task identity.
    await expect(page).toHaveURL(new RegExp(`/projects/${owner.project.key}/tasks/${owner.project.key}-\\d+$`));
    // The task title is the detail page's own heading. Addressed by the unique
    // run-scoped title this test just typed, NOT by heading level: level 2 inside
    // `<main>` is the "Description" card heading (F26).
    await expect(pageHeading(page, title)).toHaveText(title);
  });

  test('a task created in the UI is listed in the table', async ({ page, owner }) => {
    const title = `E2E Roundtrip ${Date.now().toString(36)}`;

    await page.goto(`${taskTable(owner.tenantSlug, owner.project.key)}/new`);
    await page.locator('#create-title').fill(title);
    await page.locator('button[type="submit"][form="create-task-form"]').click();
    await expect(page).not.toHaveURL(/\/tasks\/new$/);

    await page.goto(taskTable(owner.tenantSlug, owner.project.key));

    await expect(main(page).getByText(title).first()).toBeVisible();
  });
});
