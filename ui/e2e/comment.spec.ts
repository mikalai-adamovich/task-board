/**
 * E2E for the comment thread of a task.
 *
 * The journey is the one a user performs: type into the comment editor of a task
 * and see the comment appear in the thread under its author. The editor is the
 * Milkdown WYSIWYG surface, so the assertion targets the rendered result rather
 * than the editor's internals.
 */
import { test, expect } from './fixtures/test';
import { apiCreateComment, apiCreateTask, main } from './helpers';

test.describe('Comments', () => {
  test('a comment written in the UI appears in the task thread', async ({ page, request, owner }) => {
    const title = `E2E Commented ${Date.now().toString(36)}`;
    const body = `Reviewed in the E2E run ${Date.now().toString(36)}`;
    const task = await apiCreateTask(request, owner, owner.project, title);

    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/tasks/${owner.project.key}-${task.number}`);

    const thread = main(page).locator('ui-comment-thread');

    await expect(thread).toBeVisible();

    const editor = thread.locator('[contenteditable="true"]');

    await expect(editor).toBeVisible();
    await editor.click();
    await editor.pressSequentially(body);

    // The submit button is the only action button of the new-comment form.
    await thread.locator('button[hlmBtn]').last().click();

    await expect(thread.getByText(body).first()).toBeVisible();
  });

  test('the thread renders a comment that already exists', async ({ page, request, owner }) => {
    const title = `E2E Threaded ${Date.now().toString(36)}`;
    const body = `Existing comment ${Date.now().toString(36)}`;
    const task = await apiCreateTask(request, owner, owner.project, title);

    await apiCreateComment(request, owner, task.id, body);

    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/tasks/${owner.project.key}-${task.number}`);

    await expect(main(page).locator('ui-comment-thread').getByText(body).first()).toBeVisible();
  });
});
