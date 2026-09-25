# 101 — Board Domain Audit: multi-board vs single-board per project

Question: does the product actually need N boards per project? Evidence from the product-analysis corpus, the current
code, the live data, and competitor research (Jira / Linear / GitHub Projects). **No code or schema was changed.**

## 1. Current concept (as documented + implemented)

```
Project ──< Board (1:N)          boards collection, {id, projectId, name, type, columns[]}
           ├── columns[] group Statuses (Status ≠ Column, DEC-002)
Project.defaultBoardId            set at seed (BR-003), server-side, write-only afterwards
UserProjectBoardPreference.defaultBoardId   per-user selected board (DEC-004, US-BRD-02)
Sprint scoping                    ?sprintId= filter on the SAME board (DEC-038) — no sprint boards
```

Relevant decisions: DEC-002 (multi-status columns), DEC-004 (boards are project views; per-user preference),
DEC-008/BR-023 (default-board deletion protection), DEC-038 (unified sprint board via `?sprintId=`), BR-021 ("multiple
boards allowed; one displayed at a time"). The roadmap explicitly rejects _sprint-owned_ boards and _simultaneous
multi-board display_ ([24-future-roadmap.md](24-future-roadmap.md)).

## 2. Backend footprint (what 1:N costs today)

| Surface                                     | Detail                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entity                                      | `boards` collection: `{id, projectId, name, type KANBAN\|SPRINT, columns[{id,statusIds[],position}], createdAt, updatedAt}` ([board.repository.ts](../server/src/repositories/board.repository.ts))                                                                                              |
| CRUD                                        | `GET /projects/:id/boards` · `POST /projects/:id/boards` · `GET /boards/:boardId` · `PATCH /boards/:boardId` · `DELETE /boards/:boardId` ([routes/boards.ts](../server/src/routes/boards.ts))                                                                                                    |
| Seed                                        | every project atomically seeds exactly one "Default Board" ([project.service.ts](../server/src/services/project.service.ts) `seedBoard`)                                                                                                                                                         |
| Cross-cutting                               | status deletion rewrites columns across **all** boards (`replaceStatusInColumns`); project cascade deletes boards; audit events `BOARD CREATED/UPDATED/DELETED`                                                                                                                                  |
| `Project.defaultBoardId`                    | written at seed, returned in project payloads; **no server logic reads it** — the BR-023 "cannot delete default board" rule existed **only client-side** in `board-manager.ts` (`isDefault()`); `BoardService.deleteBoard` did NOT check it (documented in DEC-008, not implemented server-side) |
| `UserProjectBoardPreference.defaultBoardId` | validated against the board repo on PATCH ([user-preferences.service.ts](../server/src/services/user-preferences.service.ts)); exists only to serve the per-user board choice                                                                                                                    |

## 3. Frontend footprint (who consumes boards)

| Consumer                                                                               | What it does                                                                                                                         | Needs N boards?    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| [board-view.ts](../ui/src/app/features/boards/board-view/board-view.ts)                | renders ONE board by route param `:boardId`; has sprint/assignee/priority selectors — **no board switcher exists on the board page** | No                 |
| [sidebar.ts](../ui/src/app/shell/sidebar/sidebar.ts)                                   | fetches the board list only to resolve ONE link target (`resolveBoardId(boards, per-user default)`)                                  | No — needs one URL |
| [keyboard-shortcuts.ts](../ui/src/app/shared/keyboard-shortcuts/keyboard-shortcuts.ts) | `b` hotkey repeats the same resolution (fetch prefs + fetch boards)                                                                  | No                 |
| [project-detail.ts](../ui/src/app/features/projects/project-detail/project-detail.ts)  | "board shortcuts" grid — the only surface that lists >1 board                                                                        | Only for the grid  |
| `board-manager.ts`                                                                     | create/rename/delete boards; blocks deleting the project default (client-side only)                                                  | Only for CRUD      |
| [preferences-store.ts](../ui/src/app/stores/preferences-store.ts)                      | per-user `defaultBoardId` cache feeding sidebar/hotkey                                                                               | No                 |

**Key UX observation:** there is no board switcher inside the board view. With >1 board the user must go to the project
overview (or settings) and click a different shortcut. The multi-board scenario is technically possible but has no
first-class navigation — the UI behaves like a single-board product.

## 4. Actual data (local dev Mongo, `localhost:27017/task-board` — read-only aggregation)

- 12 projects → **12 boards → every project has exactly 1 board ("Default Board")**; 0 projects with >1 board.
- `user_preferences`: 4 docs, **0 with `defaultBoardId` set** (all `null`); the only field ever used is
  `taskTableColumns`.
- No dangling references (all `Project.defaultBoardId` point at the existing seed board).
- Limitation: production Atlas data was not queried (URI is a Worker secret, not available locally). Local data covers
  all verification-round fixtures; nothing in any round ever created a second board.

## 5. Competitor evidence (Atlassian docs/community, Linear docs, GitHub docs)

- **Jira team-managed projects (the default for self-serve teams): exactly ONE board per project — multiple boards are
  impossible** (Atlassian Community, confirmed by Atlassian staff, 2022–2024).
- **Jira company-managed: multiple boards exist, and the driving use case is "Board = Team"** — one board per team
  working in the project, different work streams, or long processes with distinct stakeholders (Atlassian boards
  overview; Jira Align literally merges team and board into one concept). This is the enterprise/multi-team scenario the
  product explicitly excludes (non-target: 500+ person enterprises, cross-team dependency mapping —
  [01-product-overview.md](01-product-overview.md)).
- **Linear: no board entity at all.** Boards are a layout toggle over saved filtered views; projects have view tabs
  (linear.app/docs/projects, /docs/custom-views, /docs/display-options).
- **GitHub Projects: boards are named saved views** over issues — "Change an assignee on the board and the issue
  updates… There is no separate database to keep in sync" (docs.github.com; workmanagementhub comparison).
- The product's own research already aligned with this: "GitHub Projects treats boards as saved views over issues —
  conceptually identical to our Board-as-configuration decision" ([03-competitor-analysis.md]).

**Synthesis:** multi-board-per-project is an enterprise multi-team feature. Every product aimed at the target segment
(small-to-mid dev teams, "Jira's backbone with Linear's friction profile") ships either one board per project (Jira
team-managed) or views-not-boards (Linear, GitHub Projects). The historical reason for separate boards in our own spec —
sprint boards — was already eliminated by DEC-038 (sprint selector on the same board).

## 6. Current vs Proposed

**Current:** `Project → N Boards → per-user defaultBoardId → (no in-board switcher) → sidebar/overview resolution`

**Proposed:** `Project → exactly 1 Board (columns/workflow config) → Sprint selector (?sprintId=) stays as-is`

The board keeps everything that has real value: multi-status columns (DEC-002 — the actual differentiator), column
editing, status-deletion replacement, sprint scoping. What disappears is the _collection cardinality_ and everything
that exists only to manage it.

### What can be removed (proposed model)

| Layer        | Removal                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API          | `POST /projects/:id/boards`, `DELETE /boards/:boardId` gone; `GET /projects/:id/boards` → `GET /projects/:id/board` (or embed `columns` in the project payload); `GET /boards/:boardId` → redirect or fold into the project board route                                                                                                                     |
| Mongo        | `Project.defaultBoardId` field; `UserProjectBoardPreference.defaultBoardId` field (**keep `taskTableColumns`** — it is the only field actually used); optionally embed the single board as a value object on `projects` and drop the `boards` collection                                                                                                    |
| Server logic | board create/delete service paths + their audit events; per-user default-board validation in preferences service; (fix opportunity: the missing server-side BR-023 check disappears with the rule itself)                                                                                                                                                   |
| Frontend     | `resolveBoardId()` util; per-user default-board cache paths in `PreferencesStore`; sidebar board-list fetch + resolution (link becomes `/board` directly); `b`-hotkey prefs+boards fetches (direct navigation); board-manager create/delete/rename-board UI → becomes a single "Board columns" editor; project-detail board-shortcuts grid → one Board link |
| Routes       | `/boards/:boardId` → `/board` (single canonical URL per project)                                                                                                                                                                                                                                                                                            |

### Migration concerns / what can break

1. **Existing projects with >1 board** (none observed locally; production must be checked): migration must pick a
   survivor (the project's `defaultBoardId` board) and either delete or archive the rest. Column configurations of
   dropped boards are lost — acceptable if count is 0, otherwise needs a report first.
2. **Deep links**: saved/bookmarked `/t/:slug/projects/:key/boards/:boardId` URLs → keep a redirect route to `/board`
   (cheap, permanent).
3. **`user_preferences` docs with `defaultBoardId` set**: field becomes dead — additive migration (stop reading, drop
   later) is safe; no data loss (observed usage: 0).
4. **Audit history**: past `BOARD CREATED/DELETED` events keep referencing board ids — history is append-only, no
   rewrite needed.
5. **Tests/e2e**: board-manager CRUD specs, sidebar resolution specs, keyboard-shortcut specs, verification plans
   P11/P20 — all need rework; this is the bulk of the migration cost.
6. **Sprint feature unaffected**: `?sprintId=` scoping, backlog (`sprintId=null`), completion disposition — all
   orthogonal to board cardinality.
7. **Future re-expansion**: if multi-team-per-project ever becomes real, the Jira-shaped answer is boards as _saved
   views_ (Linear/GitHub model) over one workflow — not the current board-entity CRUD. Removing the entity now does not
   block that path; it actually clears it.

## 7. Recommendation: **MOVE TO SINGLE-BOARD** (1:1 Project → Board)

Evidence stack:

1. **Data**: 0 of 12 projects ever had >1 board; 0 of 4 preference docs ever set a per-user board. The 1:N cardinality
   is 100% unused.
2. **UX**: the board page has no board switcher — the product already behaves single-board; multi-board exists only as
   settings CRUD nobody exercises.
3. **Market**: Jira's own self-serve default (team-managed) is exactly one board per project; multi-board is an
   enterprise/company-managed feature for the multi-team scenario the product explicitly excludes. Linear and GitHub
   Projects — the stated friction/philosophy references — have no board entity at all.
4. **Internal history**: DEC-038 already removed the sprint-board use case; the roadmap rejects sprint-owned and
   simultaneous multi-board display. Nothing in the corpus gives N boards a job.
5. **Cost of keeping it**: two `defaultBoardId` fields, a 5-endpoint CRUD surface, per-user preference machinery,
   list-resolution logic in 3 consumers (the exact duplicate-request surface just optimized in P1/P2), a
   documented-but-unimplemented BR-023 server check, and status-deletion rewrites across N boards.
6. **Cost of the differentiator is zero**: multi-status columns (DEC-002), the feature users actually feel, survives
   untouched in the 1:1 model.

Suggested sequencing (when approved): (1) query production for `boards` count per project to confirm the 0:N assumption;
(2) additive schema change — stop writing `defaultBoardId`, add `GET /projects/:id/board`; (3) UI: direct `/board`
route + redirect from `/boards/:boardId`; (4) remove CRUD + preference field in a later cut. The just-implemented
`BoardStore` (uncommitted, per instruction) remains useful in the 1:1 world for the single board fetch / or dissolves
into the project payload — no wasted work either way.
