/**
 * E2E for the sprint list and the sprint/backlog split.
 *
 * The previous version of this file contained two no-op tests
 * (`expect(url).toBeTruthy()`), so the sprint journey had no effective coverage.
 *
 * F7 changed the filter contract: the backlog is "tasks with no sprint", which the
 * sprint list now requests with `hasSprint: false` (see `sprint-list.ts`). The
 * third test below is the user-visible proof of that contract — the backlog badge
 * counts a task before it is sprinted and stops counting it afterwards.
 */
import { test, expect } from './fixtures/test';
import {
  apiAssignTaskToSprint,
  apiCreateProject,
  apiCreateSprint,
  apiCreateTask,
  firstMainAction,
  main,
} from './helpers';

/** The backlog count badge of the sprint list (`<count> tasks` — the number is the contract). */
function backlogBadge(page: import('@playwright/test').Page) {
  return page.locator('ng-icon[name="lucideInbox"]').locator('xpath=..').locator('span[hlmBadge]');
}

async function createSprintThroughUi(
  page: import('@playwright/test').Page,
  slug: string,
  projectKey: string,
  name: string,
): Promise<void> {
  await page.goto(`/w/${slug}/projects/${projectKey}/sprints`);
  await firstMainAction(page).click();

  const dialog = page.getByRole('dialog');

  await dialog.locator('#sprint-name').fill(name);
  await dialog.locator('#sprint-start').fill('2026-01-05');
  await dialog.locator('#sprint-end').fill('2026-01-19');
  await dialog.locator('button[type="submit"][form="create-sprint-form"]').click();

  await expect(main(page).getByRole('heading', { name })).toBeVisible();
}

test.describe('Sprints', () => {
  test('a project without sprints shows the empty state', async ({ page, owner }) => {
    await page.goto(`/w/${owner.tenantSlug}/projects/${owner.project.key}/sprints`);

    await expect(main(page).locator('hlm-empty')).toBeVisible();
  });

  test('creates a sprint through the dialog and lists it', async ({ page, owner }) => {
    const name = `E2E Sprint ${Date.now().toString(36)}`;

    await createSprintThroughUi(page, owner.tenantSlug, owner.project.key, name);

    // The new sprint is grouped and links to its own detail page.
    await expect(main(page).locator('a[href*="/sprints/"]').filter({ hasText: name })).toBeVisible();
  });

  test('a task leaves the backlog once it is assigned to a sprint (F7)', async ({ page, request, owner }) => {
    const stamp = Date.now().toString(36);
    // A project of its own: the backlog badge counts the WHOLE project, so a
    // shared project would make the number depend on which specs ran before.
    const project = await apiCreateProject(request, owner, `E2E Sprint project ${stamp}`, `F7${stamp.toUpperCase()}`);
    const sprintName = `E2E Sprint F7 ${stamp}`;
    const taskTitle = `E2E Backlog ${stamp}`;

    await createSprintThroughUi(page, owner.tenantSlug, project.key, sprintName);

    const task = await apiCreateTask(request, owner, project, taskTitle);

    // The badge is a count fetched with the page: reload so it sees the task.
    await page.reload();

    // Before: the task has no sprint, so the badge counts it.
    await expect(backlogBadge(page)).toHaveText(/\b1\b/);

    const sprint = await apiCreateSprint(request, owner, project, `${sprintName} target`);

    await apiAssignTaskToSprint(request, owner, task, sprint.id);
    await page.reload();

    // After: `hasSprint: false` no longer matches it, and the sprint owns it.
    await expect(backlogBadge(page)).toHaveText(/\b0\b/);
    await page.goto(`/w/${owner.tenantSlug}/projects/${project.key}/sprints/${sprint.id}`);
    await expect(main(page).getByText(taskTitle).first()).toBeVisible();
  });
});
