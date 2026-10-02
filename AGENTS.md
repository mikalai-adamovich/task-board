# AGENTS.md — Agent Entry Point

> Read this file first: the mental model of the repo in ~2 minutes. Deep details live in
> [`docs/architecture.md`](docs/architecture.md) — load sections on demand.

**Where things live.** Application layer → [`docs/architecture.md`](docs/architecture.md). Harness layer → the
specialist capability in
[`.roo/rules-harness-evaluator/01-harness-capability.md`](.roo/rules-harness-evaluator/01-harness-capability.md), whose
operator manual is [`.harness/README.md`](.harness/README.md). This file is the router; it repeats neither.

## What this is

**Task Board** — a mini-Jira: multi-tenant workspaces → projects → kanban boards / task tables / sprints, with comments,
labels, saved filters and an audit log. A monorepo with three npm workspaces.

## Stack

| Layer      | Tech                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI         | Angular 22 (zoneless, OnPush by default, Signal Forms, signals-first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| UI kit     | Spartan UI (`@spartan-ng/brain` headless + `helm` styled), Tailwind v4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| i18n       | Transloco (11 locales in `ui/public/assets/i18n/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rich text  | Milkdown (`ui/src/app/shared/milkdown-editor/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Server     | Hono on Cloudflare Workers (`nodejs_compat`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DB         | MongoDB (driver 7; `DB_CLIENT_MODE` — production runs `durable` = app + persistent client inside a Durable Object, `per-request` is the proven rollback)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Security   | The four authentication rate-limit buckets are enforced by **MongoDB** (`services/rate-limit-authority.service.ts`), so the credential-stuffing ceiling is `limit` and never multiplies by instances. The counter is a **distinct operation from the user lookup**, so a counter fault leaves the credential lookup working — which is why the authority **fails CLOSED**: a store that cannot return a verdict admits nobody, and answers with the existing throttled contract, `429 RATE_LIMITED` + `Retry-After` + `RateLimit-*`. `utils/rate-limiter.ts` stays in front as an **advisory** check: it may refuse early but never admits. Design, storage model and the measured worst-case calculation: [`docs/architecture.md`](docs/architecture.md) §2.7. |
| Validation | Zod v4 via `@hono/zod-validator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Auth       | JWT HS256 (`hono/jwt`), bcryptjs password hashing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Email      | Resend (falls back to console logger without `RESEND_API_KEY`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tests      | Vitest (server + ui unit), Playwright (e2e in `ui/e2e/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Shared types/constants live in `shared/` (`@task-board/shared`) — runtime-library-free, single source of truth for
server and UI.

## Commands

```bash
npm run check:fast       # lint + typechecks (shared, server, UI)           ~20 s
npm run check            # CANONICAL GATE: check:fast + both test suites   ~45-90 s
npm run check:full       # check + all three builds                       ~60-120 s
npm run build            # shared → server → ui
npm run typecheck        # shared + server ONLY — no UI, no build; use check/check:fast, never this alone
npm test                 # vitest: run both server and ui suites
npm run test:integration # the rate-limit counter spec against a REAL MongoDB — needs a reachable cluster
npm run lint             # eslint across repo
npm run harness -- list  # NOT everyday work — the measurement layer; `--help` screens it, .harness/README.md is the manual
npm run dev --workspace=server   # wrangler dev (needs MONGODB_URI/JWT_SECRET in server/.dev.vars, gitignored)
npm start --workspace=ui         # ng serve
npm run test:e2e                 # playwright — self-bootstrapping: it starts wrangler dev + ng serve itself
```

### REQUIRED_CONFIGURATION — the Worker refuses to start without these

The Worker **refuses to start** if either of these is missing or blank. This is not a warning and not a probe result:
`assertRequiredConfiguration` (`server/src/config/runtime-config.ts`) runs as the first statement of the Worker
entrypoint (`server/src/index.ts`) and again in the Durable Object (`server/src/do/mongo-do.ts`), and it throws.

| Variable      | Required | How to set it                                                        | If it is missing                                                                 |
| ------------- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `MONGODB_URI` | **yes**  | Worker secret (`wrangler secret put MONGODB_URI`) or a `vars:` entry | The Worker answers **nothing** — not `/api/health`, not `/api/readyz`.           |
| `JWT_SECRET`  | **yes**  | Worker secret (`wrangler secret put JWT_SECRET`)                     | Same: the Worker answers nothing, rather than serving with an empty signing key. |

The required set is exactly those two. `RESEND_API_KEY` is deliberately **not** required: without it the container falls
back to a console mailer, which is a degraded feature, not a broken deployment. Adding a variable to the required set
changes `REQUIRED_CONFIG` and its test.

**Consequence, chosen deliberately:** a misconfigured deployment is **DOWN**, not degraded. That is the point — the
alternative is a deployment that is green on every signal the system exposes and still cannot sign a token.
`GET /api/readyz` still computes and reports the configuration verdict (which variable is absent) for local and test
use; under the boot gate that endpoint is unreachable, because the process that would answer it does not start. The boot
failure message names the missing variables and **never their values**.

```bash
# A deployer sets both, in this order, before the Worker is deployed:
wrangler secret put MONGODB_URI
wrangler secret put JWT_SECRET
```

### Canonical verification gates

`npm run check` is the application project gate. It deliberately includes the **UI typecheck**, which
`npm run typecheck` alone does not cover — a change that breaks Angular compilation must never be called green.

| Work changed                            | Run                        | Coverage and scope                                                                                                                                                                |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`, `ui/`, or `shared/`          | `npm run check`            | Application project gate: lint, typecheck, and server/UI tests.                                                                                                                   |
| `.harness/` or `.roomodes`              | `npm run check:harness`    | Agent-harness gate: harness self-test and frozen compatibility check.                                                                                                             |
| the rate-limit counter store / pipeline | `npm run test:integration` | The `rate-limit-integration` job in CI; locally it needs a reachable MongoDB via `RATE_LIMIT_COUNTER_TEST_URI`. Blocking on failure, skipped-to-green without the URI. See below. |

The harness gate is **local only**: no workflow in `.github/workflows/` runs `npm run check:harness`, so no harness
result can reach CI, a required status, or a deploy. Run it yourself when `.harness/` or `.roomodes` change.

#### `npm run test:integration` — a real cluster, in CI but not in `npm run check`

`server/src/repositories/rate-limit-counter.repository.integration.test.ts` is the only test that proves the decisive
claim of the rate-limit authority: that one `findOneAndUpdate` pipeline is atomic under concurrency, and that the
`E11000` upsert race converges against a server that really raises it. A stub cannot establish either, so the suite is
skipped unless `RATE_LIMIT_COUNTER_TEST_URI` names a cluster.

It is **not** part of `npm run check`, and it must stay that way: a unit gate that needs a database fails on a machine
without one, and the local gate has to stay runnable with no services at all.

It **is** in CI, as its own `rate-limit-integration` job, because the alternative is the one this suite was written
against — no workflow runs it, so a missing cluster turns the run into a **skip**, and a skip reads as a pass. The job
provides its own unauthenticated `mongo:7` service container (the pin the `e2e` job already uses, published
`27017:27017`, mongosh-ping health check the job waits for) and points `RATE_LIMIT_COUNTER_TEST_URI` at a database name
of its own, so it cannot read or drop the e2e suite's data. No migrations: the suite builds the TTL index it asserts
against in `beforeAll`. **Blocking** — no `continue-on-error`, no `|| true`; a red assertion fails the job.

Whether the job is a _required status check_ is **owner-controlled branch protection on the hosting service**, not a
workflow setting, and no required-check list is committed in this repository. It is **not** in that list today: the
`e2e` job was seen named as an expected required check on `main` at push time, while `rate-limit-integration` was not,
so today the job fails CI on every push and pull request and the merge is not gated by it — unlike `e2e`.

Run it locally when the counter store or its pipeline changes:

```bash
docker compose up -d mongo   # or any reachable MongoDB
RATE_LIMIT_COUNTER_TEST_URI=mongodb://localhost:27017/taskboard npm run test:integration
```

Without the variable the run is a **skip**, which reads as a pass: check the output says the suite RAN, not that it was
skipped. Expect tens of seconds rather than a few — the TTL-monitor case waits for a background sweep that runs about
once a minute.

Running the project gate during harness-only work, or the harness gate during project-only work, is wasted time: each
gate covers its own side.

#### The two gates, named unambiguously

There are two gates and they are not the same thing. Use these names, and do not use them interchangeably:

| Name                                      | What it is                                                                                                                                                                                                                  | What it does NOT cover                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The LOCAL project gate**                | `npm run check` — lint, the three typechecks, both test suites. The fast feedback loop.                                                                                                                                     | `check:i18n`, the UI build, the **server bundle build**, the pinned-tooling scan, commitlint, the dependency audit, the e2e and rate-limit-integration jobs. |
| **CI — THE REAL GATE** (the release gate) | `.github/workflows/ci.yml` — the local gate **plus** `check:i18n`, the UI build, the **server bundle build** (the artefact that ships), the pinned-tooling scan, commitlint, and the `rate-limit-integration` database job. | The e2e job, unless the owner marks it required in the hosting settings (see the table below).                                                               |

**Therefore: "green locally" is not a claim about what ships.** `npm run check` passing means lint, typecheck and unit
tests passed. It says nothing about whether the Worker bundles, whether the UI builds, whether an i18n key is missing,
or whether a dependency has an unpatched advisory. Only **CI — THE REAL GATE** speaks for the deployable, and only a
green CI run plus a green CD smoke check does.

The local gate is deliberately kept as a subset: it is the floor, not the ceiling, because it runs on every save.
Widening `check` to match CI would change `package.json` — an owner-approval boundary — and make every local run pay the
build time. That is a standing owner decision, not an oversight; the naming above is what makes the gap unmissable in
the meantime.

**Blocking vs advisory in CI** (name them, so "CI is green" is not read as "every control held"):

| Control                                                                            | Status                       | Why                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lint, 3 typechecks, server + UI tests, `check:i18n`, UI build, server bundle build | **blocking**                 | a failure here is a defect                                                                                                                                                                                                                                                                                                                                                     |
| "Assert pipeline tooling is pinned" (`npx` must carry an exact version)            | **blocking**                 | one unpinned fetch runs with every production secret in the environment                                                                                                                                                                                                                                                                                                        |
| commitlint                                                                         | **blocking on PRs**          | see the workflow's own conditions                                                                                                                                                                                                                                                                                                                                              |
| `e2e` job                                                                          | **required** check on `main` | owner-deferred (**C-11**), but the deferral is over: GitHub named `e2e` as an expected required status check when pushing to `main` (2026-10-02), and that push only landed because it carried admin bypass. NOT a workflow setting — the job carries no `continue-on-error`; the requirement is a **branch-protection rule on the hosting service**, outside this repository. |
| `rate-limit-integration` job                                                       | **blocking on failure**      | the step inherits vitest's non-zero exit with no `continue-on-error` and no `\|\| true`. That makes it BLOCKING **in the workflow**; it is **not yet a required status check** on the hosting service, so it fails the run without gating a merge. Adding it to branch protection is a settings change outside this repository.                                                |
| `npm audit --audit-level=high`                                                     | **blocking**                 | the step fails the build and carries no `continue-on-error`. Measured on the current tree: exit 0 — 0 high, 0 critical, 2 moderate (below the enforced level). A transitive whose parent pins it exactly cannot be fixed by `npm audit fix`; root `overrides` is the only lever npm offers there                                                                               |
| `format:check`                                                                     | **advisory**                 | carries a stated condition and a re-evaluation date; re-evaluating it is the owner's date call                                                                                                                                                                                                                                                                                 |

Report the command and its outcome in the completion message; your own statement is never the evidence:

```
STATUS: DONE            # or INCOMPLETE
VERIFICATION:
  command: npm run check
  result: PASS          # PASS | FAIL | NOT_RUN
```

The block is a **reporting convention, not proof**: independent verification re-runs the gate itself. An unrun or failed
gate is reported as exactly that (`result: FAIL` / `NOT_RUN`).

## Harness layer

Ordinary work needs **none** of this. When a task is about attributing a gate result to a commit, about a historical
range, or about provenance, switch to the `harness-evaluator` mode and follow its capability file. A verdict file can be
handed to you by a third party, so read `scope` first: a non-`FULL_GATE` result is not whole-project validation.

`npm run check:harness` is the agent-harness gate: it runs the harness self-test plus the frozen compatibility check.
Run it when `.harness/` or `.roomodes` change and not otherwise — the harness has no effect on the application.

## Boundaries

- Allowed by default: read/search files, run tests, typecheck, lint, build, dev servers.
- Ask first: installing dependencies, changing `package.json`/lockfiles, schema or RBAC-matrix changes, destructive DB
  operations (drop/delete of collections or data).
- Only when explicitly asked: `git commit`, `git push`. Never force-push or rewrite history.
- Never run automatically: `npm run deploy:server` / `deploy:ui` (production deploys) — prefer a human running them.
- Secrets (`server/.dev.vars` for local dev; Worker secrets + GitHub repo secrets for production): read only when
  genuinely necessary, never print or copy into reports, logs or commits.

### Agent scratch

All agent scratch goes in `.agent-scratch/` and nowhere else — a probe, a throwaway analysis, a one-off script. The
directory is gitignored and excluded from ESLint and Prettier, so a file left there costs nothing. Naming the directory
here is a convention about where scratch GOES, not a licence to point durable documentation or application source at
what is inside it. Scratch is disposable: delete it when the task ends.

### Tool surface is not a boundary

Mode selection is a convention, not a mechanism that routes automatically, and a narrower tool surface is **not** a
security boundary — so never call a mode, role or tool surface isolated, sandboxed or protected.

## Layout

```
server/src/   routes/ (thin handlers) · services/ · repositories/ · schemas/ (Zod)
              middleware/ · container.ts (DI composition root) · errors/
ui/src/app/   features/<domain>/<component>/ · services/ (*-client.ts) · stores/ · guards/
              interceptors/ · shell/ · shared/
shared/src/   types/ · constants/ · utils/
```

## Hard rules (must / must-not)

Full rationale in [`docs/architecture.md`](docs/architecture.md) §7.

### Server

- **NEVER** access `getCollection()` inline in route handlers — go through a service.
- **NEVER** cache services/repositories/collections at module level — the service graph stays request-scoped:
  `container.ts` + `provideServices` middleware (`c.get('svc')`). The `MongoClient` lifecycle is selected by
  `DB_CLIENT_MODE` (`db/mongo.ts`): production is `durable` (the Hono app + a persistent pool live inside
  `do/mongo-do.ts`), `per-request` is the proven rollback, `singleton` is the known-broken plain-Worker experiment.
- Container wiring is a **guardrail**: `ProjectService`/`TenantService` cross-aggregate deps are required constructor
  parameters, and `server/src/container.test.ts` builds the real graph and fails if any dependency is `undefined`. Do
  not reintroduce `if (this.x)` as a substitute for wiring.
- **NEVER** run migrations in the request path — they live in `server/scripts/migrate.ts` and run from CD before the
  Worker deploy (additive + idempotent, so safe against the still-running old Worker).
- Body validation: `zValidator('json', Schema)` + `c.req.valid('json')`. No hand-written body types.
- **Path parameters are validated by middleware, not per handler**: mount `router.use('*', pathParamValidation())` once
  per route factory and add every new `:param` to `validators/path-params.ts`.
  `routes/param-validation.guardrail.test.ts` fails the build if either half is missed.
- JWT: only `hono/jwt` (`sign`/`verify`). No custom crypto.
- Authorization: coarse checks in `middleware/rbac.ts`, fine-grained via `ensurePermission()` from
  `services/rbac.service.ts`. No ad-hoc role string comparisons.
- **Tenant seam (hard invariant, full text in [`docs/architecture.md`](docs/architecture.md) §2.5):** every
  project-scoped service method takes a **required** `CallerContext` (`{ tenantId, userId, userRole }` from the route's
  `callerContext(c)`), calls `requireCallerContext()`, and resolves the project through
  `assertProjectInTenant()`/`assertTenantEntity()` from `services/tenant-assert.ts` before touching it. Never authorize
  from a path/body value, and a cross-tenant id yields **404, not 403**. Adding a tenant-scoped route means adding a
  `ROUTE_TABLE` row in `server/src/tenant-isolation.test.ts`.
- New repositories extend `BaseRepository` (`repositories/base.repository.ts`).
- Response envelope: `{ data }` on success, `{ error: { code, message, details? } }` on failure — no hand-rolled error
  bodies (`routes/error-envelope.guardrail.test.ts`).
- Query bounds are part of the contract: `page` ≤ 500 (`MAX_TASK_PAGE`), task `limit` ≤ 200, `search` 2–100 chars
  (`TASK_SEARCH_MIN_LENGTH`/`TASK_SEARCH_MAX_LENGTH`), `sort` from a closed allow-list, `hasSprint` tri-state and
  mutually exclusive with `sprintId`.
- Error/observability mapping, one place each: `maxTimeMS` expiry → `503 QUERY_TIMEOUT`; `E11000` → `409` translated by
  the issuing service (`db/duplicate-key.ts`); every `429` carries `Retry-After` + `RateLimit-*`
  (`utils/rate-limiter.ts`); every response carries `Server-Timings` (`utils/timings.ts`).

### UI

- Reads: `rxResource`/`httpResource` over a `*-client.ts` service, `hasValue()`-guarded computed reads, `defaultValue`
  set. Never read `.value()` of an errored resource unguarded (it throws).
- Query params: bound automatically to `input()` (`withComponentInputBinding`), no manual `queryParams.subscribe`.
- Shared per-project reference data (statuses/types/sprints/labels/members): `ProjectRefStore` (`ensure()` /
  `invalidate()`), never re-fetched locally.
- Writes: explicit `.subscribe({ next, error })` with toast on error (`injectToasts()` + `getErrorMessage`);
  mutation-heavy managers may keep manual loading signals. The global `errorInterceptor` owns 5xx and network failures:
  no second toast, no suppression. 4xx stays with the caller.
- Stores: plain `@Service()` classes with signals; no NgRx.
- Forms: Signal Forms (`form()`/`schema()` from `@angular/forms/signals`).
- Rich text: `ui-milkdown-editor` (WYSIWYG ⇄ raw markdown toggle built in); value is always markdown.
- UI kit: Spartan Helm components only; do not hand-roll buttons/dialogs/selects/etc.

### Both

- Naming: no type suffixes (`auth-client.ts`, class `AuthClient`; stores keep `-store`, guards/interceptors/pipes keep
  theirs). Components in own folders with separate `.html`.
- Use `@Service()` + `inject()`, never constructor injection.
- **A comment carries the reason, not a pointer to a report.** Never cite a one-off or disposable document — an audit
  finding id (`D-18`, `N-2`), a scratch file, a decision-table item. The document is deleted and the citation becomes a
  lie the reader cannot follow. State the reason in the comment itself ("the purge re-reads before acting because a
  filter-delete is not atomic across collections"), or point at a **durable** location that ships with the code
  (`docs/architecture.md`, a source file, a specification). If dropping the citation leaves nothing, delete the comment.

## Testing notes

- **Server tests** mock repos/services with `vi.mock`; route tests inject a fake `svc` via middleware — see any
  `routes/*.test.ts` `createTestApp()`.
- **UI tests are zoneless (Angular 22): `fixture.detectChanges()` is an ANTI-PATTERN — never use it.** It forces CD
  off-schedule and races the zoneless scheduler (intermittent "click didn't emit" / "translated text is empty" flakes).
  Canonical pattern (see `ui/src/app/shared/testing/zoneless.ts` and any migrated spec):
  1. In setup: `TranslocoTestingModule.forRoot({ ..., preloadLangs: true })`, then
     `await firstValueFrom(TestBed.inject(TranslocoService).load('en'))` (warms the cache before first render).
  2. After `createComponent` / `setInput` / simulated events: `await settle(fixture)` (helper = `whenStable()` +
     `TestBed.tick()`, bounded at 250 ms — some specs intentionally keep pending work).
  3. For native `.click()` on Angular-bound elements use `await clickUntil(() => el.click(), () => expect(effect))` —
     the listener attachment itself is racy, so retry the interaction until the effect is observed.
  4. Never select elements by translated text; use structural selectors (CSS/attributes/element order).
  5. Install `vi.useFakeTimers()` only AFTER setup/settle; `ui/test-setup.ts` resets to real timers after every test.
- **`@angular/build`**: the `budgets` in `ui/angular.json` only measure something if the build summary reports the true
  initial bundle size, so verify the reported figure after any bump instead of trusting the summary table.
- UI resource-based components resolve asynchronously: poll the signal state
  (`for (… && !component.task()) await setTimeout(10)`) instead of fixed timeouts.
- **E2E is a real CI gate**: the `e2e` job in `.github/workflows/ci.yml` provides a `mongo:7` service container
  (published `27017:27017`, mongosh-ping health check it waits for) and sets `E2E_MONGODB_URI`; the suite boots its own
  API and UI, so nothing needs to be pre-started. Output (HTML report, traces) goes to the gitignored scratch home at
  the repo root. Do NOT run it after every iteration (below).

### Guardrails — tests that fail the build by design

Not coverage: each one holds an invariant a reviewer cannot keep in their head, asserted against sources or the full
route table. Adding a route/component without its guardrail row/coverage is the defect they exist to catch.

- `server/src/tenant-isolation.test.ts` — every id-bearing tenant-scoped route in `ROUTE_TABLE` (two-tenant world:
  cross-tenant = 401/403/404, no data leak, no audit write; the same request in the caller's own tenant still passes).
- `server/src/container.test.ts` — the real service graph has no `undefined` dependency.
- `server/src/routes/param-validation.guardrail.test.ts` — every route factory mounts `pathParamValidation()` and every
  `:param` has a schema.
- `server/src/routes/error-envelope.guardrail.test.ts` — no hand-rolled error body in a route.
- `server/src/schemas/sort-field.guardrail.test.ts` — no permissive (arbitrary-field) `sort` regex.
- `server/src/schemas/shared-parity.test.ts` — shared unions ⇄ Zod schemas stay in step.
- `ui/src/app/shared/testing/reactive-fetch.guardrail.spec.ts` — no hand-rolled fetch in an `effect()`, no `rxResource`
  streaming with blank params.
- `ui/src/app/shared/testing/icon-button-names.spec.ts` — no icon-only button without an accessible name (a tooltip is
  `aria-describedby`, never a name).
- `ui/src/app/document-structure.spec.ts` — every page route declares a `title` (checked against `en.json`); every page
  template has exactly one `<h1>`.
- `ui/scripts/check-i18n.mjs` (`npm run check:i18n --workspace=ui`, run in CI) — keys used in `ui/src` exist in
  `en.json`, and every `en.json` key exists in all other locales. Unused keys are reported, non-blocking.

### TypeScript strictness (intended — do not "improve")

`tsconfig.base.json` is the single source. Intended ON: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` (`{ x?: T }` may not be assigned `undefined` explicitly), `noImplicitOverride`,
`noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `isolatedModules`.
**Deliberately OFF: `noPropertyAccessFromIndexSignature`** — it was measured at a large error count against the current
code, so it is a do-not-do, not a pending improvement. Re-measure before proposing it.

- **Deploy (CD):** the UI is deployed with an explicit path from the repo root —
  `npx wrangler pages deploy ui/dist/ui/browser`. NEVER pass a bare `.`/`./` with `working-directory` set: npm exec
  rewrites the positional to the npm project root (`ui/`), uploading the whole source tree instead of the build output
  (this caused a full production outage). The UI calls the Workers API directly (`API_URL` GitHub variable injected into
  `environment.prod.ts` at build time) — there is no Pages Functions proxy. A smoke-check step fails CD unless the fresh
  deployment serves `GET /` → 200.
- **When the user points to a reference project, inspect its FULL configuration** — including `.github/workflows/*`, not
  just the files matching the current symptom. The fix is often already sitting in a file the symptom does not point at.
- **E2E/Playwright policy**: do NOT run Playwright/e2e after every iteration (too slow). When e2e or live-browser
  verification is needed, the ORCHESTRATING agent must delegate it to a subagent — never run it in the main agent's
  context (it bloats context with screenshots/snapshots). Unit tests (`npm test`) are fine to run directly.

## Performance forensics

- **Do not set a non-default `connectTimeoutMS` — leave the driver default alone.** The old explanation for that rule is
  withdrawn: it is **false for the installed driver**, which applies the knob only while a connection is being
  established and clears it in the `finally`, so it cannot affect an already-established pooled connection.
  `maxIdleTimeMS: 30_000` stays, uncredited.
- The **periodic latency spikes that motivated the removed knob are still unexplained** — it removed a knob that could
  not have caused them. Two further findings stay **unexplained**, so do not read any later change as fixing them: a
  pre-DB stall of 140-320 ms before the first Mongo checkout, and a rare post-deploy transient hang of 75-90 s.
- The withdrawn narrative is `product-analysis/100-performance-optimizations.md` §2.7. Diagnostics (keep-alive series,
  curl timing): `tools/README.md` — attributing time inside the Worker needs the request path instrumented first.

## Where to dig deeper

- [`docs/architecture.md`](docs/architecture.md) — layers, request lifecycle, DI, RBAC matrix, data model summary,
  design decisions (must/must-not with rationale).
