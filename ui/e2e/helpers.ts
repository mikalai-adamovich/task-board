/**
 * Shared helpers for the Playwright E2E suite.
 *
 * ─── Selector policy (repo convention: never select by translated text) ───
 * Every locator in this file is structural: a stable DOM `id` that a component
 * template owns, a `<form id>`, an element type, or an ARIA role. Translatable
 * copy ("Create Project", "Sign out", …) is NEVER used as a selector, so a copy
 * edit or a locale switch cannot break the suite. The only `data-testid` hooks
 * in the app are the two added for the user menu, because that menu has no other
 * stable handle.
 *
 * ─── Selector policy: never select a heading by LEVEL (F26) ───
 * A heading LEVEL is not a stable handle: the app is free to re-level its section
 * headings as long as the page keeps exactly one `<h1>`. Four specs assumed "the
 * page title is the only `h2` inside `<main>`" and broke the moment F20 gave every
 * page a single `h1` and moved the section headings to level 2. Address headings
 * through `pageHeading(page, name)` — role + a data-derived accessible name — or
 * through a structural element. See `pageHeading` below.
 *
 * ─── Why the API is used for setup ───
 * `POST /auth/register` no longer creates a tenant, so a UI-registered user
 * lands on `/workspace/create` outside the app shell. Whether registration
 * SHOULD create a tenant is an open product question, so the suite does not
 * encode an answer to it: the shared fixture creates the tenant explicitly
 * through `POST /tenants` and injects the resulting session. Registration
 * semantics stay untested-by-assumption; the register FORM itself is still
 * covered end-to-end in `auth.spec.ts`.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** process.env without @types/node — the e2e sources are outside every tsconfig. */
const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}) as Record<
  string,
  string | undefined
>;

/**
 * The API origin the BROWSER talks to. Must match `apiBaseUrl` in
 * `ui/src/environments/environment.ts` — it is duplicated here because the e2e
 * sources are not part of the Angular compilation and cannot import it.
 */
export const API_URL = 'http://127.0.0.1:8787/api';

/** The UI origin `playwright.config.ts` serves and `baseURL` points at. */
export const UI_URL = 'http://127.0.0.1:4200';

/**
 * Password of the throwaway E2E accounts. It exists only inside the disposable
 * database the suite provisions and is NOT a credential for anything real.
 * Override with `E2E_TEST_PASSWORD` when a local policy requires it.
 */
export const TEST_PASSWORD = env['E2E_TEST_PASSWORD'] ?? 'E2ePassword123!';

let emailCounter = 0;

/** Unique per run AND per call, so a second run can never collide with the first. */
export function uniqueEmail(prefix = 'e2e'): string {
  emailCounter += 1;

  return `f13-${prefix}-${Date.now().toString(36)}-${emailCounter}-${Math.floor(Math.random() * 1e6)}@e2e.test`;
}

/** A unique, valid tenant slug — `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, max 48 characters. */
export function uniqueSlug(prefix = 'ws'): string {
  emailCounter += 1;

  return `f13-${prefix}-${Date.now().toString(36)}-${emailCounter}`.slice(0, 48);
}

// ─── API-side setup (tenant membership is created here, not assumed) ──────────

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  token: string;
}

export interface SeededTenant {
  id: string;
  slug: string;
  name: string;
}

export interface SeededProject {
  id: string;
  key: string;
  name: string;
  defaultStatusId: string;
}

/** A signed-in session that can be pushed into the browser without a login round-trip. */
export interface BrowserSession {
  token: string;
  tenantId: string;
}

/** `POST /auth/register` — a dedicated account per call (rate-limiter friendly: see the config). */
export async function apiRegister(
  request: APIRequestContext,
  prefix: string,
  displayName = 'E2E User',
): Promise<SeededUser> {
  const email = uniqueEmail(prefix);
  const response = await request.post(`${API_URL}/auth/register`, {
    data: { email, password: TEST_PASSWORD, displayName },
  });

  expect(response.status(), `register ${email} failed`).toBe(201);

  const body = (await response.json()) as { data: { token: string; user: { id: string } } };

  return { id: body.data.user.id, email, password: TEST_PASSWORD, token: body.data.token };
}

