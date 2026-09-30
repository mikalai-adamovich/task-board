# Architecture — Task Board

> Consolidated architecture reference (post-refactoring state). Entry point: [`AGENTS.md`](../AGENTS.md).

## 1. Monorepo layout

| Workspace | Purpose                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `shared/` | `@task-board/shared` — types, const enums (`valuesOf`), constants. Runtime-library-free; single source of truth for server + UI |
| `server/` | Hono API on Cloudflare Workers (`nodejs_compat`)                                                                                |
| `ui/`     | Angular 22 SPA (zoneless), Spartan UI + Tailwind v4, Transloco i18n                                                             |

Package boundaries: `server` and `ui` import only from `@task-board/shared`, never from each other. Shared stays
runtime-library-free (no Zod/Angular/Hono imports).

## 2. Server architecture

### 2.1 Request lifecycle (order matters)

```
logger → CORS (memoized per config) → [MongoClient per DB_CLIENT_MODE: `durable` in production (app + persistent
pool inside the Durable Object), `per-request` as the rollback, `singleton` the known-broken plain-Worker
experiment] via runWithDb(AsyncLocalStorage)
→ provideServices (builds service graph into c.set('svc')) → onError(errorHandler)
→ /api/auth (no tenant ctx) → authMiddleware (hono/jwt verify) → /api/tenants, invitations,
preferences, tasks/my (auth only) → tenantScoped sub-app: tenantContextMiddleware → RBAC → routes
```

### 2.2 DI composition root

- [`container.ts`](../server/src/container.ts) — pure `buildServices(env)` constructing the full repository/service
  graph **once per request**.
- [`middleware/services.ts`](../server/src/middleware/services.ts) — `provideServices` middleware exposes it as typed
  `c.get('svc')` (Hono `Variables`).
