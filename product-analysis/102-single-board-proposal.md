# 102 — Single-Board Proposal: `Project → exactly one Board`

Follow-up to [101-board-domain-audit.md](101-board-domain-audit.md). **No code changed yet** — this is the
implementation proposal. The deployed Cloudflare/Atlas environment is a test/educational environment with no real users
or business-critical data; backward compatibility is not a design constraint. Documentation language: English (chat:
Russian).

## 1. Current architecture

```
Project (1) ──< Board (N)            boards: {id, projectId, name, type KANBAN|SPRINT, columns[{id,statusIds[],position}]}
              │                        unique index {id}; non-unique {projectId}
              ├── Project.defaultBoardId          (set at seed; read by NO server logic)
              └── UserProjectBoardPreference.defaultBoardId   (per-user board choice; validated against boards)

Sprint scoping: ?sprintId= filter on the SAME board (DEC-038) — no sprint boards exist.
```

## 2. Complete board usage map

### Backend

| Location                      | Usage                                                                                                              | Fate in single-board model                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `shared/types/board.ts`       | `Board`, `BoardColumn`, `CreateBoard`, `UpdateBoard`; `BoardType` in `constants/roles.ts`                          | Rewrite: `BoardConfig {projectId, columns, createdAt, updatedAt}`; drop `id/name/type`, `CreateBoard`, `BoardType` |
| `schemas/board.ts`            | `CreateBoardSchema {name,type,columns}`, `UpdateBoardSchema {name?,columns?}`                                      | Single `UpdateBoardColumnsSchema {columns}`                                                                        |
| `routes/boards.ts`            | `GET/POST /projects/:id/boards`, `GET/PATCH/DELETE /boards/:boardId`                                               | Replace with `GET/PATCH /projects/:id/board`                                                                       |
| `board.service.ts`            | list / getById+tenant-assert / create / update / delete + `ensureManageBoards` + audit                             | Keep permission gate + audit; keep `getBoardByProject`, `updateColumns`; delete create/delete/list/getById         |
| `board.repository.ts`         | `findByProject`, `create`, `update`, `replaceStatusInColumns`, `deleteByProject`, BaseRepository `findById/delete` | Rewrite keyed by `projectId`; keep `replaceStatusInColumns` + `deleteByProject` unchanged                          |
| `project.service.ts`          | `seedBoard` (one "Default Board", KANBAN) + links `Project.defaultBoardId`; cascade `boardRepo.deleteByProject`    | Seed `{projectId, columns}`; stop writing `defaultBoardId`; cascade unchanged                                      |
| `status.service.ts`           | `replaceStatusInColumns` on status deletion with replacement                                                       | Unchanged                                                                                                          |
| `user-preferences.service.ts` | validates `defaultBoardId` against `boardRepo.findById`                                                            | **boardRepo dependency disappears entirely** with the field                                                        |
| `container.ts`                | wires `boards: BoardService`, `boardRepo` into preferences service                                                 | Update wiring (preferences loses boardRepo)                                                                        |
| `migrations.ts`               | indexes `{id:1} unique`, `{projectId:1}` on boards                                                                 | `{projectId:1} unique` replaces both; migration dedupes data                                                       |
| Audit                         | `BOARD CREATED/UPDATED/DELETED` events                                                                             | Keep `BOARD UPDATED` (column edits); CREATED/DELETED paths disappear                                               |
| RBAC                          | `manage_boards` action (PROJECT_ADMIN+, tenant ADMIN/OWNER bypass)                                                 | **Keep the action name** — no RBAC matrix change needed                                                            |

### Frontend