/** `POST /tenants` — the creator becomes OWNER. */
export async function apiCreateTenant(
  request: APIRequestContext,
  token: string,
  name: string,
  slug: string,
): Promise<SeededTenant> {
  const response = await request.post(`${API_URL}/tenants`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name, slug },
  });

  expect(response.status(), `create tenant ${slug} failed`).toBe(201);

  const body = (await response.json()) as { data: { id: string; slug: string; name: string } };

  return { id: body.data.id, slug: body.data.slug, name: body.data.name };
}

/** `POST /projects` — `X-Tenant-Id` is what makes the call tenant-scoped. */
export async function apiCreateProject(
  request: APIRequestContext,
  session: BrowserSession,
  name: string,
  key: string,
): Promise<SeededProject> {
  const response = await request.post(`${API_URL}/projects`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
    data: { name, key },
  });

  expect(response.status(), `create project ${key} failed`).toBe(201);

  const body = (await response.json()) as {
    data: { id: string; key: string; name: string; defaultStatusId: string };
  };

  return { id: body.data.id, key: body.data.key, name: body.data.name, defaultStatusId: body.data.defaultStatusId };
}

/**
 * `POST /projects/:id/tasks` — resolves the project's default status and first
 * task type, which the schema requires and the caller should not have to know.
 */
export async function apiCreateTask(
  request: APIRequestContext,
  session: BrowserSession,
  project: SeededProject,
  title: string,
): Promise<{ id: string; number: number; title: string; version: number }> {
  const typesResponse = await request.get(`${API_URL}/projects/${project.id}/task-types`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
  });

  expect(typesResponse.status(), 'list task types failed').toBe(200);

  const types = (await typesResponse.json()) as { data: { id: string }[] };
  const typeId = types.data[0]?.id;

  expect(typeId, 'project has no task type to create a task with').toBeTruthy();

  const response = await request.post(`${API_URL}/projects/${project.id}/tasks`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
    data: { title, statusId: project.defaultStatusId, typeId: typeId as string, priorityLevel: 0 },
  });

  expect(response.status(), `create task "${title}" failed`).toBe(201);

  const body = (await response.json()) as { data: { id: string; number: number; title: string; version: number } };

  return body.data;
}

/** `PATCH /tasks/:id` — move a task into a sprint (the optimistic-locking `version` is required). */
export async function apiAssignTaskToSprint(
  request: APIRequestContext,
  session: BrowserSession,
  task: { id: string; version: number },
  sprintId: string,
): Promise<void> {
  const response = await request.patch(`${API_URL}/tasks/${task.id}`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
    data: { sprintId, version: task.version },
  });

  expect(response.status(), `assign task ${task.id} to sprint failed`).toBe(200);
}

/** `POST /tasks/:taskId/comments` — the body is markdown, like every other rich-text field. */
export async function apiCreateComment(
  request: APIRequestContext,
  session: BrowserSession,
  taskId: string,
  body: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/tasks/${taskId}/comments`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
    data: { body },
  });

  expect(response.status(), `comment on ${taskId}`).toBe(201);
}

/** `POST /projects/:projectId/sprints` — sprint status is a product-level state machine, not a UI string. */
export async function apiCreateSprint(
  request: APIRequestContext,
  session: BrowserSession,
  project: SeededProject,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${API_URL}/projects/${project.id}/sprints`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-tenant-id': session.tenantId },
    data: { name },
  });

  expect(response.status(), `create sprint "${name}" failed`).toBe(201);

  const body = (await response.json()) as { data: { id: string; name: string } };

  return body.data;
}

// ─── Browser session bootstrap ────────────────────────────────────────────────