- **Must NOT memoize at module level**: repositories capture `Collection` objects bound to the client owned by
  `db/mongo.ts`; only the service graph is request-scoped. The client lifecycle is selected by `DB_CLIENT_MODE`:
  `durable` (production — the whole app plus a persistent pool run inside `do/mongo-do.ts`, because a DO owns an
  I/O context that outlives individual requests), `per-request` (the proven rollback: a fresh client closed after
  the response), `singleton` (module-cached client in a plain Worker isolate — known broken, workerd#2721).
- **Migrations are NOT in the request path**: `server/scripts/migrate.ts` runs the same `runMigrations()` from CD before
  the Worker deploy (additive + idempotent, safe against the still-running old Worker).
- Services declare narrow constructor interfaces for cross-aggregate deps (e.g. `TaskServiceUserRepo`) — keeps them
  unit-testable without casts.
- **Container wiring is a guardrail, not a convention.** The cross-aggregate dependencies of `ProjectService` and
  `TenantService` (cascade repos, `AuditService`, member repos) are **required** constructor parameters — no `?`. Two
  independent mechanisms keep them wired: dropping an argument is a `tsc` error, and
  [`container.test.ts`](../server/src/container.test.ts) builds the real graph (only `getCollection` is mocked) and fails
  if any service holds an `undefined` dependency. The `if (this.x)` guards that made the previous omission silent must
  not be reintroduced as the substitute for wiring.

### 2.3 Layers

```
routes/ (thin HTTP handlers: validate → svc call → envelope)
services/ (business logic, authorization via rbac, audit side effects)
repositories/ (Mongo queries; extend BaseRepository<TDoc, TDomain>)
schemas/ (Zod v4 request schemas; uuid/nonEmptyString validators in validators/)
middleware/ (auth, tenant-context, rbac, validation wrapper, services, error-handler)
errors/app-error.ts (AppError hierarchy; codes typed by shared ErrorCode)
```

### 2.4 Validation & error model

- Bodies: `zValidator('json', Schema)` → `c.req.valid('json')` is fully typed. Failure → `ValidationError` →
  `400 { error: { code: 'VALIDATION_ERROR', details } }`. Malformed JSON is normalized to the same contract in
  `error-handler.ts`.
- **Path parameters are validated by middleware, not per handler.** Every route factory mounts
  `router.use('*', pathParamValidation())` ([`middleware/validation.ts`](../server/src/middleware/validation.ts)),
  driven by the per-name schema registry in `validators/path-params.ts`. Handlers read `param(c, 'x')` and trust it.
  Adding a `:param` without a registry entry, or a factory that forgets the `use(...)` line, fails the build via
  `routes/param-validation.guardrail.test.ts` (source-scanning) — not review.
- **Query bounds are part of the contract, not tuning:** `page` is capped at `MAX_TASK_PAGE` = 500 (tasks + audit) so
  `skip` cannot grow without bound; task `limit` ≤ 200 (the board view needs the project's full list in one request);
  free-text `search` is bounded to 2–100 characters (`TASK_SEARCH_MIN_LENGTH` / `TASK_SEARCH_MAX_LENGTH` in
  `@task-board/shared`) because it compiles to an `$or` of five regexes that no B-tree can serve; `sort` is a closed
  allow-list; `hasSprint` is a tri-state boolean (absent = no sprint filtering, `false` = backlog, `true` = in a
  sprint) and is mutually exclusive with `sprintId`; `excludeDescription` and `view=board` trim the list payload.
- **Error mapping lives in one place each:** `maxTimeMS` expiry → `503 QUERY_TIMEOUT` (`db/query-timeout.ts` budgets:
  5 s list/search/audit, 2 s board pages); a unique-index violation `E11000` → `409`, translated by
  [`db/duplicate-key.ts`](../server/src/db/duplicate-key.ts) into the answer the **issuing service** supplies (a
  duplicate filter name and a duplicate user email are both 409, a counter race is not); every `429` carries
  `Retry-After` + `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` built in `utils/rate-limiter.ts`; every
  response carries a `Server-Timings` header (`utils/timings.ts`).
- Envelope: `{ data }` on success; `{ error: { code, message, details? } }` on failure. Nothing else is ever returned
  for a 4xx/5xx — `routes/error-envelope.guardrail.test.ts` fails the build on a hand-rolled `c.json({ message })` or
  `c.text(...)` in a route.
- Codes: `ErrorCode` union in `shared/types/common.ts` (single source of truth).

### 2.5 AuthN / AuthZ

- JWT HS256 via `hono/jwt` (`sign` in AuthService, `verify` in authMiddleware). Claims:
  `sub, email, displayName, tenantId, tenantRole, exp` (24 h). Invitation tokens stored as WebCrypto SHA-256 hashes.
- Coarse checks: `middleware/rbac.ts` (`requireRole`, `requirePermission`) on route groups.
- Fine-grained: `ensurePermission(action, tenantRole, projectRole)` from `rbac.service.ts` inside domain services.
  Permission matrices live only there.
- **The tenant-assertion seam is a hard invariant — every project-scoped method goes through it**
  ([`services/tenant-assert.ts`](../server/src/services/tenant-assert.ts)):
  - **MUST:** the method signature takes a **required** `CallerContext` (`{ tenantId, userId, userRole }`, built in
    the route from `c.get(...)` via a local `callerContext(c)` helper). Omitting it is a compile error; the previous
    signatures (`userId?`, `userRole?`) skipped the permission check when a call site forgot to forward the context,
    i.e. authorization failed **open**.
  - **MUST:** call `requireCallerContext(context)` first — it throws `UnauthorizedError` (401) instead of returning
    silently.
  - **MUST:** resolve the addressed project with `assertProjectInTenant(projectRepo, projectId, tenantId, label)`
    (or `assertTenantEntity(...)` for entities that carry only `projectId`) before touching it, and reuse the returned
    project for audit logging instead of issuing a second lookup.
  - **MUST NOT:** authorize from a path/body/param value, and **MUST NOT** treat a cross-tenant hit as `403` — a
    foreign id yields **404, not 403**, so the response cannot be used to probe for the existence of another tenant's
    resource. A missing project repository is "cannot prove ownership" and also yields 404 (fail closed).
  - Enforcement: `server/src/tenant-isolation.test.ts` drives the real `app.ts` chain (auth → tenant context → RBAC →
  Zod → the real route modules) over a seeded **two-tenant** world, asserting for every row of its `ROUTE_TABLE` that a
    cross-tenant request is rejected (401/403/404), never echoes tenant B's data, never reaches the audit repository —
  and that the same request inside the caller's own tenant still succeeds, so the suite cannot be satisfied by a
    service that rejects everything. **Adding a tenant-scoped route means adding a `ROUTE_TABLE` row**; the table is
    the conscious decision point.

### 2.6 Route mounting

Full paths are defined in route modules (e.g. `/tasks/:taskId`), so modules mount at `/` of the tenant-scoped sub-app to
avoid double nesting. Cross-tenant routes (`/api/tasks/my`, `/api/invitations`, `/api/preferences`) mount outside the
tenant sub-app.

## 3. Data model (summary)

Entities: User, Tenant, TenantMember (with embedded invitation), Project, ProjectMember, Task (KEY-NUMBER business id
via counters; identity snapshots for reporter/assignee), Status, TaskType, Board (+columns), Sprint, Label, Comment,
TaskRelationship, Filter, AuditEvent, Counter, UserPreferences (project-scoped) + UserSettings (global:
zoom/theme/language/pageSize).

- IDs: UUID v4 (`randomUUID`); tasks additionally carry `projectId + number` (e.g. `PROJ-42`), resolvable by either UUID
  or `KEY-NUMBER`.
- Optimistic concurrency: tasks carry `version`; updates require matching version → `409 TASK_VERSION_CONFLICT`.
- Soft delete: users (`deletedAt`), tenants/projects (status + `deletionScheduledAt`, archive/restore lifecycle).
  Cascades handled in services (not DB-level).
- Indexes are documented at the top of each repository file.

### 3.1 Persistence & transactions (DEC-025)

- **Replica set required:** MongoDB must run as a replica set in every environment — local dev uses the root
  [`docker-compose.yml`](../docker-compose.yml) (`mongod --replSet rs0` + `rs.initiate()` healthcheck), production uses
  Atlas Free (replica set out of the box). Multi-document transactions behave identically everywhere.
- **Atomic project seed:** `ProjectService.createProject` wraps project insert + statuses + task types +
  default board + creator membership + default-reference updates in a transaction via
  [`withTransaction()`](../server/src/db/mongo.ts) on the request-scoped client. Abort ⇒ nothing visible.
- **Fallback:** if the topology does not support transactions (standalone `mongod`), the service logs a warning and
  falls back to ordered inserts with compensating cleanup so local dev without Docker compose still works. The fallback
  is not the primary mechanism and leaves a small visibility window during cleanup.

## 4. RBAC

Tenant roles: `OWNER > ADMIN > MEMBER` (+ invited pending). Project roles: `PROJECT_ADMIN > EDITOR > VIEWER`. Tenant
Owner/Admin bypass project-level restrictions. Permission matrices (action → roles) live only in
[`rbac.service.ts`](../server/src/services/rbac.service.ts); route groups use
`requireRole(...)`/`requirePermission('create_project')`.

## 5. UI architecture

### 5.1 Bootstrap & routing

Zoneless, standalone components, `withComponentInputBinding()` — route **and query** params bind to `input()` signals
automatically. Lazy `loadComponent` everywhere. Route tree: `auth/*` (public) → root dashboard (resolves all auth
states) → `tenants/:tenantId` shell (authGuard + tenantGuard) → project subtree (projectGuard) with
boards/tasks/sprints/members/settings/audit.

### 5.2 State & data layer

| Concern         | Pattern                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session/context | Plain `@Service()` signal stores: `AuthStore`, `TenantStore`, `ProjectStore`, `PreferencesStore`                                                   |
| Reads           | `rxResource` over a `*-client.ts` service; reactive `params`; `hasValue()`-guarded computed reads; `defaultValue` set                              |
| Query params    | Bound to `input()`; filters kept as one record signal; URL synced via `router.navigate([], { queryParamsHandling: 'merge' })`                      |
| Shared ref data | `ProjectRefStore`: `ensure(projectId, kinds)` / `invalidate(projectId, kind)` / `nameOf()` — statuses, types, sprints, labels, members             |
| Writes          | Explicit `.subscribe({ next, error })`; errors via `getErrorMessage(err)` + toast (`injectToasts()`); update resource value in place or `reload()` |
| Forms           | Signal Forms (`form()`, `schema()`, `formField`)                                                                                                   |
| Rich text       | `ui-milkdown-editor`: Milkdown WYSIWYG + toolbar (`callCommand`) ⇄ raw markdown toggle; value is always markdown                                   |

**Error-state rule:** reading `.value` of an errored resource throws even with `defaultValue` — always guard with
`hasValue()` before reading/updating.

### 5.3 Conventions

- Naming: no type suffixes (`auth-client.ts` / class `AuthClient`; stores keep `-store`; guards/interceptors/pipes keep
  theirs). Components in own folders, separate `.html`.
- Selectors: `ui-*` prefix. Feature folders under `features/<domain>/`.
- `@Service()` decorator + `inject()`; never constructor injection.
- Native control flow (`@if/@for/@switch`), `[class]/[style]` bindings, no `*ngIf`/`ngClass`.
- Spartan Helm components for all standard UI elements.

## 6. Testing

- **Server:** Vitest. Service tests mock repos via constructor; route tests mock service classes with `vi.mock` and
  inject a fake `svc` through middleware in `createTestApp()` (see any `routes/*.test.ts`).
- **UI:** Vitest via `ng test`, zoneless. `fixture.detectChanges()` is an anti-pattern — it forces CD off-schedule and
  races the zoneless scheduler (intermittent "click didn't emit" / "translated text is empty" flakes; validated by
  instrumented full-suite loops). Canonical pattern: `TranslocoTestingModule.forRoot({ ..., preloadLangs: true })` +
  explicit `TranslocoService.load('en')` in setup; `await settle(fixture)` (`whenStable()` + `TestBed.tick()`, bounded)
  after create/setInput/events; `await clickUntil(() => el.click(), () => expect(effect))` for native clicks on
  Angular-bound elements (listener attachment is itself racy); structural selectors, never translated text. Helpers in
  `ui/src/app/shared/testing/zoneless.ts`; rationale and rules in `AGENTS.md` §Testing notes.
- **UI test isolation:** the builder's default `isolate: false` + once-per-worker TestBed init bleed state across spec
  files (angular/angular-cli#33047) — `isolate: true` is set in `ui/angular.json` and must stay set on any version.
  The `budgets` in `ui/angular.json` likewise only measure something if the build summary reports the true initial
  bundle size: some `@angular/build` versions under-report it, so verify the reported figure after any bump.
- Resource-based components resolve asynchronously — poll signal state
  (`for (i < N && !component.task()) await setTimeout(10)`) instead of fixed timeouts.
- **E2E:** Playwright specs in `ui/e2e/`. **The suite boots its own stack** —
  [`ui/playwright.config.ts`](../ui/playwright.config.ts) declares two `webServer` entries (`wrangler dev` on 8787,
  `ng serve` on 4200), generates its own throwaway `JWT_SECRET` per run (never persisted, never a production
  credential), rebuilds `@task-board/shared` and clears `ui/.angular/cache` before serving, and reads
  `E2E_MONGODB_URI` → `MONGODB_URI` → a **dedicated** localhost database (`taskboard_e2e`), never a developer's own
  data. `npx playwright test` therefore needs nothing pre-started, and because the API is fresh per run the in-memory
  register limiter (20 sign-ups per client id per hour) cannot make the suite non-re-runnable. Generated output
  (HTML report, traces) is redirected to the gitignored scratch home at the repo root — it is a bundle, not source. The
  `e2e` job in `.github/workflows/ci.yml` is a **blocking gate**: it provides a `mongo` service container (`mongo:7`,
  published `27017:27017`, mongosh-ping health check the job waits for) and sets `E2E_MONGODB_URI` to a dedicated
  database on that port.

### 6.1 Guardrails (tests that fail the build by design)

Not ordinary coverage: each one holds an invariant a reviewer cannot reliably keep in their head, and each asserts
against sources or the full route table rather than one rendered instance.

| Spec                                                         | Invariant it holds                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/tenant-isolation.test.ts`                        | Every id-bearing tenant-scoped route has a `ROUTE_TABLE` row; cross-tenant requests are rejected (401/403/404), leak no data, never reach the audit repo. Seeded two-tenant world |
| `server/src/container.test.ts`                                | The real service graph holds no `undefined` dependency (project/tenant cascades, audit)                                          |
| `server/src/routes/param-validation.guardrail.test.ts`       | Every route factory mounts `pathParamValidation()`, and every declared `:param` has a schema in `validators/path-params.ts`       |
| `server/src/routes/error-envelope.guardrail.test.ts`         | No route hand-rolls an error body; every 4xx/5xx is `{ error: { code, message } }`                                              |
| `server/src/schemas/sort-field.guardrail.test.ts`            | No permissive `sort` regex can return (arbitrary-field sort = guaranteed COLLSCAN / DoS vector)                                  |
| `server/src/schemas/shared-parity.test.ts`                   | The shared TypeScript unions and the Zod schemas that validate requests stay in step                                            |
| `ui/src/app/shared/testing/reactive-fetch.guardrail.spec.ts` | No hand-rolled fetch inside `effect()`, and no `rxResource` streams with blank params (the `/projects//tasks` failure class)      |
| `ui/src/app/shared/testing/icon-button-names.spec.ts`         | No icon-only button without an accessible name (a tooltip is `aria-describedby`, never a name)                                  |
| `ui/src/app/document-structure.spec.ts`                      | Every page route declares a `title` (checked against the real `en.json`) and every page template has exactly one `<h1>`          |
| `ui/scripts/check-i18n.mjs` (`npm run check:i18n --workspace=ui`, in CI) | Every key referenced from `ui/src` exists in `en.json`, and every `en.json` key exists in all other locales. Unused keys: reported, non-blocking |

## 7. Design decisions (must / must-not, with rationale)

| Decision                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request-scoped service graph; client mode chosen by `DB_CLIENT_MODE` | Services/repositories capture `Collection`s, so they must not outlive a request; the `MongoClient` itself cannot be module-cached in a plain Worker (workerd#2721), which is why it lives in a Durable Object in production and falls back to per-request on demand                                                                                                                                                                                                                                 |
| `@hono/zod-validator` instead of custom middleware           | Fully typed bodies, zero hand-written duplicates; custom variant hid schema/type drift                                                                                                                                                                                                                                                                                                                                                              |
| `hono/jwt` instead of hand-rolled HMAC                       | Custom crypto missed `alg` validation (alg-confusion surface); battle-tested helpers delete ~80 lines                                                                                                                                                                                                                                                                                                                                               |
| `rxResource` over clients for reads                          | Auto refetch/cancel on reactive params; replaces loader + loading/error signals + subscriptions                                                                                                                                                                                                                                                                                                                                                     |
| Human-readable filter names stay in URLs                     | Deep-link readability; resolution is pure `computed()` over loaded options — no polling                                                                                                                                                                                                                                                                                                                                                             |
| IDs (not names) for task routes                              | Stable `KEY-NUMBER` format survives renames                                                                                                                                                                                                                                                                                                                                                                                                         |
| Plain signal stores, no NgRx SignalStore                     | Global state is four small context stores; native-first, revisit only if undo/DevTools-history triggers appear                                                                                                                                                                                                                                                                                                                                      |
| `ProjectRefStore` instead of per-component fetches           | Removes N+1 requests (task-detail fired up to 9) and duplicated id⇄name mapping in 6+ components                                                                                                                                                                                                                                                                                                                                                    |
| Bulk reorder endpoints (statuses/task-types)                 | Two sequential PATCHes could leave positions inconsistent on partial failure                                                                                                                                                                                                                                                                                                                                                                        |
| bcryptjs (pure JS) on Workers                                | Native bcrypt cannot compile for Workers; watch CPU time, PBKDF2/WebCrypto is the fallback                                                                                                                                                                                                                                                                                                                                                          |
| Durable Object owns the app + client (singleton experiment failed) | A module-cached `MongoClient` in a plain Worker reproduced workerd#2721: pool sockets are bound to the request context that created them — the next request hangs and the runtime kills it with error 1101 (register 201 → login 500). A DO has its own I/O context, so `DB_CLIENT_MODE=durable` (deployed by cd.yml) puts the Hono app and a persistent pool inside one; `DB_CLIENT_MODE=per-request` remains the rollback. `/api/health` and `/api/ping` always stay on the Worker so liveness never depends on the DO |
| One DO instance (`idFromName('mongo')`) is a SECURITY parameter, not only a performance one | The per-user rate limiter's counters are in-process (`utils/rate-limiter.ts`), so the abuse ceiling is `AUTH_MAX_REQUESTS × instances`. One instance today; a cached per-user `idFromString`, or the `per-request` rollback (one budget per isolate), multiplies it silently. A mode-aware counter is the audit's Q4 and is not implemented — so the DO identity must not be changed as a performance refactor |
| Explicit Frankfurt placement (`region = "aws:eu-central-1"`) | A/B 2026-08-31 (per-request client in both branches, only placement varied): smart → `cf-placement: local-WAW` on every request (INSUFFICIENT_INVOCATIONS with single-user traffic), Mongo connect 274-404ms, tenants warm 396-879ms; `aws:eu-central-1` → `remote-FRA` on every request, Mongo connect 86-149ms, tenants warm 201-284ms. Explicit AWS eu-central-1 placement is preferred for the current MongoDB Atlas deployment in eu-central-1 |
| Migrations run from CD, never in the request path            | `server/scripts/migrate.ts` (same `runMigrations()`) executes before the Worker deploy; additive + idempotent, safe against the still-running old Worker; removes 0.5-1.5s from cold isolates                                                                                                                                                                                                                                                       |
| Required `CallerContext` + `assertProjectInTenant` (tenant seam) | The old `userId?`/`userRole?` signatures skipped authorization whenever a call site forgot to forward the context — authz failed **open**. Required context = compile error; `assertProjectInTenant` = 404, never 403, so a foreign id is indistinguishable from a nonexistent one |
| Path-parameter validation as middleware + source guardrail    | Unvalidated path parameters reached Mongo directly. Per-handler parsing does not scale and a missing `use(...)` is invisible in review; the registry covers all names and the guardrail test turns an omission into a build failure |
| Bounded query params (page ≤ 500, limit ≤ 200, search 2–100)  | `skip` pagination and an `$or` of five regexes are the two unbounded-cost shapes a client can request; bounds plus `maxTimeMS` (503 `QUERY_TIMEOUT`) keep a pathological request from burning the Worker CPU budget |
| E11000 → 409 translated in the issuing service               | The driver error names a constraint, not an answer: duplicate filter name, duplicate user email and counter race need different responses, and no driver's own text may escape to the client |
| Self-bootstrapping E2E suite                                  | A suite that reuses a long-lived dev server passes once and then fails ~15 times inside the register-limiter hour. Booting a fresh API per run makes the suite re-runnable and gives CI a real gate on a clean runner |
| `noPropertyAccessFromIndexSignature` stays OFF               | Enabling it was measured at a large error count against the current code; it is a do-not-do, not a pending improvement                                                                                                                       |

## 8. Compiler strictness (intended flags — do not "improve")

`tsconfig.base.json` is the single source; `server/` and `shared/` extend it, the UI has its own config.

- **On (intended):** `strict`, `noUncheckedIndexedAccess` (index access yields `T | undefined` — this is what forces
  the exhaustive `hasValue()`/default handling), `exactOptionalPropertyTypes` (`{ x?: T }` may not be
  assigned `undefined` explicitly, so "absent" and "present as undefined" stop drifting), `noImplicitOverride`,
  `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `isolatedModules`.
- **Deliberately OFF: `noPropertyAccessFromIndexSignature`.** It was measured at a large error count when tried and is on
  the do-not-do list. Turning it on "to be stricter" is a regression, not an improvement — if a future task revisits it,
  re-measure first.