| Location                          | Usage                                                                                                                 | Fate                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app.routes.ts`                   | `boards/:boardId` (board-view), `settings/boards` (board-manager)                                                     | `board` (+ cheap redirect from `boards/:boardId`), `settings/board`                                                     |
| `board-view.ts`                   | `boardId = input.required()`, `boardClient.getById(boardId)`                                                          | No board param; `GET /projects/:id/board` via rxResource on projectId; sprint/assignee/priority filters untouched       |
| `sidebar.ts` + `sidebar.html`     | fetches board list only to resolve ONE link (`resolveBoardId(boards, per-user default)`); fallback link to settings   | Static link to `board`; **no fetch, no BoardStore, no resolveBoardId, no prefs read**                                   |
| `keyboard-shortcuts.ts`           | `b` hotkey: fetch prefs + fetch boards → resolve → navigate                                                           | Navigate to `board` directly — zero fetches                                                                             |
| `project-detail.ts`               | boards grid (shortcuts)                                                                                               | Single Board link; boards fetch removed                                                                                 |
| `board-manager.ts`                | create/rename/delete boards, type select, default-board delete blocking (client-side BR-023), invalid-ref red marking | Becomes **Board Columns settings** editor: column edit + invalid-ref marking only; create/rename/delete/type UI removed |
| `preferences-store.ts`            | per-project `defaultBoardId` map + `setDefaultBoard` + cache refresh                                                  | Remove default-board map/method; **keep `taskTableColumns` + the P1 dedupe cache**                                      |
| `board-utils.ts`                  | `resolveBoardId()`                                                                                                    | Delete                                                                                                                  |
| `board-store.ts` (uncommitted P2) | shared board-list cache                                                                                               | **Delete — never commit it** (see §9)                                                                                   |
| `user-preferences-client.ts`      | `updateProjectPreferences({defaultBoardId})`                                                                          | Type shrinks to `{taskTableColumns}`                                                                                    |
| e2e `board.spec.ts`               | placeholder board tests                                                                                               | Rewrite for single-board URLs                                                                                           |

## 3. Dead / redundant concepts (removed by this change)

1. `Project.defaultBoardId` — write-only server-side; the BR-023 protection it implies exists only client-side.
2. `UserProjectBoardPreference.defaultBoardId` — 0 of 4 preference docs ever set it; exists only because boards are N.
3. Board `name` ("Default Board" everywhere) and board `type` (KANBAN|SPRINT — meaningless once sprint scoping is a
   filter; only KANBAN ever seeded).
4. Board list endpoints + list resolution logic in 3 consumers (sidebar, hotkey, overview grid).
5. `BoardStore` (P2), `resolveBoardId`, board switcher abstractions.
6. Board create/delete/rename CRUD + their audit actions + undo-toasts for board deletion.

## 4. Target architecture — Variant A vs B

**Variant A — separate `boards` collection, keyed by `projectId` (unique):**

```
projects:  { id, tenantId, key, name, defaultStatusId, … }        // defaultBoardId removed
boards:    { projectId (unique), columns[{id,statusIds[],position}], createdAt, updatedAt }
```

**Variant B — embed board in the project document:**

```
projects:  { id, …, board: { columns[…] } }                       // boards collection dropped
```

| Criterion            | A (separate collection)                                                                                            | B (embed)                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Complexity of change | Low — repo/service/routes keep their shape; project schema untouched                                               | Higher — project schema/mapper/seed/validation/payload all change                    |
| Mongo queries        | `findOne({projectId})` / `findOneAndUpdate({projectId})` — same count as B                                         | Same                                                                                 |
| API                  | Natural: `/projects/:id/board`                                                                                     | Same                                                                                 |
| Frontend             | Same                                                                                                               | Same                                                                                 |
| Mutation model       | Column edits touch only `boards` docs; no project-doc contention                                                   | Column edits rewrite the project doc (version/conflict interplay with project edits) |
| Migration            | Trivial: dedupe existing docs (already 1:1 in observed data)                                                       | Rewrite: move columns into every project doc                                         |
| Audit                | `BOARD` entity events unchanged                                                                                    | Entity boundary blurs (board changes become project changes)                         |
| Future expansion     | If multi-view ever returns, the Jira/Linear answer is saved _views_, not this entity — A leaves the same path open | Same                                                                                 |

**Choice: Variant A.** It is the smallest honest change: the collection survives but loses its identity crisis —
`projectId` becomes the primary key, the pointless fields disappear, and the API collapses to two project-scoped
endpoints. Embedding buys nothing extra and couples two write paths (project edits vs workflow edits) that are
independent today.

## 5. API proposal

```
GET   /api/projects/:projectId/board     → { data: BoardConfig }        // any project reader
PATCH /api/projects/:projectId/board     → { data: BoardConfig }        // requirePermission('manage_boards', true)
      body: { columns: [{ id?, statusIds[], position }] }
