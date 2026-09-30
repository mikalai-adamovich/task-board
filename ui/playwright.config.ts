import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, '..');
const serverDir = path.join(repoRoot, 'server');
/**
 * Playwright E2E test configuration for the Task Board UI.
 *
 * THE SUITE BOOTS ITS OWN STACK.
 * Both dependencies are declared as `webServer` entries, so `npx playwright test`
 * needs nothing pre-started and works on a clean CI runner:
 *
 *   1. API — `wrangler dev` on port 8787, pointed at a throwaway database and a
 *      JWT secret generated for THIS run (never written to disk, never logged,
 *      and not a production credential). The port is fixed because the browser
 *      resolves it from `ui/src/environments/environment.ts`.
 *   2. UI  — `ng serve` on port 4200 (same reason).
 *
 * WHY THE API IS NEVER REUSED. The register limiter is 20 accounts per client
 * identifier per hour and lives in Worker memory. A suite that reuses a long-lived
 * dev server therefore passes once and then fails ~15 times on its second run
 * inside the hour — a defect in the suite, not in the product. Playwright starts
 * a FRESH API for every run, so the in-memory budget starts empty each time and
 * the suite is re-runnable indefinitely. The production limiter is untouched.
 * Set `E2E_REUSE_SERVER=1` to opt into reusing an already-running stack (dev
 * convenience; the run is then rate-limit-bound, so run at most ~15 sign-ups/hour).
 *
 * MONGODB_URI: `E2E_MONGODB_URI` (CI) → `MONGODB_URI` → local default. The default
 * is a DEDICATED database name on the standard local Mongo port, so a developer's
 * working data is never touched.
 *
 * DB_CLIENT_MODE: `durable`, the mode production actually runs (cd.yml deploys
 * `--var DB_CLIENT_MODE:durable`), passed explicitly. The Worker entrypoint
 * decides DO routing in `shouldProxyToDurable(env.DB_CLIENT_MODE, …)`
 * (app.ts:236, called from index.ts:28) and that function returns false for any
 * mode other than `durable` — so with the var absent, the one suite that boots
 * a real workerd never constructed a Durable Object, and the DO path production
 * depends on had zero executed coverage. `server/src/do/` still has no test file.
 * `durable` needs no replicaSet: the CI service is a standalone `mongo:7`, and the
 * DO only serialises client access, it does not require a replica.
 */
const API_PORT = 8787;
const UI_PORT = 4200;
const API_URL = `http://127.0.0.1:${API_PORT}/api`;
const UI_URL = `http://127.0.0.1:${UI_PORT}`;
const MONGODB_URI =
  process.env['E2E_MONGODB_URI'] ?? process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017/taskboard_e2e';
/** Throwaway per-run signing secret. Generated, never printed, never persisted. */
const JWT_SECRET = randomBytes(32).toString('hex');
const REUSE_SERVER = process.env['E2E_REUSE_SERVER'] === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // One worker: the shared tenant/project fixture is memoized per worker process,
  // and the register limiter is a per-IP budget — serial execution keeps the run
  // comfortably inside both.
  workers: 1,
  // `open: 'never'` matters on CI, where the default HTML reporter would start a
  // blocking server after the last test and hang the job.
  // `outputFolder` is redirected to the repo-root scratch home: the report is a
  // single ~544 kB minified bundle that is not source code, so it must not be
  // picked up by `eslint .`.
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(repoRoot, '.agent-scratch', 'playwright-report') }],
  ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: UI_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The UI is bound to 127.0.0.1; without this a stray system proxy would
    // swallow every request and the suite would fail for no real reason.
    proxy: undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `npx wrangler dev --port ${API_PORT} --ip 127.0.0.1 --var MONGODB_URI:${MONGODB_URI} --var JWT_SECRET:${JWT_SECRET} --var ALLOWED_ORIGINS:${UI_URL},http://localhost:${UI_PORT} --var DB_CLIENT_MODE:durable`,
      cwd: serverDir,
      url: `${API_URL}/health`,
      reuseExistingServer: REUSE_SERVER,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // N-11: the two preparation steps this command used to carry — rebuild
      // `@task-board/shared` and `rm -rf .angular/cache` — are GONE, and the
      // reason is that the thing they defended against no longer exists.
      //
      // They were there because the shared package was consumed as a BUILT
      // package: a stale `shared/dist`, or a Vite dep cache pre-bundled from an
      // older one, made a lazy chunk fail at import time and the page render
      // blank — a green-looking failure that was really a stale artefact. That
      // is only possible when something reads a build output.
      //
      // Nothing does any more. `shared/package.json`'s `exports` map points at
      // `shared/src/index.ts`, so the dev server, the unit tests and the
      // Worker's esbuild bundle all compile the same source files; the
      // `paths` entry the two UI tsconfigs carried was dead (it resolved
      // outside the repository) and has been removed. Verified by deleting
      // `shared/dist` outright: `npm run typecheck`,
      // `npm test --workspace=server` and `npm run build --workspace=server`
      // (the artefact that ships) all pass without it — see
      // `server/src/testing/shared-resolution.guardrail.test.ts` and
      // `.agent-scratch/audit2/fix-G4-infrastructure.md`.
      //
      // The theme manifest generation stays: that one IS a build artefact the
      // interface reads at runtime (`/themes/manifest.json`).
      command: `cd ${configDir} && npm run generate:themes && npx ng serve --port ${UI_PORT} --host 127.0.0.1`,
      cwd: configDir,
      url: UI_URL,
      // Safe to reuse: the dev server holds no session state, and the rate-limit
      // budget that actually matters lives in the API process above.
      reuseExistingServer: !process.env['CI'] || REUSE_SERVER,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