/**
 * Push an authenticated, tenant-scoped session into the browser.
 *
 * The app restores its session from `localStorage` (`taskboard_token` in
 * `AuthStore`, `taskboard_tenant_id` in `TenantStore`); the guards then call
 * `/auth/bootstrap` to fill the user + tenant list. This is the same end state
 * the login form produces, minus the login form itself — and it is what makes
 * a registered account usable in tests without changing registration semantics.
 */
export async function seedSession(page: Page, session: BrowserSession): Promise<void> {
  await page.addInitScript(
    ([token, tenantId]) => {
      localStorage.setItem('taskboard_token', token as string);
      localStorage.setItem('taskboard_tenant_id', tenantId as string);
    },
    [session.token, session.tenantId] as const,
  );
}

// ─── Structural locators ─────────────────────────────────────────────────────

/**
 * The routed page body. `app-shell.html` renders exactly one `<main>` around the
 * router outlet, so scoping to it keeps the header and the sidebar out of every
 * assertion — no translatable text needed to disambiguate.
 */
export function main(page: Page): Locator {
  return page.locator('main');
}

/**
 * The page's own title heading, addressed by its ACCESSIBLE NAME — never by its
 * level.
 *
 * ─── Why level is forbidden here (F26) ───
 * Four specs used to assert `main(page).getByRole('heading', { level: 2 })` as if
 * the page title were the only `h2` on the page. F20 gave every page exactly one
 * `<h1>` (pinned by `ui/src/app/document-structure.spec.ts`) and re-levelled the
 * section headings underneath it, so the page title moved to level 1 while section
 * headings took over level 2 — the four specs went red on correct markup. The
 * heading tree is a product decision that will move again; the test should depend
 * on the title the user reads, not on the integer.
 *
 * ─── How to stay unique ───
 * The name is always PROJECT/TASK/SPRINT DATA the test itself created (a title or
 * a workspace/project name built from a run-unique suffix), never translatable UI
 * copy. A heading role + a data-derived name is unique on the page; if it ever
 * stops being, the failure is a real duplication, not a selector to be loosened.
 * Section headings ("Description", "Task summary", …) are translatable copy, so
 * they are never used as a name here either.
 */
export function pageHeading(page: Page, name: string | RegExp): Locator {
  return main(page).getByRole('heading', { name });
}

/**
 * The primary action button of a page header row (Create project / New sprint).
 * On the tenant home and the sprint list the first `hlmBtn` inside `<main>` is
 * that CTA — the templates put it in the header row before any other control.
 */
export function firstMainAction(page: Page): Locator {
  return main(page).locator('button[hlmBtn]').first();
}

/** The "New task" CTA: the last button of the task-table toolbar, right of the search box. */
export function newTaskButton(page: Page): Locator {
  return page.locator('[data-task-table-search]').locator('xpath=following-sibling::button').last();
}

/** The header avatar button that opens the user dropdown. */
export function userMenuTrigger(page: Page): Locator {
  return page.getByTestId('user-menu-trigger');
}

/** The destructive item inside the user dropdown. */
export function signOutItem(page: Page): Locator {
  return page.getByTestId('user-menu-sign-out');
}

/** Sign out through the header menu and wait for the unauthenticated route. */
export async function logoutUser(page: Page): Promise<void> {
  await userMenuTrigger(page).click();
  await signOutItem(page).click();

  await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15_000 });
}

/** Fill and submit the register form (structural ids from `register.html`). */
export async function registerThroughUi(
  page: Page,
  email: string,
  password = TEST_PASSWORD,
  displayName = 'E2E User',
): Promise<void> {
  await page.goto('/auth/register');
  await page.locator('#displayName').fill(displayName);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#confirmPassword').fill(password);
  await page.locator('button[type="submit"][form="register-form"]').click();
}

/** Fill and submit the sign-in form (structural ids from `login.html`). */
export async function loginThroughUi(page: Page, email: string, password = TEST_PASSWORD): Promise<void> {
  await page.goto('/auth/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"][form="login-form"]').click();
}