```

- **No** `GET /boards/:boardId` — the board is addressed by its project; the tenant-assert dance (M-02) disappears
  because the route already sits inside the tenant-scoped project middleware.
- **No** `POST /boards` — the board is created atomically with the project (existing seed).
- **No** `DELETE /boards/:boardId` — the board dies with the project (existing cascade).
- **No separate board id** — `projectId` is the natural identifier.
- `?sprintId=` is a **frontend URL query param only** — the board endpoint never sees it; task filtering stays on the
  tasks endpoint exactly as today.
- RBAC action name `manage_boards` is kept verbatim → **no RBAC matrix change** (matrix changes require separate
  approval).

## 6. Data model proposal

```ts
// shared/src/types/board.ts
export interface BoardColumn {
  id: string;
  statusIds: string[];
  position: number;
}
export interface BoardConfig {
  projectId: string;
  columns: BoardColumn[];
  createdAt: string;
  updatedAt: string;
}
export interface UpdateBoardColumns {
  columns: { id?: string; statusIds: string[]; position: number }[];
}
// Board, CreateBoard, UpdateBoard, BoardType — deleted
```

```ts
// server: BoardDocument { projectId (unique index), columns, createdAt, updatedAt }
```

Removed fields: `boards.id`, `boards.name`, `boards.type`, `projects.defaultBoardId`, `user_preferences.defaultBoardId`.
**`user_preferences.taskTableColumns` is untouched** — it is the only preference field with real usage.

## 7. Routing proposal

```
/t/:tenantSlug/projects/:projectKey/board            ← canonical board URL (was /boards/:boardId)
/t/:tenantSlug/projects/:projectKey/board?sprintId=X ← sprint-scoped view (unchanged semantics)
/t/:tenantSlug/projects/:projectKey/settings/board   ← column editor (was settings/boards)
```

Transitional redirects (cheap, client-side only — the projectKey is already in the URL, no lookup needed):

```
boards/:boardId  → redirectTo 'board'      // boardId segment ignored
settings/boards  → redirectTo 'settings/board'
```

Rationale: test environment does not require old URLs, but both redirects are ~6 lines of route config and keep
bookmarks from verification rounds working. No server-side redirect machinery.

## 8. Frontend / Backend change list

**Frontend**

1. Routes: `board`, `settings/board` + the two redirects (§7).
2. `board-view`: drop `boardId` input; `boardResource = rxResource` over `projectId` calling
   `BoardClient.getForProject(projectId)`; everything else (columns render, DnD, multi-status prompt, sprint selector,
   filters, 200-task window) untouched.
3. `sidebar`: static `[routerLink]="['/w', slug, 'projects', key, 'board']"`; delete `boardId` computed, boards effect,
   `BoardStore`/`resolveBoardId`/prefs reads; the "no boards → settings" fallback branch disappears (a board always
   exists).
4. `keyboard-shortcuts` `b`: navigate to `board` directly; delete prefs+boards fetches.
5. `project-detail`: single Board link; delete boards fetch/grid.
6. `board-manager` → `board-columns` settings component: keep the column editor (status multi-select per column,
   ordering, invalid-ref red marking); remove create/rename/delete dialogs, type select, default-board blocking, board
   undo-toasts.
7. `preferences-store`: remove `projectBoardPreferences` map, `getDefaultBoardId`, `setDefaultBoard`; keep
   `taskTableColumns` + P1 cache (cache now holds `{taskTableColumns}` docs).
8. Delete `board-store.ts` + spec, `board-utils.ts` (`resolveBoardId`), `BoardClient.list/create/delete`; keep
   `getForProject` + `updateColumns`.
9. i18n: remove board create/rename/delete/type keys across 11 locales; add/keep column-editor keys.

**Backend**

1. `schemas/board.ts` → `UpdateBoardColumnsSchema`.
2. `routes/boards.ts` → two project-scoped routes (§5).
3. `board.service.ts` → `getBoardByProject(projectId)`, `updateColumns(projectId, input, userId, userRole)` (permission
   gate + `validateStatusIds` + `BOARD UPDATED` audit kept); delete create/getById/delete/list.
4. `board.repository.ts` → `findByProject` (returns single doc), `upsertColumns`, `replaceStatusInColumns` (unchanged),
   `deleteByProject` (unchanged); drop BaseRepository `findById/delete` usage.
5. `project.service.ts`: seed creates `{projectId, columns}` board; stop writing `defaultBoardId`; cascade unchanged.
6. `user-preferences.service.ts`: drop `boardRepo` dependency + validation branch.
7. `container.ts`: update wiring.
8. `migrations.ts`: `{projectId:1} unique` on boards (replaces `{id:1} unique` + non-unique `{projectId:1}`); migration
   step per §10.

## 9. P1 / P2 (uncommitted diff) disposition

- **P1 (PreferencesStore dedupe/cache): KEEP and commit independently first.** It is orthogonal to the board redesign —
  `taskTableColumns` preferences keep loading from two components (sidebar effect + task-table effect), so the dedupe
  stays valuable. Its default-board test cases get removed in the board cut.
- **P2 (BoardStore): DISCARD, do not commit.** The board-list cache exists only to serve a list that will no longer
  exist. Committing it first would mean writing tests for code deleted days later. The P2 _consumer_ edits
  (sidebar/project-detail/hotkey wiring) get superseded by §8 anyway.

## 10. Migration strategy (test environment — destructive cleanup allowed)

Ordered, idempotent steps in `server/scripts/migrate.ts` (runs from CD before the Worker deploy, safe against the
still-running old Worker):

1. **Dedupe boards** — for each project with >1 board keep the doc referenced by `projects.defaultBoardId` (fallback:
   oldest `createdAt`); delete the rest. Observed data: 12/12 projects already have exactly one.
2. **Normalize board docs** — rewrite each kept doc to `{projectId, columns, createdAt, updatedAt}` (drop `id`, `name`,
   `type`); idempotent by `projectId`.
3. **Unset dead fields** — `$unset {defaultBoardId: ""}` on all `projects` and `user_preferences` docs.
4. **Indexes** — create `{projectId:1} unique` on `boards`; drop `{id:1} unique` and the non-unique `{projectId:1}`.
5. Deploy the new Worker + UI (single cut is acceptable; step 1–4 are additive/idempotent so the old Worker — which
   never reads `defaultBoardId` server-side and lists boards — keeps working during the window).

No data preservation concerns: the environment is explicitly disposable; the migration is still written to be
re-runnable.

## 11. Test strategy — new invariants

**Server**

- Project creation seeds exactly one board (`boards.countDocuments({projectId}) === 1`).
- `GET /projects/:id/board` returns the board; 404 impossible for a seeded project.
- `PATCH /projects/:id/board` updates columns; rejects statusIds from another project (BR-045); denies EDITOR/VIEWER
  (`manage_boards`), allows PROJECT_ADMIN / tenant ADMIN/OWNER bypass.
- No endpoint can create a second board or delete the board (routes simply do not exist).
- Project cascade delete removes the board.
- Status deletion with replacement rewrites the (single) board's columns.
- Preferences PATCH accepts `{taskTableColumns}` only; `defaultBoardId` in a body → 422 (schema no longer has the
  field).
- Seed no longer writes `projects.defaultBoardId`.

**Frontend (zoneless patterns per AGENTS.md)**

- Board view resolves via `projectId` only — no board id in params; sprint `?sprintId=` filtering unchanged (empty
  sprint, backlog, 200-task window).
- Sidebar board link renders without any board/prefs fetch (assert zero HTTP).
- `b` hotkey navigates without fetches.
- Settings board-columns editor: edit persists via PATCH; invalid status refs marked red.
- Preferences store: no `defaultBoardId` state; taskTableColumns + dedupe cache tests updated.
- Redirect: `boards/:boardId` URL lands on `board`.

**e2e**: rewrite `ui/e2e/board.spec.ts` placeholders for the new URLs; verification-plan pages P11/P20 updated.

## 12. Performance impact (typical tasks-page deep link, tenant MEMBER)

| Metric                                           | Today                                                       | After P1 | After P1 + single-board                                   |
| ------------------------------------------------ | ----------------------------------------------------------- | -------- | --------------------------------------------------------- |
| HTTP requests                                    | 11                                                          | 10       | **9**                                                     |
| Mongo ops (≈4 per project-scoped GET for MEMBER) | ~40                                                         | ~36      | **~32**                                                   |
| Board-list requests per navigation               | 1–2 (+1 per `b` press)                                      | 1–2      | **0** (board fetched once by board-view itself)           |
| Client state                                     | BoardStore cache + prefs default-board map + resolveBoardId | —        | **deleted**                                               |
| Board-view load                                  | `GET /boards/:boardId` (+ tenant assert query)              | —        | `GET /projects/:id/board` (same 1 query, no extra assert) |

ETag/304: explicitly out of scope (small authenticated responses — established in the previous round).

## 13. Risks

1. **Spec/e2e rework volume** is the largest cost: board-manager specs, sidebar resolution specs, hotkey specs,
   preferences specs, verification plans P11/P20, e2e placeholders.
2. **i18n churn** across 11 locales (removed board-CRUD keys) — mechanical but wide.
3. **Audit history** keeps `BOARD CREATED/DELETED` events referencing dropped board ids — append-only history, no
   rewrite; enrichment falls back gracefully (same as today for deleted entities).
4. **Old bookmarks** — covered by the two cheap redirects.
5. **Conceptual loss**: if a genuine multi-team-per-project need appears later, the answer is saved views (Linear/GitHub
   model), not this entity — no capability is lost that the target market expects (Jira team-managed ships exactly one
   board per project).

## 14. Open questions

1. Settings route name: `settings/board` (proposed) vs keeping `settings/boards` to reuse i18n keys — cosmetic.
2. Should `GET /projects/:id/board` instead embed `columns` in the project payload (saves 1 request but couples caches
   and grows every project response)? **Recommendation: separate endpoint** — the board is needed only on the board page
   and the settings editor; project payloads stay lean.
3. Keep the `manage_boards` RBAC action name (recommended — no matrix change) or rename to `manage_board` (cosmetic,
   requires matrix edit approval)?

## 15. Recommended implementation order

1. **Commit P1** (preferences dedupe) — independent, already tested.
2. **Discard P2** (BoardStore + its spec) from the working tree.
3. **Migration** (§10 steps 1–4) + `migrations.ts` index changes.
4. **Shared types** (`BoardConfig`, `UpdateBoardColumns`; delete `Board`/`CreateBoard`/`UpdateBoard`/`BoardType`).
5. **Server**: schema → routes → service → repository → seed → preferences service → container (+ server tests).
6. **Frontend routing** (`board`, `settings/board`, redirects).
7. **Frontend consumers**: board-view → sidebar → hotkey → project-detail → board-columns editor → preferences-store
   cleanup; delete `BoardStore`/`resolveBoardId`/board CRUD client methods.
8. **i18n sweep** (11 locales).
9. **Tests**: server invariants (§11) + UI specs + e2e rewrite.
10. **Full verification**: `npm run typecheck && npm test && npm run lint && npm run build`; deploy to the test
    environment and smoke-check.

## 16. Verdict

**MOVE TO SINGLE-BOARD.**

Evidence: 0/12 projects with >1 board and 0/4 preference docs using the per-user board (audit 101); no board switcher in
the UI; Jira's own self-serve default is one board per project; Linear/GitHub have no board entity; DEC-038 already
removed the sprint-board use case. The proposed model deletes two dead `defaultBoardId` fields, four of five board
endpoints, board CRUD, the list-resolution machinery in three consumers, and the uncommitted BoardStore — while
multi-status columns (DEC-002, the actual differentiator), sprint scoping (`?sprintId=`), status-replacement
propagation, and the entire board UX remain exactly as they are.
