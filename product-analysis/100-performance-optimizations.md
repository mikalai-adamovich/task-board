# 100 — Performance: applied optimizations and future proposals

> Outcome of a multi-stage latency forensic investigation (Mongo/DO/Cloudflare + FE waterfall). All conclusions are
> measurement-based (driver events, `wrangler tail` wall/CPU, curl timing, browser network), not assumptions. Diagnostic
> tooling: [`tools/README.md`](../tools/README.md).

## 1. Context

Stack: Angular 22 (zoneless) → Cloudflare Worker (thin proxy) → Durable Object (Hono app + singleton MongoClient) →
MongoDB Atlas M0 (replica set, eu-central-1). Typical warm API request ~70-90ms; the investigation covered periodic
200-700ms spikes and the cold-load waterfall.

## 2. Applied optimizations (server / infrastructure)

### 2.1 Durable Object as the MongoClient holder

- **Problem:** workerd binds TCP sockets to the request context that created them (workerd#2721). A MongoClient in a
  plain Worker died with the request → error 1101.
- **Solution:** thin Worker proxy → DO owns the Hono app + singleton MongoClient (`DB_CLIENT_MODE=durable`, rollback:
  `per-request` via `--var`).
- **Result:** warm p50 ~75-90ms vs ~224ms (per-request mode measured — worse).
- **Note:** per-request mode is significantly worse and is not a solution (measured).

### 2.2 Explicit placement region (Frankfurt)

- Smart Placement never converged (INSUFFICIENT_INVOCATIONS with single-user traffic) and kept execution local (WAW).
  `region = "aws:eu-central-1"` in wrangler.toml → `cf-placement: remote-FRA`, next to Atlas.
- **Result:** DO→Atlas RTT dropped to single-digit ms.

### 2.3 Bundle minify (TOML pitfall)

- `minify = true` placed after `[placement]` in TOML silently became `placement.minify` and was ignored → bundle 3206
  KiB. Moving it above all table headers → 1860 KiB.
- **Lesson:** in TOML a bare key after a `[table]` header belongs to that table.

### 2.4 Mongo indexes for real query patterns

- Added `{projectId, title}` and `{projectId, statusId, updatedAt: -1}` — eliminate blocking SORT on /tasks as the
  collection grows (verified with explain at 500/2k/5k tasks).
- Existing indexes verified with explain("executionStats"): Mongo execution 0-3ms — never the bottleneck.

### 2.5 $lookup aggregations instead of sequential requests

- `findByTenantWithUsers` (members+users) and `findByUserWithTenants` (memberships+tenants): 2 RTT → 1 RTT. tenants
  139→114ms, members 147→121ms.

### 2.6 Parallel independent lookups in auth

- User lookup ∥ tenant membership lookup (membership depends only on the JWT sub + header). `tenantMembership` reused
  from the Hono context (`requireMembership(prechecked)`) — eliminated a duplicate query. /tasks DB phase: 47→18ms.

### 2.7 Latency spikes: cause UNKNOWN (the earlier explanation was refuted)

- **Symptom:** periodic 200-700ms spikes on any Mongo endpoint, at any cadence (250ms/1s/5s/10s), no correlation with
  query/sort/data size.
- **Earlier explanation, now WITHDRAWN.** This section previously claimed a root cause: that a non-default
  `connectTimeoutMS: 5000` acted as an **idle-socket** timeout, that it killed idle pooled connections with
  `reason='error'` at ~5s, and that removing it (leaving the driver default of 30 000) fixed the spikes. That mechanism
  does not exist in the driver this application ships. In `mongodb@7.6.0`, `lib/cmap/connect.js:303` applies
  `socket.setTimeout(connectTimeoutMS)` only while a connection is being **established**, and `:337` clears it with
  `socket.setTimeout(0)` in the `finally` — so the timeout is removed the moment the connection is up and cannot kill an
  already-established pooled connection. The A/B series quoted below (threshold "moving exactly with the setting") is
  therefore not evidence of the claimed mechanism; it is not re-published here as a cause.
- **What is actually true:** the spikes are real and their cause is **unexplained**. `connectTimeoutMS` is left at the
  driver default — not as a fix, but because there is no demonstrated effect to remove. The A/B numbers from the
  original investigation are kept in the git history of this file; the honest state is "not root-caused".
- **Settings that are NOT the cause** (all experimentally excluded): maxIdleTimeMS=30s, readPreference, replica-set
  member, query/sort/data size, app CPU, Cloudflare edge (ping clean), per-request client (worse), Atlas-side reap.
- **Where the current position is written down:** the comment above the client construction in
  [`server/src/db/mongo.ts`](../server/src/db/mongo.ts) (which also states the refuted mechanism explicitly) and
  `AGENTS.md` §Performance forensics. `maxIdleTimeMS: 30_000` is retained on its own merits and is uncredited.

### 2.8 Audit #2/#4: project_members lookup skipped for read-only requests (F3)

- `tenantContextMiddleware` resolved the caller's `project_members` role on EVERY project-scoped request — but the
  context value is consumed only by `requirePermission(action, true)` coarse gates, all of which sit on POST/PATCH
  routes; services resolve project roles themselves. For GET/HEAD the lookup is now skipped (**−1 Mongo op on every read
  request** for tenant MEMBERs). Write-route authorization unchanged; covered by 6 dedicated middleware tests.

### 2.9 /tasks/my: index + minimal projection (audit #3, 99e6b8e)

- `findAssignedTo` filtered by `{assigneeId}` alone — only the compound `{projectId, assigneeId}` index existed
  (projectId is its prefix) → **COLLSCAN**; response carried full task documents for a widget that renders
  number/title/priority.
- Index `{ assigneeId: 1, updatedAt: -1 }` in `CORE_INDEXES` (idempotent) + inclusion projection
  `{id, projectId, number, title, priority, createdAt, updatedAt}`. Explain: COLLSCAN (docsExamined = full collection) →
  IXSCAN (docsExamined = 50 for 50 returned); payload −74.6% (43 960 → 11 160 bytes for 50 tasks).

### 2.10 TOP-2: denormalized semantic sort names (306e618) and the `excludeDescription` flag (8112584, F5)

- Sorting by status/sprint ran an aggregation pipeline (`$lookup` + blocking `$sort` over all matches): measured **110
  ms** at 5k tasks for `?sort=statusId:desc`, growing linearly with the match set.
- `Task.statusName`/`Task.sprintName` denormalized (rename/delete fan-out via `setStatusNameForTasks` /
  `updateManyByStatus(name)` / `setSprintNameForTasks`; task create/update/bulk resolve names from the same batched
  reference lookups — M-14 preserved). Idempotent backfill `backfillTaskSortNames` + indexes
  `{projectId, statusName, number: -1}` / `{projectId, sprintName, number: -1}`.
- Explain after: **1 ms**, LIMIT → IXSCAN, docsExamined 50. **Deliberately NOT denormalized:** labelIds sort (fan-out of
  the alphabetically-first label was judged too expensive), assignee/reporter (their identity snapshots are already
  denormalized and stale-tolerant).

- **`excludeDescription` query flag** (same wave): omits `description` from list responses — measured **−41%** payload
  on a synthetic 400-char dataset and **−21.5%** on real data (200 tasks). Applied to the task table, overview recent
  tasks and the sprint task list; the board keeps descriptions for its card previews; server-side description search is
  unaffected.

### 2.11 TOP-3 №1+№2: bulk task updates in ONE bulkWrite + batched audit events (ae6c990, 5660171)

- `bulkUpdateTasks` used to run up to 100 sequential `findOneAndUpdate` (115.5 ms driver-side at 100 tasks, plus ~100
  Worker→Atlas RTTs) and then 100 sequential audit writes (139.7 ms, 200 ops counting actor lookups).
- `TaskRepository.bulkUpdateWithVersion`: ONE `bulkWrite` (ordered: false) with per-task optimistic-concurrency filters
  `{id, version}` + `$inc {version: 1}` — per-task semantics identical to the former loop. Audit phase:
  `AuditService.logMany` resolves the actor once and persists all events via one `insertMany`
  (`AuditEventRepository.createMany`, individual UUID/`createdAt` per event, empty batch = no-op).
- Measured (5050 tasks, bulk of 100): updates 115.5 → 7 ms; audit 139.7 → 4.5 ms; **end-to-end ~450 ms → ~40 ms** (DB
  operations ~400 → 5). Failure semantics (per-task VERSION_CONFLICT / TASK_NOT_FOUND / TASK_NOT_IN_PROJECT) preserved
  and tested.

### 2.12 Zod locale tree-shaking in the Worker bundle (0e989b2)

- `wrangler` bundles with esbuild, which cannot property-shake namespace re-exports (evanw/esbuild#1420).
  `import { z } from "zod"` therefore pulled **all 63 Zod v4 locale modules** through
  `export * as locales from "../locales/index.js"` in `zod/v4/classic/external.js` — 249 KB minified / ~36 KB gzip of
  error-message locales we never use (`z.locales` is not referenced anywhere in server/shared).
- Upstream fix colinhacks/zod#6384 (shipped in 4.5.4, our version) only covers Rollup/Webpack default exports; the PR
  explicitly states esbuild remains unaffected. The only bundler-safe form is `import * as z from "zod"`
  (Zod-documented).
- Fix (0e989b2): mechanical import-form change in 18 runtime files (+2 test files for uniformity); `error-handler.ts`
  (`ZodError`), `validation.ts` (`ZodType` type), `tenant.test.ts` (`type { z }`) untouched. Runtime semantics verified
  by the pre-fix audit: full 886-test suite parity A/B, real-schema smoke (coerce/enum/
  `instanceof ZodError`/`z.iso`/`z.email`), `tsc --noEmit`.
- **Measured (`wrangler deploy --dry-run`):** Total Upload 1,859.93 -> **1,514.65 KiB raw (-345.3 KiB, -18.6%)**; gzip
  337.40 -> **274.20 KiB (-63.2 KiB, -18.7%)**; brotli q11 279.2 -> 228.2 KB (-51.0 KB). Zod locale modules in the
  graph: 63 -> **1** (`en`, required by `_ensureDefaultLocale()` in classic/schemas.js); zod modules 94 -> 23.

## 3. Applied optimizations (frontend)

### 3.1 `/auth/bootstrap` — session init in one request

- Cold load: the sequential `GET /auth/me` → `GET /tenants` chain replaced by a single `GET /auth/bootstrap` (user +
  tenants, `Promise.all` over the two existing services).
- Deep-link critical path: 5 → 4 → (with the members fix) **3 RTT**.
- `TenantStore.tenantsLoaded` distinguishes "loaded and empty" from "not loaded" — guards skip a redundant `/tenants`.
- Session isolation: `logout()` clears the TenantStore; `seedFromBootstrap()` replaces the list (never merges) — fixed a
  tenant leak between sessions.

### 3.2 Members off the critical path (dd0e348)

- `loadProjectByKey()` no longer awaits `/projects/:id/members` — navigation continues immediately; `projectRole` is a
  reactive computed (OWNER/ADMIN bypass, MEMBER resolved from members when they arrive). Stale-response guard against
  cross-project races. **−1 RTT** per project/board deep-link.

### 3.3 ProjectRefStore — shared per-project reference data

- statuses/types/sprints/labels/members cached per project; M-12: members derived from the ProjectStore. Eliminated
  duplicate reference-data requests.

### 3.4 Audit #2: overview without a duplicate project fetch (F1)

- The overview re-fetched `GET /projects/:id` although `projectGuard` had just loaded the same project via
  `/projects/by-key/:key` into `ProjectStore`. The fetch is removed — the overview reads `ProjectStore.activeProject`;
  project mutations (settings update, archive/restore/delete) patch the store in place, so the read-only banner stays
  correct without a refetch. **−1 HTTP / −3 Mongo ops** per overview open.

### 3.5 ProjectRefStore: full-DTO cache (F2)

- The store now caches full DTOs (statuses/sprints/types/labels) per `${projectId}:${kind}`; the `SelectOption` layer is
  derived from the same cache (one fetch + one invalidation per kind per project session). Overview, board, sprint
  pages, board columns and the sprint list all read it — cross-page transitions (Overview ↔ Board ↔ Tasks ↔ Sprints) no
  longer re-fetch statuses/sprints (−2–3 duplicate HTTP per transition). Mutations invalidate/patch the cache; failed
  fetches stay uncached.

### 3.6 TenantHome + ProjectSwitcher share the project list (F4)

- Both used to issue an independent `GET /projects` on tenant home. A tenant-scoped cache in `ProjectStore`
  (`ensureProjectList` / `upsertProject` / `invalidateProjectList`) dedupes concurrent calls, patches the cached list on
  create/update/archive/restore/delete, isolates data per tenantId and drops everything on logout (stale-response guard
  against a late in-flight reply after logout). **−1 HTTP** per tenant home; the switcher stays consistent without
  refetching.

## 4. Future proposals (by expected value)

### 4.1 Class 2: pre-DB stall 140-320ms (edge/DO) — localized to platform level (2026-09-01)

- Keep-alive A/B across `/api/ping` (no Mongo, no DO logic) vs Mongo endpoints with `wrangler tail` worker-time
  decomposition: a **304ms spike occurred on /api/ping with Worker handler time 0ms** — the stall happens entirely
  outside our code (Cloudflare edge/DO scheduling). Baseline pre-Worker overhead: ~44ms (edge) on ping, ~70-76ms on
  DO-proxied routes (the DO hop itself ≈ 25-30ms). Frequency ~3-5% of requests. Not addressable in application code —
  effectively merged into 4.8 (platform-level).

### 4.2 Post-deploy transient hang 75-90s

- After every deploy the first/early request sometimes hangs 75-90s (does not scale with connectTimeoutMS, unrelated to
  idle). Likely DO handoff/connection storm during deploy. Investigate separately — this is worse than the regular
  spikes.

### 4.3 FE dedup: `/projects` — DONE (F4, 408658e)

- TenantHome + ProjectSwitcher now share a tenant-scoped cache in ProjectStore (dedupe/invalidation/logout clearing);
  `/projects/:id/boards` no longer exists (single-board model, doc 102).

- `/projects` is requested by TenantHome + ProjectSwitcher simultaneously; `/boards` by Sidebar + ProjectDetail. A
  shared per-tenant/per-project cache removes one duplicate per page.

### 4.4 Board projection DTO

- Board payload 199KB raw / 12.8KB gzip (200 tasks); the FE uses ~10 fields. A lightweight DTO saves ~5-15ms and
  traffic. Small gain — bundle with other API changes.

### 4.5 Semantic sort denormalization — DONE for statusName/sprintName (TOP-2, 306e618); labelIds deliberately deferred

- statusId/sprintId sorts are plain indexed sorts on denormalized names (2.10). The labelIds sort keeps its `$lookup`
  pipeline on purpose: the fan-out cost of the alphabetically-first label was judged too high for the benefit. The
  assignee/reporter sorts never needed it (identity snapshots).
- **labelIds audit (2026-09-01, benchmark on Mongo 8, 30% no-labels / 40% one / 30% two-four labels, 10 labels):** the
  `$lookup` pipeline (semantics: sort key = `$min(label names)`, no-label tasks = `\uffff` sentinel → last in ASC, first
  in DESC; blocking `$sort` over all matched docs, no index possible) measured **92 ms explain / 57 ms wall at 5k
  tasks** and **904 ms / 559 ms at 50k** (linear scaling, docsExamined = full match set). Variant B (multikey index over
  a denormalized `labelNames[]` array) is fast (<1 ms) but **semantically wrong on both ends**: multikey ASC sorts
  no-label docs first (pipeline: last) and DESC sorts by the _max_ element (pipeline: min). Variant C (scalar
  `labelSortName = min(names)` + `{projectId, labelSortName, number: -1}`) is **order-identical to the pipeline for ASC
  and DESC** (verified by exact id-order comparison) and costs <1 ms (24 ms deep-page at 50k). Deferral rationale: the
  only trigger is a manual click on the table's Labels column (default flows never sort by labels), 57-92 ms at
  realistic project sizes is acceptable, and variant C's rename/delete fan-out requires a _per-task_ min recompute (find
  affected → batched label names → bulkWrite) unlike TOP-2's constant-value `updateMany`. Revisit if label sort p95
  exceeds ~200 ms on production projects or projects >20k tasks actively sort by labels.
- Remaining candidate in the same area: a list DTO that drops `createdBySnapshot`/`createdById`/`version` from list
  responses — audited 2026-09-01, see 4.9 (DEFER).
- Dead code removed: `TaskRepository.search` / `TaskService.searchTasks` had no consumers (verified by grep, 2026-09-01)
  and were deleted in the cleanup commit (152b0ec); task search lives solely in `findByProject`'s `search` query
  parameter.

### 4.6 maxIdleTimeMS interplay

- maxIdleTimeMS is 30s, and that is the only idle threshold in play: `connectTimeoutMS` bounds connection ESTABLISHMENT
  and is cleared the moment the connection is up (see 2.7), so it is not part of an "effective idle threshold" and no
  min(both) arithmetic applies. If reconnects after 30-60s pauses become a complaint, raise maxIdleTimeMS (close reasons
  'idle' vs 'error' are distinguishable in driver events).

### 4.7 Atlas M0 → M10+

- M0 shared tier: rare edge jitter ≤190ms, variable RTT. If M0 limits start to matter (connections/ops), M10 resolves it
  by definition. No evidence of hitting limits yet.

### 4.8 Accepted as-is

- Rare edge jitter ≤190ms outside Worker execution (ping probes clean on keep-alive) — platform-level; only addressable
  via Cloudflare plan/architecture.

### 4.9 Task list DTO / payload trimming — audited, DEFER (2026-09-01)

- Per-field accounting over a real 200-task page (CAP MAIN, 5 000 tasks): full response **210 395 B raw / 15 043 B gzip
  wire** (≈93% compression). Fields with zero UI consumers in any list: `createdById` + `createdBySnapshot` +
  `statusName` + `sprintName` (TOP-2 fields are server-internal sort keys; UI resolves display names via
  ProjectRefStore) → dropping them saves 15.1% raw (~1.5 KB wire). `version` is needed by board DnD and sprint mutations
  and costs 1 B/task. `labelIds` (10.3%) is used only by the task table; `reporterId`/`assigneeId` raw values are never
  rendered (snapshots are).
- Latency isolation by limit: limit=1 (+37 ms over ping) ≈ limit=20 (+43) ≪ limit=200 (+87) → payload costs ≈ **0.2
  ms/KB** (BSON transfer Atlas→Worker + JSON + gzip). Crucially, the existing `excludeDescription` flag (−43 KB raw)
  showed **no measurable latency gain** (136 vs 127 ms median — noise): payload trimming is a bytes-only optimization.
- DB side: exclusion projections do not change `docsExamined` (non-covered query, WiredTiger returns whole documents).
- Verdict DEFER: the heaviest list page is ~15 KB on the wire; the default response must stay backward-compatible, so
  the gain requires an opt-in flag + 4 client call sites for ~10% wire bytes and <1 ms. Revisit with any future task-DTO
  change, mobile/slow-network complaints, or payload monitoring showing list responses dominating. (Related: 4.4 board
  projection DTO, same conclusion.)
- Micro-inconsistency noted for a future cleanup: `toDomain` materializes `statusName ?? null` / `sprintName ?? null`,
  so even projected DTOs (`/tasks/my`) carry these two keys, unlike the absent-key pattern of `excludeDescription`.

### 4.10 Cloudflare Worker / Durable Object request-path audit — NO ACTION (2026-09-01)

- **Path (verified in code):** Browser → Worker ([`index.ts`](../server/src/index.ts): URL parse →
  `shouldProxyToDurable`, ping/health stay Worker-side) → `idFromName('mongo')` — **one global DO for everything** — →
  `get(id, { locationHint: 'weur' })` → ONE `stub.fetch` (no retries/redirects, no serial pre-work) →
  `MongoHonoDurableObject` runs the same Hono app (requestId → CORS → mongo-mode → provideServices → auth with user ∥
  membership in parallel → tenant-context (F3) → RBAC) → module-cached MongoClient singleton inside the DO isolate
  (`maxPoolSize: 5`). 135 tail events show a single `durableObjectId` — hot reuse, no pool-explosion risk.
- **Placement:** Smart Placement OFF (experiment A never converged — INSUFFICIENT_INVOCATIONS at single-user traffic);
  explicit `[placement] region = "aws:eu-central-1"` instead, **live-verified `cf-placement: remote-FRA`** on requests
  entering at WAW. DO locationHint `weur` is consistent with it. Atlas region: eu-central-1 _claimed_ in code comments —
  UNKNOWN factually (MONGODB_URI is a secret, not read); handler timings (~5 ms/op) support proximity.
- **Latency (50 keep-alive requests/endpoint):** ping p50 40 / max 46; 1-op endpoints 76-80; `limit=1` 80; `limit=200`
  p50 139 but p75 271 / p95 343 / max 761. Decomposition via `wrangler tail` (83 handler logs + client series): DO
  handler = p50 19 ms (`limit=1`) / p50 32 ms, **max 51 ms** (`limit=200`), i.e. ~5 ms per Mongo op; the `limit=200`
  tail is body transfer of 210 KB **uncompressed** (bench clients without `Accept-Encoding`; a browser receives ~15 KB
  gzip ≈ 3-5 ms — not user-facing) plus rare TTFB spikes (ping max 238, `limit=200` TTFB max 738) with handler ≤51 ms —
  platform variance, confirming 4.1.
- **Methodology note:** DO `wallTime` from `wrangler tail` (p50 265 ms) includes response-stream flush and must NOT be
  used for latency decomposition; the Hono request logs (`--> ... Xms`) are the correct handler-time source.
- **Cold vs warm:** deterministic DO eviction cannot be triggered safely; cold path from code = DO isolate start +
  mongodb dynamic import (~1.86 MB minified bundle) + client handshake ~300 ms, paid once per DO lifetime. Eviction
  frequency UNKNOWN (no restart instrumentation). Cheap future improvement: one log line in the DO constructor to count
  cold starts.

### 4.11 GET read-path / N+1 audit — NO ACTION (2026-09-01)

- Full inventory of hot GET paths (route → service → repo → Mongo ops) + keep-alive round-robin against production (15
  rounds, ping baseline 40 ms): 1-op endpoints (statuses/sprints/board/auth-me/my-tasks) sit +35-40 ms over ping;
  2-parallel-op task list +108 ms (payload, see 4.9); serial two-hop reads (task detail 86 ms, members 87 ms) +46-47.
  Effective Mongo RTT ≈ 10-18 ms per serial hop.
- **No N+1 anywhere in GET paths:** list enrichment uses `$lookup`/batched `findByIds` (project/tenant members), audit
  enrichment runs 3 dependent waves + 8 collections in `Promise.all` (R3-P7/V7-4), snapshots are denormalized, read-only
  paths run no permission lookups (F3), no duplicate fetches within a request. Auth middleware resolves user ∥
  tenant-membership in parallel and reuses the doc in tenant-context.
- Residual candidates (all small): (a) fuse the M-02 tenant-assert second hop (entity → project) into one `$lookup`
  aggregation in `getTask`/comments/`getSprint` — ~10-12 ms per task-detail open, medium complexity; (b)
  `getProjectMembers` runs `getProject` (404 gate) then the members aggregate sequentially — independent, could be
  `Promise.all`, ~10 ms on a rare admin page; (c) task-list payload — see 4.9. None passes the frequency ×
  avoidable-latency bar; the dominant costs (40 ms platform overhead, Mongo RTT) are not addressable in code (4.1, 4.7).

### 4.12 Post-Zod-fix bundle & Worker startup audit — NO ACTION (2026-09-01)

- **Baseline after 2.12 (0e989b2, `wrangler deploy --dry-run`):** 1,514.65 KiB raw / 274.20 KiB gzip / 228.2 KB brotli;
  wrangler 4.127.1, esbuild 0.28.2. ~10x headroom to the Cloudflare gzip limit.
- **Exact attribution (source-map mappings + compressed spans):** saslprep 562.1 KB raw (36.3%) but **only 3.7 KB gzip**
  (Unicode data table, ~150:1 compressible); mongodb 458.5 KB raw / 117.6 KB gz; app code 142.9 KB / 32.9 KB; zod core
  98.3 KB / 28.6 KB; bson 80.1 KB / 24.4 KB; postal-mime (static dep of resend, MIME parsing we never use) 72.3 KB /
  22.1 KB; hono 34.9 KB / 13.4 KB; unenv polyfills 29.9 KB / 11.9 KB.
- **Transitive chains:** saslprep <- static require in mongodb `cmap/auth/scram.js` (SCRAM-SHA-256 normalization;
  mongodb@7 has no exports map / no workerd entry); postal-mime <- static import in resend (our emails are text/HTML,
  parser unused); the only dynamic import in the bundle is `@react-email/render` inside resend, left EXTERNAL by esbuild
  (0 sources bundled) and never executed by us — no bundle cost.
- **Startup (`wrangler check startup`, local workerd — attribution only, NOT production latency):** Active CPU 41.1 ms
  (GC 3.2 ms) on the repo bundle; profile is minified into one file (42% `(program)`, ~8% GC) — no dominant module.
  What-if A/B with real wrangler `[alias]` stubs: saslprep removal -> **-553.55 KiB raw but only -7.15 KiB gzip and ZERO
  measurable startup-CPU delta** (28.5 vs 27.5 ms, within noise); postal-mime removal -> -71.3 KB raw / -21.4 KB gzip,
  CPU delta 0.
- **Module scope is clean:** MongoClient created lazily on first request (`app.ts` via `runWithDb`; singleton promise in
  `db/mongo.ts`), no top-level await, module scope = 2x `new Hono()` + routeRegistry + ~64 zod schema constructions
  (ms-scale).
- **Verdict:** no significant, safely optimizable bundle/startup source remains. Two documented P2 candidates (both
  wrangler `[alias]` stubs, both zero startup-CPU gain): (1) saslprep — -36.5% raw for -2.6% gzip, but breaks SCRAM
  normalization for non-ASCII passwords (auth-path risk); (2) postal-mime — -71.3 KB raw / -21.4 KB gzip (~8% of upload)
  but stubs resend-internal behavior. Both revisit-only-if-needed.

### 4.13 First-request-after-idle Mongo reconnect — CONFIRMED Mongo reconnect, maxIdleTimeMS A/B NO ACTION (2026-09-02)

- **Instrumentation:** temporary diagnostic markers (commit 82afb3a, removed again in the cleanup commit that closed
  this topic): `DO_CONSTRUCTOR` in the DO constructor and CMAP pool events (`MONGO_POOL_CREATED` /
  `MONGO_CONNECTION_CREATED` / `MONGO_CONNECTION_READY durationMS` / `MONGO_CONNECTION_CLOSED reason` /
  `MONGO_POOL_CLEARED`) attached exactly once to the singleton MongoClient only (per-request and readyz clients
  uninstrumented).
- **Production finding — CONFIRMED Mongo reconnect:** after an idle pause **>~30 s** the first `tasks?limit=1` pays a
  reconnect penalty of **~95-160 ms** (warm p50 ~90 ms). At 15 s idle there is no reconnect and latency stays
  warm-level. On every >30 s cycle the tail shows two new connections (application + monitor) and
  `connectionReady.durationMS ≈ 90-146 ms`, which explains the extra latency with an **unexplained remainder ≤~35 ms**.
  A single ~510 ms outlier in one 240 s cycle is platform variance, not baseline.
- **DO lifecycle:** `DO_CONSTRUCTOR` was observed in 4 of 6 boundary cycles (including 35 s idle); the identical
  reconnect penalty occurred both with and without it. DO restart/eviction was therefore **not shown to be a material
  contributor** to the measured latency spike — the measured source is Mongo connection recreation.
- **maxIdleTimeMS A/B (30 s vs 300 s, everything else identical, isolated via deploy):** at 35/60/240 s idle variant B
  still showed `connectionClosed(reason=error)` and new connections; extra-latency distribution statistically unchanged
  (A extra p50 ≈ 140 ms, B ≈ 135 ms; benefit ≈ 0 ms). **NO ACTION** — `maxIdleTimeMS` is not an effective lever for this
  reconnect path.
- **connectTimeoutMS — semantics, and the refuted correlation:** the MongoDB documentation defines `connectTimeoutMS` as
  the timeout for establishing a connection (and `socketTimeoutMS` as a separate socket-related option). For the
  installed **mongodb@7.6.0**, the connection path applies it to the socket via `socket.setTimeout(...)`
  ([cmap/connect.js:303](../node_modules/mongodb/lib/cmap/connect.js)) while ESTABLISHING and clears it with
  `socket.setTimeout(0)` in the `finally` (:337) — so it cannot act on an established pooled connection. An earlier
  version of this file used that detail to claim a correlation with the ~30 s idle socket closure seen as
  `connectionClosed(reason=error)`; that correlation is WITHDRAWN as refuted (see 2.7) and the ~30 s closure remains
  unexplained. Changing `connectTimeoutMS` was never investigated as an optimization and is not recommended here (it
  governs connection establishment).
- **Verdict: NO ACTION** — the ~100-150 ms cost occurs only once per idle gap >~30 s (warm request ~90 ms);
  `maxIdleTimeMS 30 s → 300 s` did not reduce the penalty; for this personal-scale product the measured benefit does not
  justify changing timeout semantics. A `connectTimeoutMS`-based mitigation remains a possible future hypothesis ONLY if
  the workload changes and idle reconnects become materially significant.
- **Operational incident (deploy vars):** the first manual `npx wrangler deploy` during this audit was run WITHOUT the
  CD `--var` flags; because wrangler vars are deployment-scoped configuration and are not inherited, production
  temporarily lost `DB_CLIENT_MODE=durable` (requests fell back to per-request mode — visible in tail as stateless-only
  events with 55-259 ms CPU) as well as `ALLOWED_ORIGINS`, `FRONTEND_URL` and `ENVIRONMENT`. Detected via the tail
  anomaly and immediately re-deployed with the exact CD command; the restored vars were taken from the previous
  deployment version (`wrangler versions view`); final production state verified. **Lesson:** production deploys must
  use the exact deployment command defined by CD ([.github/workflows/cd.yml:93-96](../.github/workflows/cd.yml))
  including all required `--var` values — never a bare `wrangler deploy` when those vars are supplied by CI.
- Chain: instrumentation → production confirmation → maxIdleTimeMS A/B → NO ACTION → instrumentation removed (working
  tree restored to pre-82afb3a for both files).

### 4.14 Task sort gaps: priority / assigneeId / reporterId / typeId plain sorts — DEFER / NO ACTION (2026-09-02)

Read-only audit following the compound-sort-index FIX (§ after 4.12: the four `…number:-1` task indexes +
`tenant_members.userId_1`, commit a274a46) and the redundant-index audit (6 CLEANUP CANDIDATES identified, all DEFERRED
pending a `$indexStats` window).

- **The four plain sort paths are real application shapes.**
  [`task.repository.ts`](../server/src/repositories/task.repository.ts) `findByProject` sorts
  `{ [docSortKey]: sortDir, number: -1 }` where `docSortKey = SEMANTIC_TO_DOC_KEY[sortField] ?? sortField` and
  `SEMANTIC_SORT_FIELDS = {labelIds}` — so `priority`, `assigneeId`, `reporterId`, `typeId` are pure plain-field sorts
  with filter `{ projectId, …filters }`. All four are reachable from the hot task-table header (3-state asc→desc toggle
  over `SORT_FIELDS`, both directions) and persistable in saved filters.
- **Explain evidence (mongod 8.2.12, production-like rs0 dataset, largest project = 100 tasks):** for every field, both
  directions and every limit (1/20/100) the winning plan is `SORT > FETCH > IXSCAN [projectId_1_number_-1]` — a blocking
  SORT over the ENTIRE matching set: `keysExamined = docsExamined = 100` regardless of limit, 2-6 ms. Cost is O(matching
  set), not O(limit). The combined shape `{ assigneeId filter + priority sort }` also blocks
  (`SORT > FETCH > IXSCAN [projectId_1_assigneeId_1]`).
- **Existing-index reuse:** `assigneeId_1_updatedAt_-1` is NOT a replacement for the task-list sort (second key
  `updatedAt` ≠ `number`; it stays a KEEP for `/tasks/my`). `projectId_1_assigneeId_1` helps assignee **filtering** but
  cannot serve the current compound sort with the `number:-1` tiebreaker (a hypothetical `{assigneeId: -1}` sort without
  the tiebreaker does scan it: `LIMIT > FETCH > IXSCAN`).
- **Traffic evidence: NOT MEASURABLE.** `$queryStats` is unavailable on the used mongod 8.2.12 (probe failed with
  InvalidNamespace; config untouched). `$indexStats` is single-node rs0 with a short window (reset at the 2026-09-01
  server restart; the newest indexes minutes old) — its counters neither prove nor disprove user traffic. Application
  evidence proves reachability, not frequency.
- **Why not fix now:** full naive coverage would need up to **8 new indexes** (`{projectId, field: ±1, number: -1}` —
  the two direction shapes are not reverse scans of each other), on a collection already carrying 18 indexes (960 KB
  index vs 242 KB data). At the current scale (~100 tasks/project) the SORT costs only a few ms.
- **Key observation for a future fix:** `number` is UNIQUE within a project, so the tiebreaker's direction does not
  change the deterministic ordering. If the repository tiebreaker were aligned as `number: sortDir`, then a single
  `{projectId, field: 1, number: 1}` index per needed field would cover BOTH directions via reverse index traversal — 4
  indexes instead of 8. This is a future option only; code and indexes are unchanged in this audit.
- **Verdict: DEFER / NO ACTION for all four.** Revisit trigger: (1) production traffic/query-insights evidence for these
  sort paths is obtained, or (2) the matching project size grows to ~1k+ tasks; then re-run explain/latency, and if the
  workload is confirmed, consider the aligned-tiebreaker design instead of the 8-index approach.
- **2026-09-02 amendment (superseded by §4.20):** the revisit trigger fired via the Jira-like synthetic workload audit —
  the aligned-tiebreaker design was verified (one index serves both directions via reverse traversal) and IMPLEMENTED
  with 4 compound indexes. Verdict for the four plain-field sorts is now **FIXED** (see §4.20).

### 4.15 Aggregation & pagination scan paths — NO ACTION (2026-09-02)

- **1. Status-summary (`GET /projects/:projectId/tasks/status-summary` → `countByStatusGrouped`,
  [task.repository.ts:471](../server/src/repositories/task.repository.ts); consumer: project-detail overview, 1 request
  per view — count not measurable).** Query shape
  `[{ $match: { projectId } }, { $group: { _id: '$statusId', count: { $sum: 1 } } }]`. Explain (mongod 8.2.12,
  production-like rs0): **GROUP > PROJECTION_COVERED > IXSCAN [projectId_1_statusId_1]** — the aggregation is fully
  covered by the index, **no FETCH stage**, `docsExamined = 0`, `keysExamined` = the matching set (100 / 63 across two
  projects — inevitable for exact per-status counts), 1-3 ms. **Verdict: NO ACTION** — the plan is already optimal:
  scanning the matching index keys is unavoidable for an exact count, and no document reads happen.
- **2. Audit-log deep pagination (`{ projectId }`, sort `{createdAt: -1}`, `skip N, limit 20`).**
  `projectId_1_createdAt_-1` already supports filter + sort; `keysExamined` grows with the offset (measured skip = 0 /
  100 / 1000 → keys = 20 / 100 / 100, docs beyond the limit = 0, ~0 ms on the production-like dataset, 1616 events
  collection-wide). Cost is potentially O(offset) — not a current bottleneck. **Verdict: DEFER.** Trigger:
  `audit_events` / a project's audit log grows to ~10⁴-10⁵ events, or production measurements show material latency/CPU
  cost — then re-explain and consider cursor/range pagination (MongoDB recommends range queries over large `skip` when
  offsets become significant). **No new index proposed: `projectId_1_createdAt_-1` already serves filter + sort
  optimally — the potential issue is the pagination strategy, not a missing index.**
- **3. Task-list deep pagination (skip 200, limit 20).** `projectId_1_number_-1` serves the sort; skip is bounded by the
  project size (~296 tasks collection-wide, largest project 100), so deep pages are unreachable beyond the matching set;
  ~3 ms. **Verdict: NO ACTION.**
- **4. Counters (`getNextValue` = `findOneAndUpdate` + upsert by `_id`).** Read-side explain for `{_id}` shows
  **EXPRESS_IXSCAN [_id_]**, ~0 ms; the write-side explain was deliberately skipped so as not to mutate data. **Verdict:
  NO ACTION.**
- **5. Task relationships (`$or {sourceTaskId, targetTaskId}`).** Plan `SUBPLAN > FETCH > OR > IXSCAN [sourceTaskId_1]
  > IXSCAN [targetTaskId_1]` — both branches index-supported, the expected index-or behavior; the collection is empty on
  > the current dataset. **Verdict: NO ACTION.**
- **Extra evidence for the redundant-index audit (§ above):** `projectId_1_statusId_1` has a real consumer — the covered
  status-summary aggregation scans it (the 3-key `…_updatedAt_-1` variant also produced a covered plan in
  rejectedPlans). Its cleanup therefore cannot be declared safe on prefix redundancy alone; index unchanged.
- **Cycle verdict: NO ACTION.** The only scale risk is the audit-log deep skip (DEFER, not FIX).

### 4.16 Residual COLLSCAN edges (auth/recovery/lookup tails) — DEFER passwordReset / NO ACTION (2026-09-02)

Explain sweep over the last unexamined rare-path query shapes (mongod 8.2.12, production-like rs0; frequency evidence
NOT MEASURABLE — no per-query logs, `$queryStats` unavailable, `$indexStats` windows inconclusive; absence of stats
evidence is not treated as absence of traffic).

- **`{ "passwordReset.tokenHash": <hash>, deletedAt: null }` — the only real-caller COLLSCAN.** Consumer: password-reset
  confirmation ([auth.service.ts:350](../server/src/services/auth.service.ts)). Measured: **COLLSCAN, docsExamined =
  71** (whole `users` collection), latency ~0 ms. No dedicated index exists. Potential fix: single/partial index on
  `passwordReset.tokenHash` — but traffic frequency is unknown, the flow is inherently rare, and the collection is
  small. **Verdict: DEFER / NO ACTION.** Trigger: `users` grows to ~10³+, or production evidence shows frequent
  password-reset confirmations — then re-explain and decide on the index.
- **`project_members {userId}` (findByUser)** — COLLSCAN, 19 docs, used only on the cascade-delete path; negligible
  cost. **Verdict: NO ACTION.**
- **`tenants.findAll()` (`find({})`)** — COLLSCAN over 22 docs, but **no production caller** (source grep: tests only);
  not a performance issue. Potential dead-code cleanup is separate from performance work. **Verdict: NO ACTION.**
- **All other auth/invite lookups are already index-supported at ~0 ms:** email (`email_1` unique, EXPRESS/IXSCAN), id
  (`id_1`), tenant_members `{userId, role}` (covered by the new `userId_1`), `invitation.invitedEmail_1`,
  `invitation.tokenHash_1`, users `$in` findByIds. The `tenant_members.userId` COLLSCAN from the earlier audit is closed
  by the index added with the compound-sort FIX.
- **Cycle verdict: NO ACTION.** The single DEFER is the `passwordReset.tokenHash` COLLSCAN. No
  index/code/config/migration changes were made.

### 4.17 Write-path / index-maintenance fan-out — NO ACTION (2026-09-02)

Source-inspection-only audit of every repository/service write path (no writes executed, no write-side explains — all
write-path **latency evidence: UNKNOWN**, no per-write metrics exist; `$indexStats` does not measure write maintenance;
write frequency UNKNOWN throughout — stated per evidence policy, not treated as absence of workload).

- **Task updates (`findOneAndUpdate {id, version}`,
  [task.repository.ts:446](../server/src/repositories/task.repository.ts)).** MongoDB maintains only indexes whose keys
  change. Every logical update bumps `updatedAt` → 4 updatedAt-bearing indexes (`projectId_1_updatedAt_-1`,
  `…_-1_number_-1`, `projectId_1_statusId_1_updatedAt_-1`, `…_-1_number_-1`); field-specific additions: status change →
  +3 statusId indexes + the denormalized `statusName` change touches the 316 KB `projectId_1_statusName_1_number_-1`;
  assignee → `projectId_1_assigneeId_1`; title → 2 title indexes; sprint → 2 sprint indexes; **priority → none
  (unindexed)**. So ~4-8 index entries per single-task update on an 18-index collection. The fan-out is structural, not
  a code defect: one round-trip per update plus one batched audit event. **Verdict: NO ACTION** (no measurable impact;
  at 296 tasks the maintenance cost is negligible). Cross-link: executing the deferred redundant-prefix cleanup (the two
  `updatedAt`-bearing short indexes from the index-maintenance audit) would cut the per-update fan-out from ~4 to ~2
  updatedAt indexes — the write-side argument FOR that future cleanup.
- **Bulk task update** — one `bulkWrite(ordered: false)`
  ([task.repository.ts:511-522](../server/src/repositories/task.repository.ts)), already single round-trip (TOP-3 №1);
  per-task index maintenance as above; audit events written as ONE `insertMany` (`logMany`, TOP-3 №2). No residual
  per-document audit writes anywhere: single-action paths emit exactly one event, bulk paths one batch. **Verdict: NO
  ACTION — batching is already in place.**
- **Fan-out `updateMany` admin operations** (status rename/delete → `setStatusNameForTasks` / `updateManyByStatus`
  `$set {statusId, statusName, updatedAt}`; sprint rename/clear → sprintName/sprintId + `updatedAt`; label delete →
  `$pull labelIds` + `updatedAt`): each is ONE set-based round-trip over the matching set; per-document index
  maintenance touches the multikey labelIds index, the 316 KB statusName index and the 4 updatedAt indexes. Rare admin
  actions. **Verdict: NO ACTION.**
- **Task creation** — counter `findOneAndUpdate` (atomic, `_id` EXPRESS index) + `insertOne` (maintains all 18 indexes
  for the new document — unavoidable) + 1 audit event; 3 sequential round-trips by design, no N+1. **Verdict: NO
  ACTION.**
- **Task delete cascade** — comments `deleteMany`, relationships `deleteMany $or`, task delete, audit event: 4
  sequential indexed round-trips (audit event before deletion per DEC). Rare. **Verdict: NO ACTION** (a transaction
  would add latency without a correctness problem today — the audit trail is written first).
- **Project delete cascade** — 12 sequential set-based `deleteMany` round-trips
  ([project.service.ts:328-338](../server/src/services/project.service.ts)); N×1 round-trip pattern (one per
  collection), not per-document; rare operation. **Verdict: NO ACTION** (parallelizing or transacting is a possible
  future cleanup, benefit unmeasurable at current scale).
- **Project creation** — the only transactional write path (`withTransaction`, DEC-025): project + ~5 status seeds +
  board + task-type seeds + default-status update + creator membership, sequentially inside one transaction (~12
  round-trips), with a compensating-cleanup fallback for non-replica-set topologies. Rare. Minimal possible fix would be
  `insertMany` batching of the seed loops. **Verdict: NO ACTION** (write-rare, latency UNKNOWN, correctness path solid).
- **tenant_members / users / counters mutations** — single-document `insertOne` / `findOneAndUpdate` / `updateOne`; ≤7
  index entries per membership insert (7 indexes); counters are atomic on `_id`. Rare or already minimal. **Verdict: NO
  ACTION.**
- **Cycle verdict: NO ACTION.** No write bottleneck is evidenced anywhere; the only quantified write-side cost remains
  the index-count/storage figure from the index-maintenance audit (tasks: 18 indexes, 960 KB index vs 242 KB data), and
  the strongest write-side lever remains the deferred redundant-index cleanup, not any code change.

### 4.18 Long-cycle performance research — 2026-09-02

Single research cycle covering the residual performance surface across 16 directions (A–P): read-query inventory,
aggregations, endpoint round-trips, deep N+1, payload cost, search/regex, pagination, index-coverage matrix, write
amplification, cascades, repeated reads, client↔API chatter, render/CD, bundle residuals, Worker/DO residuals, startup
CPU. **Strictly read-only — no code/index/config changes.** Evidence: production-like rs0 explains, full index
inventory, BSON size survey, source inspection. Traffic frequency remains NOT MEASURABLE (`$queryStats` unavailable on
mongod 8.2.12; `$indexStats` window short/single-node) — stated per the evidence policy, not treated as absence of load.

**Executive summary:** 16 directions traversed; 12 candidate findings collected. FIX NOW: **0**. FIX CANDIDATE: **1**
(task search index strategy at scale). DEFER: **2** (task search, inherited audit deep-skip). NO ACTION / do-not-fix:
**9**. The system is plan-clean at current scale: every hot read shape is index-supported with `keys ≈ docs ≈ n`, all
enrichment is batched (`$in` + `Promise.all`), all `@for` loops carry `track`, and Milkdown/highlight.js stay out of
static chunks.

| Area  | Finding                                                                                                                                                                                                                                   | Evidence                                                                        | Impact                                                           | Scale risk                                                   | Cost/risk                                            | Verdict                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------- |
| F/A   | Task search: `$or` of 5 case-insensitive `$regex` (title, description, 3 snapshots) over `{projectId}`                                                                                                                                    | explain: `FETCH > IXSCAN {projectId_1_number_-1}`, keys=docs=100, 5 ms          | ~5 ms/project of 100 tasks; O(project size) at FETCH + regex CPU | ~50 ms at 1k tasks/project                                   | Text/Atlas Search = infra change                     | **DEFER**                                       |
| B     | Semantic `labelIds` sort `$lookup` joins `labels` on foreign field `id`; `labels` has **no `{id}` index** (only `_id`, `projectId`)                                                                                                       | explain: `EQ_LOOKUP > FETCH > IXSCAN {projectId_1_number_-1}`, 3 ms @ 100 tasks | ~0 (tiny collection, rare path)                                  | Only if labels grows AND labelIds sort ships                 | One index on labels `{id}` if ever needed            | **NO ACTION**                                   |
| C/K   | Write ops re-fetch the project (`projectRepo.findById`) solely for the audit event's `tenantId` — 2 reads of the same project per write, in ~10 call sites (task/status/sprint/label/type/board)                                          | source; each read `EXPRESS_IXSCAN`/`{id}` ~0 ms                                 | ~0-1 ms per write                                                | negligible                                                   | passing tenantId through would touch many signatures | **NO ACTION (do-not-fix)**                      |
| D     | `tenant.service deleteUser` authorization loop: `findByUserAndTenant` per target-membership (read in loop, early `break`)                                                                                                                 | source; N = target's tenant count (1-3), indexed                                | ~0                                                               | small-N by construction                                      | batching saves nothing real                          | **NO ACTION (do-not-fix)**                      |
| J     | Per-document delete/update loops in rare admin cascades: `permanentDelete` (project_member.delete per member), `deleteUser` (tenantMember.delete per member), archive/restore tenant (project.update per project)                         | source; set-based alternatives exist (`deleteMany`/`updateMany`)                | ~0 (N small, ops indexed)                                        | rare admin ops                                               | none                                                 | **NO ACTION (do-not-fix)**                      |
| G     | `comments.findByTask` returns ALL comments of a task, no pagination                                                                                                                                                                       | source; dataset: 4 comments total, avg doc 802 B                                | ~0                                                               | unbounded array response if a task accumulates 100+ comments | trivial skip/limit later                             | **NO ACTION** (trigger: any task >100 comments) |
| E     | Payload survey: tasks avg 836 B (max 4 689 B), audit_events avg 488 B, comments 802 B, boards 660 B, users 219 B → largest realistic page ≤ ~20 KB JSON before gzip                                                                       | `collStats` + `$bsonSize` top-3                                                 | none                                                             | none at current content sizes                                | —                                                    | **NO ACTION**                                   |
| A/G   | Remaining per-project reference lists (sprints/statuses/task_types/labels sorted, members)                                                                                                                                                | explains: `SORT > FETCH > IXSCAN` over 0-5 docs, ~0 ms                          | none                                                             | lists bounded by project size                                | —                                                    | **NO ACTION**                                   |
| H     | Index-coverage matrix (query shape → index → covered?/sort?/FETCH?): every read shape in the repo maps to a supporting index; competing-index question already dispositioned in the redundant-index audit (6 DEFERRED cleanup candidates) | full index inventory + §redundant-audit                                         | —                                                                | —                                                            | —                                                    | **NO ACTION**                                   |
| I     | Write amplification re-check: index list unchanged since §4.17; tasks still 18 indexes, ~4-8 entries per task update; strongest lever remains the deferred redundant-prefix cleanup                                                       | index inventory                                                                 | —                                                                | —                                                            | —                                                    | **NO ACTION**                                   |
| L/M   | Client chatter + render: no duplicate/sequential request residuals beyond closed §3.x items; every `@for` in features carries `track` (task-table, board, audit, detail)                                                                  | source sweep of 73 `@for` sites                                                 | —                                                                | —                                                            | —                                                    | **NO ACTION**                                   |
| N/O/P | Bundle (Milkdown, highlight.js grammars inside dynamic `import()` only), Worker/DO and startup CPU: no new residuals beyond closed §2.12/§4.10/§4.12/§4.13                                                                                | source inspection                                                               | —                                                                | —                                                            | —                                                    | **NO ACTION**                                   |

**TOP backlog (ROI order):**

1. **FIX CANDIDATE — task search at scale.** The only genuinely unindexable shape. Technical fix exists (text index or
   Atlas Search, or restrict `$or` to title only), but requires one more confirmation: production search frequency +
   project sizes ≫ 100 tasks. Do NOT act at current scale.
2. **DEFER — audit-log deep skip** (inherited, §4.15; unchanged).
3. **DEFER — plain-field task sorts** (inherited, §4.14 with the aligned-tiebreaker design; unchanged).
4. **DEFER — passwordReset.tokenHash index** (inherited, §4.16; unchanged).
5. **DEFER — redundant-prefix index cleanup** (inherited; also the best write-side lever per §4.17; needs `$indexStats`
   window).

**Do not re-research (measured clean):** project-for-audit-tenantId re-read; deleteUser authorization loop; per-member
delete loops in rare cascades; small-collection reference-list sorts; `counters` `_id` prefix-regex delete (index-served
`IXSCAN {_id_}`); comments-by-task / user_settings / user_preferences / filters / boards / projects-by-tenant / all
member `$lookup` joins (all `~0 ms`, index-served — explains on record).

**2026-09-02 amendment:** TOP backlog item "plain-field task sorts" (then DEFER) was upgraded and implemented the same
day after the 5k synthetic workload confirmed the scale bottleneck — see §4.20 (verdict FIXED).

### 4.19 `labels` missing `{id}` index (for the labelIds semantic-sort `$lookup`) — NO ACTION

Recorded as the single new structural observation of §4.18, kept separate for grep-ability: the `EQ_LOOKUP` join in
`buildSemanticSortPipeline` (`labels.localField=labelIds → foreignField=id`) cannot use an index because `labels`
carries only `{_id}` and `{projectId}`. Measured impact ~0 (labels is tiny, the labelIds sort is a deferred feature).
Trigger to act: labelIds sort ships as a default path AND a project's label count reaches ~10². Then add `{id: 1}`
(16-32 KB class of storage) — not before.

### 4.20 Plain-field task-table sorts (priority / assigneeId / reporterId / typeId) — FIXED (2026-09-02)

Implementation of the aligned-tiebreaker option first documented in §4.14, triggered by the Jira-like synthetic workload
audit (5k-task project, no production traffic needed as prerequisite — the workload-model assumption is that task-table
column sorting is a HIGH-frequency interaction in a Jira-like product).

**Why the previous DEFER was overturned.** §4.14 deferred for lack of traffic evidence. The synthetic 5k dataset turned
the scale question into a measurement: all four sorts were blocking in-memory SORTs over the ENTIRE matching set —
measured production e2e 265-319 ms vs ~133 ms baseline, and locally ~20 ms @1k → ~108 ms @5k → ~216 ms @10k (linear ≈ 22
ms per 1k tasks, limit-independent). `SORT > FETCH > IXSCAN {projectId_1_number_-1}`,
`keysExamined = docsExamined = project size` regardless of limit 1/20/100.

**Source/semantic audit (Phase 1).**

- The four fields are raw-value plain sorts at [task.repository.ts](../server/src/repositories/task.repository.ts)
  `findByProject` (`sort({ [docSortKey]: sortDir, number: -1 })`); `SEMANTIC_SORT_FIELDS = {labelIds}` — the
  `buildSemanticSortPipeline` priority/assignee branches are dead code; `SEMANTIC_TO_DOC_KEY` does not map these four.
- `number` uniqueness per project is enforced structurally: unique index `{projectId: 1, number: -1}` + atomic counter
  (`taskNumber:<projectId>`).
- No test pins tie-group order; saved filters persist the `sort` string, not tie order; pagination is offset-based and
  stays deterministic.
- **Explicit contract decision (not "behavior invisible"):** for ASC, the order WITHIN groups of equal field values
  changes — `number` ascending (new) instead of `number` descending (old). DESC is bit-identical
  (`{field: -1, number: -1}` is the exact reverse of `{field: 1, number: 1}`). Nulls (`assigneeId`/`reporterId`) keep
  MongoDB's uniform null-ordering (index and in-memory sort bracket missing/null identically). Overall ordering remains
  fully deterministic because `number` is unique per project. The four-way tiebreaker change is scoped to exactly these
  fields: a global flip would break the existing `… number: -1` indexes that serve createdAt/updatedAt/title/statusName
  sorts.

**Index experiment (Phase 2, synthetic data, temp indexes — dropped after).** One candidate index per field,
`{ projectId: 1, field: 1, number: 1 }`:

- ALIGNED shape `{ field: dir, number: dir }` — winning plan `LIMIT > FETCH > IXSCAN{projectId_1_field_1_number_1}`
  **[forward] for ASC and [backward] for DESC** — one index covers BOTH directions, `keys = docs = limit`, 0-3 ms
  (confirmed by explain, not assumed).
- OLD-tiebreaker ASC shape `{ field: 1, number: -1 }` still blocks even with the index present — proving the repository
  change is required, not optional.
- Filtered shapes: `{statusId} + priority sort` and `{sprintId} + assignee sort` use the new index (2-3 ms);
  `{assigneeId} filter + priority sort` keeps its pre-existing plan (filter-index IXSCAN + SORT over that filter's
  matching set — unchanged from before, inherent filter/sort-field mismatch, 22 ms @5k);
  `{typeId} filter + priority sort` improved (1270 keys vs full scan).

**Benchmark (Phase 3, before → after, winning-plan ms @limit 20):**

| Scale | priority asc/desc          | assigneeId asc/desc | reporterId asc/desc | typeId asc/desc  |
| ----- | -------------------------- | ------------------- | ------------------- | ---------------- |
| 1k    | 21-22 → 0-1 ms (both dirs) | 20-21 → 0-1 ms      | 18-21 → 0-1 ms      | 20-21 → 0-1 ms   |
| 5k    | 103-106 → 0-1 ms           | 100-115 → 0-1 ms    | 99-103 → 0-1 ms     | 96-103 → 0-1 ms  |
| 10k   | 204-217 → 0-1 ms           | 204-222 → 0-1 ms    | 194-208 → 0-1 ms    | 190-209 → 0-1 ms |

Complexity changed from O(project size) to O(limit), stable across 5k/10k; production e2e expectation: 265-319 ms →
~baseline (~133 ms), flat at any project size.

**Implementation (Phase 4).**

- [task.repository.ts](../server/src/repositories/task.repository.ts):
  `ALIGNED_TIEBREAKER_FIELDS = {priority, assigneeId, reporterId, typeId}`; `findByProject` sorts
  `{ [docSortKey]: sortDir, number: sortDir }` for these four and keeps `{ …, number: -1 }` for every other sort. The
  `labelIds` pipeline, statusName/sprintName mapping, and all query logic untouched.
- [migrations.ts](../server/src/db/migrations.ts) `CORE_INDEXES`: +4 — `{projectId, priority, number}`,
  `{projectId, assigneeId, number}`, `{projectId, reporterId, number}`, `{projectId, typeId, number}` (all `1,1,1`).
  Pre-checked via `listIndexes` — no name collisions, no equivalent key patterns. Applied via the штатный
  `scripts/migrate.ts` (889 ms); CD applies the same migration to production before the Worker deploy. `tasks` now
  carries 22 indexes (~+80-130 KB storage on the 296-task local dataset; proportionally small at 5k).
- Write-side impact: +4 index entries maintained per task INSERT (now 22); per-field task UPDATES touching
  priority/assigneeId/reporterId/typeId now maintain one more index each — accepted trade-off (§4.17 fan-out analysis
  unchanged in spirit; single-document updates are not write-bound).

**Regression (Phases 5-6).**

- `npm run typecheck` PASS; `npm test` 886/886 PASS; `npm run lint` PASS.
- All 8 paths re-explained on synthetic 5k AND 10k data:
  `LIMIT > FETCH > IXSCAN{projectId_1_<field>_1_number_1} [forward|backward]`, keys=docs=20, **SORT=false** in every
  winning plan.
- Hot-path regression: default `number`, `createdAt`, `updatedAt`, `title`, `statusName`, `sprintName` sorts,
  `{statusId}`/`{assigneeId}` filters, and the `/tasks/my` shape all keep their previous index-supported plans (keys=20,
  SORT=false) — no shape regressed.

**Final verdict: FIXED** for the four plain-field sort paths (blocking SORT eliminated, O(limit) plans verified in both
directions). Deferred siblings stay as documented: search (§4.18), audit deep-skip (§4.15), passwordReset (§4.16),
redundant-prefix cleanup (index-maintenance audit).

### 4.21 Board-specific lightweight task projection (`view=board`) — DONE (2026-09-02)

Follow-up of the board payload research (§4.18 top-candidates): the board fetched the FULL Task DTO (205.5 KB raw for a
200-card board on CAP66) although cards read only a subset of fields. Product decision: the card shows key/priority /
title (2-line clamp) / type + assignee — **no description at all** (task-detail content).

**Implementation** (no index or generic-contract changes):

- [`shared/src/types/task.ts`](../shared/src/types/task.ts): new `BoardTask` DTO —
  `id, projectId, number, title, typeId, statusId, priority, assigneeId, assigneeSnapshot, version`. `version` is
  REQUIRED by the board's optimistic drag-and-drop update; `assigneeId` by the client-side "unassigned" filter.
- [`task.repository.ts`](../server/src/repositories/task.repository.ts): `TaskQueryOptions.view?: 'board'` → exclusion
  projection
  (`description, reporterId, reporterSnapshot, statusName, sprintName, sprintId, labelIds, createdById, createdBySnapshot, createdAt, updatedAt`
  → 0) on the plain-find path and as `$unset` on the semantic pipeline path. `toDomain` maps projected timestamps
  conditionally (a projected doc no longer crashes the mapper — caught by the live wrangler-dev check).
- [`task.service.ts`](../server/src/services/task.service.ts): `getBoardTasks` maps the projected result to the exact
  `BoardTask` shape (no leakage by construction); [`routes/tasks.ts`](../server/src/routes/tasks.ts) branches on the new
  `view=board` query param (Zod-validated); the generic list contract is untouched.
- UI: [`task-client.ts`](../ui/src/app/services/task-client.ts) `listForBoard()`; board card redesigned to the
  key+priority / title (line-clamp-2) / type+assignee layout with the description preview REMOVED;
  [`board-view.ts`](../ui/src/app/features/boards/board-view/board-view.ts) uses `listForBoard` + `refStore` types
  (added to `ensure`) and orders cards by severity rank (`PRIORITY_RANK` CRITICAL→LOW, ties by number asc).

**Measured (live wrangler-dev on the local production-like DB, realistic ~350B descriptions):**

- per-task response: full 21 fields → board exactly 10 fields; `description` confirmed ABSENT from the actual HTTP
  response (not merely unused by Angular); generic list response byte-identical to before.
- payload: **−67% raw JSON, −39% gzip** on the same tasks; 200-card extrapolation ≈217 KB → ≈72 KB raw (CAP66 real data
  measured earlier: 205.5 KB → ~68 KB raw, gzip 14.7 KB → ~9 KB). Mongo time unchanged (3 ms) — projection is a
  materialization/serialization/payload optimization, NOT a DB-scan optimization (explain below).

**Mongo plan (explain, board shape `{projectId}` + sort `{number:-1}` + limit 200 + projection):**
`IXSCAN {projectId_1_number_-1} > FETCH > PROJECTION_SIMPLE > LIMIT`, keys=docs=limit, no SORT, 3 ms — **no new index
added**. A `{projectId, statusId, priority, number}` index was deliberately NOT created: `priority` is a semantic enum
(LOW/MEDIUM/HIGH/CRITICAL — alphabetical order ≠ severity), so an index sort on the raw field cannot produce severity
order; Mongo-side severity sorting would require a denormalized numeric `priorityRank` field (future option).
Client-side rank sort over the ≤200 loaded cards is O(200) and negligible.

**Tests:** repository projection test (exact exclusion projection), service DTO-shape test (exact key set — no
description/reporter/createdAt leakage), card tests (type name rendered, description never rendered even when present on
the input, title carries `line-clamp-2`), board spec updated to `listForBoard`. typecheck PASS, 889/889 tests PASS, lint
clean. No commits.

**Remaining board issue (separate, product scope):** the hard `limit: 200` cap — on a 5k-task project 4 800 tasks are
unreachable from the board (see §4.18 / the board research). Pagination/per-column loading is the next design
discussion, deliberately not part of this change.

### 4.22 Priority model migration: `priority: string` → `priorityLevel: number` — DONE (2026-09-02)

Breaking-change model migration following the §4.18/§4.21 finding that the string priority enum
(LOW/MEDIUM/HIGH/CRITICAL) cannot express severity order in MongoDB (alphabetical ≠ severity — the task table sorted
CRITICAL/HIGH/LOW/MEDIUM while the board sorted by severity).

- **Single source of truth** ([shared/src/constants/priority.ts](../shared/src/constants/priority.ts)):
  `TASK_PRIORITY_CONFIG` (`level` + `i18nKey`), with `TaskPriorityLevel` derived via indexed access
  (`(typeof CONFIG)[number]['level']`), runtime `TASK_PRIORITY_LEVELS`, `DEFAULT_TASK_PRIORITY_LEVEL` (= 1, medium). The
  string enum `TaskPriority`/`TaskPriorityValues` was removed; all Zod validation derives from the config
  (`z.literal(TASK_PRIORITY_CONFIG.map(c => c.level))` — no hardcoded `0..3` anywhere).
- **Data migration** ([migrations.ts](../server/src/db/migrations.ts) `migrateTaskPriorityToLevel`, idempotent): counts
  → refuse on missing/unexpected legacy values → backfill `priorityLevel` → verify → migrate saved-filter
  `criteria.priority` arrays → `$unset` the legacy field → drop the legacy index. `audit_events` deliberately NOT
  migrated (historical records keep `field: 'priority'` with string values; new events use `field: 'priorityLevel'` with
  numbers). Local run: 296 tasks migrated (distribution 0:81, 1:131, 2:81, 3:3), 0 saved filters affected (collection
  empty), legacy field absent afterwards.
- **Index replacement** (not additive): `{projectId: 1, priority: 1, number: 1}` →
  `{projectId: 1, priorityLevel: 1, number: 1}`; the legacy index is dropped by the migration. Explain after the
  replacement: ASC `LIMIT > FETCH > IXSCAN{projectId_1_priorityLevel_1_number_1}[forward]` and DESC `[backward]`,
  keys=docs=limit, no blocking SORT — numeric severity order with the aligned tiebreaker now serves BOTH the board
  (Critical→Low) and the task table (previously alphabetical).
- **API/UI**: `?priorityLevel=2` query param (z.coerce + literal pipe), request/response bodies numeric; the public sort
  key `sort=priority:asc|desc` is intentionally PRESERVED and mapped internally to the `priorityLevel` field
  (URL/saved-filter sort semantics unchanged). `PRIORITY_RANK` deleted — the board sorts
  `b.priorityLevel - a.priorityLevel || a.number - b.number`; all UI option arrays are generated from the config.
- **Verification:** typecheck PASS, 889 tests (server+UI) PASS incl. 5 new migration tests (level mapping, missing →
  throws, unexpected → throws, saved-filter backfill, idempotent re-run), lint clean; no runtime references to the
  legacy model remain (grep).
- **Follow-up fix (same day):** `npm run typecheck` covers only shared+server `tsc` — the UI's esbuild template
  type-check (inside `ng test`) caught 15 leftover string-priority usages (column-def `getFilterValue` widening,
  native-select string binding, `Number()` coercion moved from templates into component methods, spec fixtures). Lesson:
  UI type correctness is only fully verified by the `ng test` build, not by the repo `typecheck` script.

### 4.23 Board cursor pagination + infinite scroll + DnD without refetch — DONE (2026-09-03)

Replaces the flat `GET …/tasks?view=board&limit=200` + client-side grouping with per-column keyset pagination (Stage 2
benchmark verdict: `Promise.all` over columns beats `$facet` 9–105×; `$facet` cannot push branch `$match`es into index
scans and COLLSCANs the collection).

- **Contract** ([shared/src/constants/board.ts](../shared/src/constants/board.ts),
  [shared/src/utils/board-cursor.ts](../shared/src/utils/board-cursor.ts)): fixed `BOARD_PAGE_SIZE = 50` cards per
  column (no client-controlled limit); Mongo probes 51 internally for `hasMore` (no `countDocuments`); opaque base64url
  cursors carrying `(priorityLevel, number)` with versioned payload
  (`encodeBoardCursor`/`decodeBoardCursor`/`InvalidBoardCursorError` → HTTP 400); response `BoardPage` dictionary keyed
  by column id (`BoardColumnPage`: tasks ≤ 50, `nextCursor`, `hasMore`).
- **Server** (`GET …/tasks/board`): one HTTP request, columns resolved from `BoardConfig` (callers pass
  `cursor.<columnId>` only — no arbitrary `statusIds` injection), per-column queries via `Promise.all`
  (`TaskRepository.findBoardPage`: `{projectId, statusId: $in}` + `$or` cursor predicate, sort
  `{priorityLevel: -1, number: 1}`, board exclusion projection, `limit(51)` slice to 50). Overlapping column `statusIds`
  resolve to a single owner column (V4-12 parity, most-specific-first). No `skip`, no counts, `findByProject()`
  untouched.
- **Index** (additive via `CORE_INDEXES`): `{projectId: 1, statusId: 1, priorityLevel: -1, number: 1}`. The existing
  `{projectId, priorityLevel, number}` ASC index cannot serve the mixed DESC/ASC board sort (proven blocking SORT 64/64
  benchmark cells). Local explain after migration:
  `LIMIT > PROJECTION_SIMPLE > FETCH > IXSCAN(projectId_1_statusId_1_priorityLevel_-1_number_1)`, keys=docs=nReturned,
  no SORT stage in the winning plan.
- **UI** ([board-view.ts](../ui/src/app/features/boards/board-view/board-view.ts)): per-column state
  (`tasks`/`nextCursor`/`hasMore`/`loading`), initial pages via `rxResource`, load-more micro-batched into one request,
  `BoardSentinel` directive (`IntersectionObserver`, 800px prefetch margin, disabled when exhausted/loading). Filter
  change bumps the generation — stale responses are dropped. DnD is optimistic local reconciliation only: remove from
  source, sorted-insert into target when inside the loaded prefix (or always when `hasMore=false`), server-returned card
  wins, cursor/`hasMore`/scroll untouched; 409 → single-card refresh via `getById`, 404 → card dropped. Column headers
  show loaded counts with a trailing `+` while `hasMore` (never a total). Dead `TaskClient.move()` (+ `MoveTask` type)
  removed. Task-card priority badge moved to the card's far-right corner.
- **Verification:** typecheck PASS, server 900 / UI 908 tests PASS (incl. cursor round-trip/malformed, repo
  predicate/projection/51→50, service ownership/subset/400s, route 400s, UI pagination guards, 13 DnD cases, sentinel
  contract), lint clean, migration applied locally (new index present, old indexes intact). Pre-existing breakage fixed
  on the way: `tasks.test.ts` mock used an arrow-function `mockImplementation` which current vitest cannot
  `new`-construct (baseline failed 10/11 before the change).

## 5. Tooling

Diagnostic scripts used during the investigation: [`tools/README.md`](../tools/README.md) (api-series — keep-alive
series with phases/pauses; curl-timing — single-request decomposition). The `wrangler tail` DBEV parser that correlated
driver events with client timestamps went with the instrumentation that produced those events, so attributing time
inside the Worker now requires re-instrumenting the request path first.
