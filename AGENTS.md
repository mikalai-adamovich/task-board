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

| Layer      | Tech                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| UI         | Angular 22 (zoneless, OnPush default, Signal Forms)                      |
| UI kit     | Spartan UI (`@spartan-ng/brain` headless + `helm` styled)                |
| Styling    | Tailwind v4 (`tailwindcss`, `@tailwindcss/postcss`, `tailwind-merge`)    |
| i18n       | Transloco — 11 locales in `ui/public/assets/i18n/`                       |
| Rich text  | Milkdown (`ui-milkdown-editor`)                                          |
| Server     | Hono on Cloudflare Workers (`nodejs_compat`)                             |
| DB         | MongoDB driver 7, **new MongoClient per request**                        |
| Validation | Zod v4 via `@hono/zod-validator`                                         |
| Auth       | JWT HS256 (`hono/jwt`), bcryptjs password hashing                        |
| Email      | Resend; **falls back to the console logger without `RESEND_API_KEY`**    |
| Tests      | Vitest (server + ui unit) · Playwright (e2e, `ui/e2e/`, not in the gate) |

Shared types/constants live in `shared/` (`@task-board/shared`) — runtime-library-free, single source of truth for
server and UI.

## Commands

```bash
npm run check:fast       # lint + typechecks (shared, server, UI)           ~20 s
npm run check            # CANONICAL GATE: check:fast + both test suites   ~45-90 s
npm run check:full       # check + all three builds                       ~60-120 s
npm run build            # shared → server → ui
npm run typecheck        # shared + server ONLY — no UI; use check/check:fast, never this alone
npm test                 # vitest: run both server and ui suites
npm run lint             # eslint across repo
npm run harness -- list  # NOT everyday work — the measurement layer; `--help` screens it, .harness/README.md is the manual
npm run dev --workspace=server   # wrangler dev (needs MONGODB_URI/JWT_SECRET in server/.dev.vars, gitignored)
npm start --workspace=ui         # ng serve
npm run test:e2e                 # playwright (not part of the gate — needs a live stack)
```

### Canonical verification gates

`npm run check` is the application project gate. It deliberately includes the **UI typecheck**, which
`npm run typecheck` alone does not cover — a change that breaks Angular compilation must never be called green.

| Work changed                   | Run                     | Coverage and scope                                                    |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------- |
| `server/`, `ui/`, or `shared/` | `npm run check`         | Application project gate: lint, typecheck, and server/UI tests.       |
| `.harness/` or `.roomodes`     | `npm run check:harness` | Agent-harness gate: harness self-test and frozen compatibility check. |
| Harness in CI/CD               | No harness gate         | Deliberately excluded: the harness has no effect on production.       |

Running the project gate during harness-only work, or the harness gate during project-only work, is wasted time: each
gate covers its own side.

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

`npm run check:harness` is the agent-harness gate; read the numbers off the run instead of trusting a remembered
literal: currently **491 self-test assertions across 40 invariant groups** and **224 compatibility cases** — a stale
literal here fails the gate rather than misleading a reader. Its two commands are in the manual.

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
directory is gitignored and excluded from ESLint and Prettier, so a file left there costs nothing. A `.md` or `.ts`
dropped in `ui/` or the repository root is parsed by `npm run lint` and by the pre-commit hook on every run, which is
how a scratch file becomes a multi-minute stall. Scratch is disposable: delete it when the task ends.

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

- **NEVER** access `getCollection()` inline in a route handler; go through a service.
- **NEVER** cache services/repositories/collections at module level; only the `MongoClient` is cached per isolate
  (singleton experiment, `db/mongo.ts`, rollback via `DB_CLIENT_MODE=per-request`); the service graph stays
  request-scoped: `container.ts` + `provideServices` middleware (`c.get('svc')`).
- **NEVER** run migrations in the request path — they live in `server/scripts/migrate.ts` and run from CD before the
  Worker deploy (additive + idempotent, so safe against the old Worker still running).
- Body validation: `zValidator('json', Schema)` + `c.req.valid('json')`; no hand-written body types.
- JWT: only `hono/jwt` (`sign`/`verify`); no custom crypto.
- Authorization: coarse checks in `middleware/rbac.ts`, fine-grained via `ensurePermission()` from
  `services/rbac.service.ts`. Never compare role strings ad hoc.
- New repositories extend `BaseRepository` (`repositories/base.repository.ts`).
- Response envelope: `{ data }` on success, `{ error: { code, message, details? } }` on failure.

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

## Testing notes

- **Server tests** mock repos/services with `vi.mock`; route tests inject a fake `svc` via middleware — see any
  `routes/*.test.ts` `createTestApp()`.
- **UI tests are zoneless (Angular 22): `fixture.detectChanges()` is an ANTI-PATTERN — never use it.** It forces CD
  off-schedule and races the zoneless scheduler (intermittent "click didn't emit" / "translated text is empty" flakes).
  Use `await settle(fixture)` after `createComponent` / `setInput` / simulated events, and `await clickUntil(...)` for
  native `.click()` on Angular-bound elements, because the listener attachment itself is racy. The canonical four-step
  pattern is in [`docs/architecture.md`](docs/architecture.md) §6 and `ui/src/app/shared/testing/zoneless.ts`.
- **Never select elements by translated text** — use structural selectors (CSS/attributes/element order).
- Install `vi.useFakeTimers()` only AFTER setup/settle; `ui/test-setup.ts` resets to real timers after each test.
- Resource-based components resolve asynchronously: poll the signal state instead of using fixed timeouts.
- **`@angular/build` is pinned to 22.1.2 on purpose** (`ui/package.json`): ≥22.1.3 forces `disableCodeSplitting`, which
  can kill esbuild on 2-CPU CI runners, and ships unit-test builder regressions — once-per-worker TestBed init bleed
  across spec files with `isolate: false` (angular/angular-cli#33047), and an undefined shared-chunk export during
  class-field initialisation (#33728). Unpin only after upstream fixes land and re-validate with a full-suite loop.
  `isolate: true` in `ui/angular.json` is a second line of defense.
- **When the user points at a reference project, inspect its FULL configuration** — including `.github/workflows/*`, not
  just files matching the current symptom.
- **Deploy (CD): the UI is deployed with an explicit path — `npx wrangler pages deploy ui/dist/ui/browser`.** NEVER pass
  a bare `.`/`./` with `working-directory` set: npm exec rewrites the positional to the npm project root (`ui/`),
  uploading the whole source tree instead of the build output. There is **no Pages Functions proxy**, and a smoke-check
  step fails CD unless the fresh deployment serves `GET /` → 200. CD then rewrites the API base URL in place with `sed`
  against `ui/src/environments/environment.prod.ts`, whose placeholder must stay the literal `apiBaseUrl: '/api'`.

## Performance forensics

- **Gotcha (mongodb driver 7.6.0): `connectTimeoutMS` is applied as `socket.setTimeout()`** — a connection IDLE timeout,
  not just a connect timeout. Never set a non-default value: it kills idle connections and buys a periodic reconnect
  spike.
- Findings and techniques, plus the known **unresolved** findings — the pre-DB stall and the post-deploy transient hang,
  neither of whose causes is established
  ([`product-analysis/100-performance-optimizations.md`](product-analysis/100-performance-optimizations.md) §4.1, §4.2).
- Diagnostic scripts (keep-alive series, `wrangler tail` DBEV parser, curl timing): `tools/README.md`.
