/**
 * Shared E2E fixtures.
 *
 * `test` gives a browser page that is ALREADY signed in and scoped to a
 * workspace (tenant) with one project — the state a normal user reaches after
 * register → create workspace → create project. `anonTest` is the unauthenticated
 * browser for the auth/guard journeys.
 *
 * Why the setup goes through the API: `POST /auth/register` does not create a
 * tenant (that is an open product question, not an E2E decision), so a
 * UI-registered user sits on `/workspace/create` outside the app shell. The
 * fixture therefore creates the workspace explicitly and injects the session —
 * product behaviour is left untouched. The register/login FORMS are still driven
 * through the UI in `auth.spec.ts`.
 *
 * The two workspaces are created ONCE per worker process (memoized promises), so
 * a full run performs 2 registrations instead of one per test — that is what
 * keeps the suite inside F10's 20-accounts-per-hour register budget.
 */
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  apiCreateProject,
  apiCreateTenant,
  apiRegister,
  seedSession,
  TEST_PASSWORD,
  uniqueSlug,
  type BrowserSession,
  type SeededProject,
} from '../helpers';

export interface Workspace extends BrowserSession {
  email: string;
  password: string;
  userId: string;
  tenantSlug: string;
  project: SeededProject;
}

let ownerPromise: Promise<Workspace> | undefined;
let strangerPromise: Promise<Workspace> | undefined;

/** Short, unique-per-run, and valid for the project-key rule (2-10, `[A-Z][A-Z0-9]*`). */
function uniqueProjectKey(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

/** Create user → tenant → project through the API and return a ready session. */
async function seedWorkspace(request: APIRequestContext, prefix: string, displayName: string): Promise<Workspace> {
  const user = await apiRegister(request, prefix, displayName);
  const tenant = await apiCreateTenant(request, user.token, `${displayName} workspace`, uniqueSlug(prefix));
  const session: BrowserSession = { token: user.token, tenantId: tenant.id };
  const project = await apiCreateProject(request, session, `${displayName} project`, uniqueProjectKey(`${prefix}X`));

  return {
    ...session,
    email: user.email,
    password: TEST_PASSWORD,
    userId: user.id,
    tenantSlug: tenant.slug,
    project,
  };
}

/** Worker-scoped: one workspace per worker process, shared by every test. */
interface WorkspaceFixtures {
  owner: Workspace;
  stranger: Workspace;
}

export const test = base.extend<{ page: Page }, WorkspaceFixtures>({
  /** The signed-in owner of the primary workspace. */
  owner: [
    async ({ playwright }, use) => {
      ownerPromise ??= (async () => {
        const request = await playwright.request.newContext();

        try {
          return await seedWorkspace(request, 'own', 'E2E Owner');
        } finally {
          await request.dispose();
        }
      })().catch((error: unknown) => {
        // A failed seed must not be memoized: Playwright restarts the worker after
        // a worker-fixture error, and a cached rejection would poison every test.
        ownerPromise = undefined;
        throw error;
      });

      await use(await ownerPromise);
    },
    { scope: 'worker' },
  ],

  /**
   * A second, unrelated workspace. Used only by the cross-tenant isolation
   * journey: the owner must not be able to reach anything inside it.
   */
  stranger: [
    async ({ playwright }, use) => {
      strangerPromise ??= (async () => {
        const request = await playwright.request.newContext();

        try {
          return await seedWorkspace(request, 'str', 'E2E Stranger');
        } finally {
          await request.dispose();
        }
      })().catch((error: unknown) => {
        strangerPromise = undefined;
        throw error;
      });

      await use(await strangerPromise);
    },
    { scope: 'worker' },
  ],

  /** Injects the owner session before the first navigation of every test. */
  page: async ({ page, owner }, use) => {
    await seedSession(page, owner);
    await use(page);
  },
});

/** Unauthenticated browser — for the register / sign-in / guard journeys. */
export const anonTest = base;

export { expect };

/** `/w/:slug` — the tenant home. */
export function tenantHome(slug: string): string {
  return `/w/${slug}`;
}

/** `/w/:slug/projects/:key/tasks` — the task table of a project. */
export function taskTable(slug: string, projectKey: string): string {
  return `/w/${slug}/projects/${projectKey}/tasks`;
}
