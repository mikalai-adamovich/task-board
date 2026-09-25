# 31 — UI/UX Verification Plan

End-to-end verification of the updated application: functional workflows, permissions, page states, and visual design.
Executors are delegated agents using **Playwright MCP** when available, falling back to the repo's Playwright e2e suite
(`npm run test:e2e`, specs in [`ui/e2e/`](../ui/e2e/)) and HTTP-level checks. Findings land in this file (§6 log) and
become fix tickets.

---

## 1. Environment bootstrap (every session)

```bash
docker compose up -d                 # MongoDB single-node replica set (W4)
npm run dev --workspace=server       # wrangler dev (needs MONGODB_URI/JWT_SECRET in wrangler.toml [vars])
npm start --workspace=ui             # ng serve (default http://localhost:4200)
```

Record the actual UI base URL. Seed state: fresh DB is fine — scenario A creates its own data. For permission scenarios
use **two browser contexts** (two incognito profiles): `owner@t.local` and `member@t.local`.

## 2. Page inventory (screenshot + smoke target list)

| #   | Route                                                            | Notes                                                         |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| P01 | `/auth/login`                                                    | incl. forgot-password link                                    |
| P02 | `/auth/register`                                                 |                                                               |
| P03 | `/auth/forgot-password`                                          | neutral confirmation                                          |
| P04 | `/auth/reset-password?token=…`                                   | valid + invalid token states                                  |
| P05 | `/auth/accept-invitation` (+ `/invite/:token` landing if routed) | valid/expired/revoked states                                  |
| P06 | `/` visitor landing                                              | logged-out                                                    |
| P07 | `/workspace/create` steps 1–4                                    | details+slug / plan / checkout / confirmation                 |
| P08 | `/t/:slug` unified tenant home                                   | incl. My-Tasks widget, admin invitation summary               |
| P09 | `/t/:slug/projects` project list                                 |                                                               |
| P10 | `/t/:slug/projects/:key` overview                                | summary, active sprint, recent tasks, members preview, boards |
| P11 | `…/boards/:boardId` board                                        | default + sprint-scoped (`?sprintId=`)                        |
| P12 | `…/tasks` table                                                  | filters, chips, pagination, filtered-empty vs empty           |
| P13 | `…/tasks/:taskNumber` detail                                     | inline edit, comments, relationships, conflict dialog         |
| P14 | `…/sprints` list                                                 | Backlog group, Active/Future/Completed, overdue badge         |
| P15 | `…/sprints/backlog` backlog view                                 |                                                               |
| P16 | `…/sprints/:sprintId` detail                                     | start/complete dialogs                                        |
| P17 | `…/members` project members                                      |                                                               |
| P18 | `…/settings` hub                                                 |                                                               |
| P19 | `…/settings/general`                                             | locked key hint                                               |
| P20 | `…/settings/statuses` · `task-types` · `labels` · `boards`       | replacement/delete flows                                      |
| P21 | `…/settings/danger-zone`                                         | typed confirmation                                            |
| P22 | `/t/:slug/settings` tenant settings                              |                                                               |
| P23 | `/t/:slug/settings/members` tenant members                       | "Invitation pending" display                                  |
| P24 | `/profile/preferences` (or current prefs route)                  | theme/zoom/language                                           |
| P25 | help pages (static)                                              | faq/docs/support                                              |

## 3. Functional workflow scenarios

### S-A — First-run journey (single user)

register → auto-login → welcome → create workspace (slug autogen/edit/availability) → Free plan → mock checkout →
confirmation → tenant home → create project (seed present: 5 statuses, 3 types, default board) → create task (default
status TODO) → inline-edit title/description/status/priority/assignee → comment add/edit → label reuse
case-insensitivity ("bug" resolves to "Bug") → relationships add/remove → task delete w/ confirm.

### S-B — Board & sprints

board renders columns TODO+REOPENED / IN_PROGRESS / IN_REVIEW / DONE → drag card between columns (incl. multi-status
prompt on column 1) → failed-move rollback (simulate offline via network throttle if possible) → create future sprint
(no dates) → assign tasks → start sprint (startDate set, endDate untouched) → complete sprint (endDate set;
unfinished-task disposition dialog) → reopen sprint → delete sprint (tasks → backlog) → overdue badge appears when
endDate edited into the past.

### S-C — Tasks table

search debounce → column filters → filter chips appear/removable → clear-filters action → sort asc/desc → pagination +
page-size → URL reproducibility (copy URL into new tab = same view) → saved filter create/apply/delete.

### S-D — Invitations & membership (two users)

owner invites member@t.local (role EDITOR) → member registers via invite flow → member sees tenant home → owner
re-invites another address (old link dead) → decline flow → revoke flow → restore flow ("access restored") → remove from
project (stays in tenant) → re-add.

### S-E — Permissions matrix (two users, roles OWNER / PROJECT_ADMIN / EDITOR / VIEWER)

For each role verify: read access everywhere in scope; Editor cannot manage statuses/types/labels/boards/sprints/members
or delete tasks; Viewer sees no write controls anywhere and cannot mutate via direct API call; Member cannot create
projects; non-member gets not-found/forbidden on direct URL entry.

### S-F — Destructive & lifecycle

archive project (read-only banner, restore works) → delete project (typed confirmation, grace period, cancel) → archive
tenant cascade + restore semantics → status deletion with mandatory replacement (tasks + boards updated) → status
deletion without task usage (board warning path) → user deletion (memberships gone, snapshots remain visible in
tasks/comments).

### S-G — Auth lifecycle

logout → session-expiry redirect behavior → password reset full cycle (email console fallback logs reset URL) → wrong
credentials neutral error → old `/tenants/:id` bookmark redirects to slug URL.

## 4. Visual/design protocol

For every page in §2 capture **full-page screenshots** at three viewports:

| Viewport | Size     | Focus                                                   |
| -------- | -------- | ------------------------------------------------------- |
| Desktop  | 1440×900 | layout, alignment, spacing rhythm, max-width containers |
| Tablet   | 768×1024 | grid collapse, sidebar behavior                         |
| Mobile   | 390×844  | stacking, no horizontal scroll, tap targets             |

Screenshots saved to `product-analysis/screenshots/<Pxx>_<viewport>.png`. Each screenshot is checked against the design
checklist:

1. Content constrained to a consistent max-width container; no stray full-bleed sections.
2. Consistent spacing scale (no arbitrary one-off margins/paddings clashing with siblings).
3. Header/sidebar heights and alignment identical across pages; active nav state correct.
4. Buttons/badges/inputs use Helm variants consistently; no raw unstyled controls.
5. Text overflow handled (truncate/ellipsis) for long titles/emails; no clipped labels at any locale spot-check (EN + RU
   minimum).
6. Empty/loading/error states visually distinct and centered per
   [20-error-empty-loading-states.md](20-error-empty-loading-states.md).
7. Contrast of badges/text on colored backgrounds legible in light AND dark theme (toggle theme on 3 representative
   pages).
8. Tables: column widths sane, no horizontal scroll at desktop; cards aligned in board columns.
9. Modals/dialogs centered, overlay dims content, focus visible.
10. No console errors/warnings during navigation (collected via Playwright console messages).

## 5. Execution packages

| Pkg        | Executor brief                                                                                                                                                | Uses                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **V1**     | Bootstrap env; run scenarios S-A, S-B, S-G; smoke every page in §2 (loads, no console errors); report defects                                                 | Playwright MCP (or e2e suite + curl)          |
| **V2**     | Scenarios S-D, S-E, S-F with two browser contexts; permission denials verified in UI **and** via direct API calls                                             | Playwright MCP multi-context (or e2e + fetch) |
| **V3**     | Capture all §2 screenshots at all three viewports + dark-theme spot checks; save under `product-analysis/screenshots/`; run design checklist, flag violations | Playwright MCP screenshots                    |
| **Review** | Product owner / main agent reviews captured screenshots (visual judgment), consolidates defect list                                                           | image reading                                 |

## 6. Defect log

<!-- populated by V1–V3; see entries below -->

## 7. Design review (main-agent review of captured screenshots)

Reviewed: P07, P08, P10, P11 (light+dark), P12, P13, P14, and P18 desktop captures in the captured `screenshots/`
directory. Overall verdict: clean, consistent Helm-based visual language; spacing/alignment rhythm is good; dark theme
legible. The issues below are functional-visual and should be fixed before polish passes.

| ID   | Sev   | Page(s)         | Finding                                                                                                                                                                                                                                                                                                       |
| ---- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR-1 | major | P10 P11 P12 P13 | **Status names render as raw enum keys** (`IN_PROGRESS`, `IN_REVIEW`, `REOPENED`, `DONE`) in board column headers, overview summary, table badges and the task-detail select. Statuses have human `name` fields — display those (e.g. "In Progress").                                                         |
| DR-2 | major | P11             | Confirms V3-1: multi-status column "IN_PROGRESS / REOPENED" duplicates every task also shown in the pure IN_PROGRESS column (4 vs 3 cards, same items). Column queries must be disjoint (statusIds union, not per-status overlap).                                                                            |
| DR-3 | major | P13             | Task-detail proportions: description/comments column is ~40% width with a large dead gutter before the side panel; each side-panel field sits in its own card making the page extremely tall. Fix: flexible main column (max-width container), compact side panel (grouped fields, no per-field card chrome). |
| DR-4 | minor | P12             | Search input pre-filled with the literal text `undefined` (V1-2/V3-8); Labels chips touch the table's right edge (add cell padding).                                                                                                                                                                          |
| DR-5 | minor | P10             | Status summary omits zero-count statuses (TODO 0 absent → total looks inconsistent); "View all tasks" / "View all members" rows render with a full-width tinted background in the default state — verify it is hover-only.                                                                                    |
| DR-6 | minor | P14             | Backlog group nests a single "View backlog" row inside the group — redundant double-nesting; make the group header itself the link.                                                                                                                                                                           |
| DR-7 | minor | P07             | On wizard pages (no sidebar) the header user name is clipped at the right viewport edge; give the header a right padding/inset in no-shell layouts.                                                                                                                                                           |
| DR-8 | minor | P08             | "My Tasks" empty state is bare centered text floating in a tall region — wrap in the standard empty-state component (icon + title + hint) used elsewhere.                                                                                                                                                     |
| DR-9 | info  | P11 dark        | Dark theme board: contrast and badge legibility are good; no action.                                                                                                                                                                                                                                          |

## 8. Consolidated fix priorities (post-verification)

1. **P0 — correctness**: V2-4 (project RBAC unenforced in production middleware — viewer escalation), V1-6/V3-1/DR-2
   (board DnD broken + column duplication), V2-1/V1-10/V3-3 (`tenants/undefined` on members pages), V1-3 (`?limit=NaN` +
   stale list), V2-2 (invitee account can't log in), V2-3 (decline wrong HTTP method), V2-7 (revoke/restore route
   mismatches), V1-8 (wrong-password error copy), V1-7 (sprint completion disposition dialog missing).
2. **P1 — visible polish**: DR-1 status display names, DR-3 task-detail layout, DR-4 `undefined` search + chip padding,
   V1-1/V3-4 missing i18n keys, V3-2 default-board hint key, V3-5 `settings/settings` back-links, V3-7 preferences route
   naming, V2-8 stale alert, V2-9 overview task links 404, V2-10 role-gated controls, DR-5/DR-6/DR-7/DR-8.
3. **P2 — later**: missing revoke-invitation route, member-facing "access expired" screen, board-reference warning path
   on status deletion, permanent-deletion job after grace period.

| ID    | Page/Flow                                     | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                           | Status         |
| ----- | --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| V1-1  | P08 tenant home                               | minor    | Missing i18n key `tenantHome.noPendingInvitations` — raw key rendered in "Pending invitations" card + console warning (EN locale)                                                                                                                                                                                                                                                                                                                     | open           |
| V1-2  | P12 tasks table                               | minor    | Search input is pre-filled with the literal string `undefined` on page load                                                                                                                                                                                                                                                                                                                                                                           | open           |
| V1-3  | P12 tasks table                               | major    | After creating a task the URL becomes `…tasks?limit=NaN` and the list is not refreshed — the new task is invisible until a manual reload (reproduced twice)                                                                                                                                                                                                                                                                                           | open           |
| V1-4  | P13 task detail                               | major    | Labels card is read-only — no UI to add/remove labels on an existing task; labels can only be chosen in the create-task dialog                                                                                                                                                                                                                                                                                                                        | open           |
| V1-5  | P13 task detail · relations                   | minor    | Relationship form requires the target task's raw UUID ("Target Task ID") instead of a task key (`ALPHA-2`) or picker; created relationship also displays the raw UUID                                                                                                                                                                                                                                                                                 | open           |
| V1-6  | P11 board                                     | major    | Drag-and-drop between board columns does not work: `ui-task-card` host sets `draggable: 'true'` which conflicts with the surrounding CDK drag (native drag cancels CDK pointer drag). Verified via Playwright trusted drag AND synthetic pointer events — card never moves. Multi-status prompt on column 1 therefore unverifiable                                                                                                                    | open           |
| V1-7  | P16 sprint detail                             | major    | Completing a sprint that still has unfinished tasks shows no disposition dialog — tasks silently remain attached to the completed sprint                                                                                                                                                                                                                                                                                                              | open           |
| V1-8  | P01 login                                     | major    | Wrong password shows "Your session has expired. Please sign in again." instead of a neutral invalid-credentials message (401 from `/api/auth/login` mapped to session-expiry copy)                                                                                                                                                                                                                                                                    | fixed-verified |
| V1-9  | P19/P21 project settings                      | minor    | "Back to Settings" links point to `…/settings/settings` (duplicated path segment)                                                                                                                                                                                                                                                                                                                                                                     | open           |
| V1-10 | P23 tenant members                            | major    | On direct URL load the page fires `GET /api/tenants/undefined/members` (active tenant not yet resolved) and renders "No members found." although members exist                                                                                                                                                                                                                                                                                        | fixed-verified |
| V1-11 | P25 public pages (/faq /docs)                 | minor    | Header shows "Sign in" link even when the user is authenticated (auth state not reflected on public-layout pages)                                                                                                                                                                                                                                                                                                                                     | open           |
| V2-1  | P23 tenant members                            | major    | Invite dialog POSTs to `/api/tenants/undefined/members/invite` (active tenant id not resolved on this page — same root cause as V1-10) → 403 for every invite; combined with "No members found." the entire membership-management UI is unusable. Owner-side actions had to be driven via API                                                                                                                                                         | fixed-verified |
| V2-2  | P05 accept-invitation                         | major    | Invitee that has no account yet gets a placeholder user (`passwordHash: ''`) at invite time; accept page then shows "You already have an account", skips password setup, and the user can never log in again (login → 401). Reproduced with member@t.local                                                                                                                                                                                            | open           |
| V2-3  | Pending-invitations landing                   | major    | "Decline" button fires `DELETE /api/invitations/:id` → 400; server exposes `POST /api/invitations/:id/decline`. No error toast (console only), invitation stays pending. Decline works when the correct endpoint is called directly                                                                                                                                                                                                                   | open           |
| V2-4  | Server RBAC · tasks/sprints/statuses/comments | critical | Project-level permissions not enforced: `projectRole` is never set in production middleware (only in tests). `deleteTask`, `updateTask`, sprint-create and status-create have no permission check; comment service resolves the caller role incorrectly. Result: a VIEWER successfully edited and deleted any task, created sprints and statuses, and wrote comments (verified via curl). Tenant OWNER/ADMIN bypass masks this in single-user testing | open           |
| V2-5  | Server RBAC · editor                          | major    | Inverse of V2-4: EDITOR cannot create tasks at all — `POST …/tasks` returns 403 "Requires 'create_task'" because `c.get('projectRole')` is always undefined, although the matrix allows editors to create/edit tasks                                                                                                                                                                                                                                  | open           |
| V2-6  | Server RBAC · PROJECT_ADMIN                   | major    | Promoting a tenant MEMBER to PROJECT_ADMIN grants nothing: project member add/role-change endpoints authorize against the tenant role only (`userRole` param = tenantRole), so a project admin gets 403 on `manage_project_members`                                                                                                                                                                                                                   | open           |
| V2-7  | P23 tenant members · revoke/restore/reinvite  | major    | Revoke-access flow broken end-to-end: UI calls `PATCH /api/tenants/:tid/members/:uid/revoke` which has no server route (service method `revokeAccess` is dead code). `restore`/`reinvite` routes expect the membership document id but the UI passes `member.userId` → restore always 404s. Revoke→"access expired"→restore lifecycle only verifiable at API level with a DB-assisted revoke                                                          | open           |
| V2-8  | P20 settings/statuses                         | minor    | Stale inline alert "This status is in use by existing tasks…" remains visible after the status was successfully deleted with a replacement                                                                                                                                                                                                                                                                                                            | open           |
| V2-9  | P10/P13 task links                            | minor    | "Recent Tasks" links on project overview use bare numeric ids (`…/tasks/3`) which the API rejects (only `KEY-NUMBER` or UUID supported) → 404 detail page; tasks-table row links use `/tasks/V2P-3` and work                                                                                                                                                                                                                                          | fixed-verified |
| V2-10 | P08/P12 role-gated controls                   | minor    | Write controls not hidden per role: VIEWER sees "New Task" on the tasks table; tenant MEMBER sees the "Create project" CTA on tenant home; Settings/Members nav shown to every tenant role. Server denies the writes, but the UI renders controls it should hide                                                                                                                                                                                      | open           |
| V3-1  | P11 board                                     | major    | Board renders duplicated cards: the combined first column "IN_PROGRESS / REOPENED" repeats every IN_PROGRESS task that is then shown again in its own "IN_PROGRESS" column (V2P-3/V2P-7/V2P-8 appear twice side-by-side). Column counts double-count tasks (4+3+1+1 = 9 headers vs 6 actual tasks). Visible desktop/tablet/mobile                                                                                                                     | open           |
| V3-2  | P20 settings/boards                           | minor    | Console warning "Missing translation for 'projectSettings.defaultBoardDeleteHint'" on the Boards settings page (EN locale) — raw-key i18n gap like V1-1                                                                                                                                                                                                                                                                                               | fixed-verified |
| V3-3  | P23 tenant members                            | major    | Recurrence of V1-10/V2-1 in current build: direct load fires `GET /api/tenants/undefined/members`, renders "No members found." despite 4 members; an invite attempt from this state POSTs to `/api/tenants/undefined/members/invite` → 403. Also triggered spuriously from other project pages (task detail)                                                                                                                                          | fixed-verified |
| V3-4  | P08 tenant home                               | minor    | Recurrence of V1-1 with empty data: for a user with zero pending invitations the card renders the raw key `tenantHome.noPendingInvitations` plus console warning (seen on freshly created v3-shots-workspace)                                                                                                                                                                                                                                         | open           |
| V3-5  | P19/P21 project settings                      | minor    | Recurrence of V1-9: "Back to Settings" links on General/Danger Zone still point to `…/settings/settings` (duplicated segment)                                                                                                                                                                                                                                                                                                                         | fixed-verified |
| V3-6  | P16 sprint detail · complete flow             | major    | Confirms V1-7 visually: completing an ACTIVE sprint containing an unfinished task shows no disposition dialog — sprint flips to COMPLETED instantly with the unfinished task still attached (screenshot `P16_sprint-completed-no-dialog_desktop.png`)                                                                                                                                                                                                 | open           |
| V3-7  | P24 user preferences                          | minor    | Route mismatch with plan inventory: `/profile/preferences` does not exist and redirects to tenant home; preferences live at `/settings`. Plan §2 should be corrected or a redirect added                                                                                                                                                                                                                                                              | fixed-verified |
| V3-8  | P12 tasks table · all viewports               | minor    | Recurrence of V1-2: search input is pre-filled with literal `undefined` on every fresh load of the tasks table (visible in all three viewport screenshots)                                                                                                                                                                                                                                                                                            | open           |

### V1 execution notes (2026-08-25)

- Environment: mongo rs0 healthy on `localhost:27017` (a stale standalone `mongod` container named `task-board-mongo`
  without `--replSet` had to be removed; after `docker compose up -d` the auto-initiated replica set advertised the
  container hostname — fixed via `rs.reconfig` to `localhost:27017`). Server: wrangler dev `http://localhost:8787`. UI:
  `http://localhost:4200`. Executor used Playwright MCP.
- S-A: pass except V1-2/V1-3/V1-4/V1-5. Seed verified via API: 5 statuses (TODO, IN_PROGRESS, IN_REVIEW, REOPENED,
  DONE), 3 types (Task, Bug, Story), default KANBAN board. Label case-insensitive reuse verified at API level (`bug` vs
  existing `Bug` → 409 DUPLICATE_LABEL).
- S-B: pass except V1-6/V1-7. Future sprint w/o dates → start (startDate set, endDate empty) → complete (endDate set) →
  reopen (overdue badge correct) → delete (task returned to backlog) all work.
- S-G: pass except V1-8. Reset URL appears in server console without RESEND_API_KEY; full reset cycle works; legacy
  `/tenants/:id` redirects to `/t/<slug>`.
- Page smoke P01–P25: all routes render with primary data; no blank screens. Not covered: P04 invalid-token submit state
  (form renders; server-side rejection assumed), P05 valid/expired invitation states (only invalid token tested), P11
  sprint-scoped board (`?sprintId=`), failed-move rollback via network throttle, S-B overdue-badge-on-edit (badge
  verified after reopen instead), P06 visitor landing while logged out (header state issue logged as V1-11).
- Console errors observed: one transient 404 resource load on first `/auth/register` visit (chunk race, not reproducible
  afterwards); expected 401/404 API errors from negative tests; warnings listed in V1-1 plus a ProseMirror `white-space`
  CSS warning from the milkdown editor (cosmetic).

### V2 execution notes (2026-08-26) — Invitations, permissions & lifecycle

Isolation approach: Playwright MCP exposes a single shared browser context (tabs do not isolate sessions), so per the
fallback in §1 the run used **session alternation** (logout/login or localStorage token swap between owner / editor /
viewer / decliner sessions) for UI checks plus **direct `curl` calls against http://localhost:8787 with per-user JWTs**
for the second user's permission checks. Invitation tokens were read from the server console (`[EMAIL] … Accept URL`,
ConsoleEmailService fallback). One DB-assisted step: revoke-access was simulated via a direct `tenant_members` status
update because no API route exposes it (V2-7).

S-D — Invitations & membership:

- Invite member@t.local: **fail in UI** (V2-1); pass via API. Tenant-level roles are ADMIN/MEMBER only — EDITOR is a
  project role, so "invite as EDITOR" was realized as tenant MEMBER + project EDITOR.
- Accept via invite link: pass (member lands in tenant home, role MEMBER badge) — but password setup skipped (V2-2).
- Re-invite another address + resend: pass. Old token → 404 ("Invalid or expired invitation." page), new token valid;
  reinvite rotates the token and flips membership back to ACCESS_REVOKED until accepted.
- Decline flow: messaging renders (pending-invitations landing with Accept/Decline), but the Decline action is broken
  (V2-3); decline passes when called via the correct API endpoint.
- Revoke invitation: **not verifiable end-to-end** — no server route exists for revoking a pending invitation (only hard
  remove). Service method `revokeInvitation` is unreachable dead code.
- Revoke ACTIVE access → restore: server semantics verified at API level (revoked member gets 403 "Your access to this
  tenant has been revoked"; restore with the membership id returns access to normal). UI path broken (V2-7); the "access
  has expired" screen for the affected user could not be exercised.
- Remove member from PROJECT → stays in tenant (members list still contains them) → re-add as EDITOR: pass (API).

S-E — Permissions matrix (second column = observed via curl with that user's JWT; UI control visibility noted):

| Role (context)                   | Action                        | Expected | Actual                                                                | Verdict              |
| -------------------------------- | ----------------------------- | -------- | --------------------------------------------------------------------- | -------------------- |
| EDITOR (tenant MEMBER)           | create task                   | allow    | 403                                                                   | FAIL (V2-5)          |
| EDITOR                           | edit task                     | allow    | 200 (after version bump by viewer)                                    | pass                 |
| EDITOR                           | delete task                   | deny     | 200 — task deleted                                                    | FAIL (V2-4)          |
| EDITOR                           | comment                       | allow    | 201                                                                   | pass                 |
| EDITOR                           | create label                  | allow    | 201                                                                   | pass                 |
| EDITOR                           | create status / type / board  | deny     | 400 validation first; status-create itself unchecked (see VIEWER row) | FAIL (V2-4)          |
| EDITOR                           | create sprint                 | deny     | 201                                                                   | FAIL (V2-4)          |
| EDITOR                           | add project member            | deny     | 403                                                                   | pass                 |
| EDITOR                           | create project                | deny     | 403                                                                   | pass                 |
| EDITOR                           | read tasks                    | allow    | 200                                                                   | pass                 |
| VIEWER                           | read tasks                    | allow    | 200                                                                   | pass                 |
| VIEWER                           | create task                   | deny     | 403                                                                   | pass                 |
| VIEWER                           | edit task                     | deny     | 200 — title changed to "hacked"                                       | FAIL (V2-4)          |
| VIEWER                           | delete task                   | deny     | 200 — task deleted                                                    | FAIL (V2-4)          |
| VIEWER                           | comment                       | deny     | 201                                                                   | FAIL (V2-4)          |
| VIEWER                           | create sprint / status        | deny     | 201 / 201                                                             | FAIL (V2-4)          |
| VIEWER                           | create project                | deny     | 403                                                                   | pass                 |
| VIEWER (UI)                      | write controls hidden         | hidden   | "New Task" button rendered                                            | FAIL (V2-10)         |
| MEMBER (tenant, no project role) | create project                | deny     | 403; CTA visible on tenant home                                       | partial FAIL (V2-10) |
| PROJECT_ADMIN (tenant MEMBER)    | manage project members        | allow    | 403                                                                   | FAIL (V2-6)          |
| Non-member (declined invite)     | GET projects w/ X-Tenant-Id   | deny     | 403                                                                   | pass                 |
| Non-member (UI)                  | direct URL to foreign project | no leak  | redirect to onboarding home, no data rendered                         | pass                 |

S-F — Destructive & lifecycle:

- Archive project: pass. ARCHIVED badge, "This project is archived and read-only." banner, writes blocked server-side
  (`PROJECT_ARCHIVED`), Restore returns project to ACTIVE.
- Delete project: pass. Typed confirmation required (button disabled until key typed), DELETION_PENDING banner with
  grace-period date ("Deletion scheduled for Sep 25, 2026"), Cancel Deletion restores ACTIVE. Permanent-deletion
  execution (URLs 404 afterwards) not testable within the grace period.
- Status deletion WITH task usage: pass with caveat. Deleting TODO without replacement → 409 + inline alert "…Select a
  replacement status before deleting."; with replacement IN_PROGRESS → task V2P-3 moved to IN_PROGRESS and board columns
  no longer reference the deleted status. Caveat: dialog presents "No replacement" as an option up front instead of
  forcing the choice when the status is in use.
- Status deletion WITHOUT task usage: deletion succeeds cleanly; the board-warning sub-path (status unused by tasks but
  referenced by a board column) could not be exercised — no such fixture existed and VSTAT was not board-referenced.
- User deletion: pass (API). Owner deletes the member user → memberships gone (member API calls 403), login 401,
  historical comment still shows `authorSnapshot.displayName: "member"`.

Items unverifiable / why:

- Revoke-pending-invitation messaging: no server route (dead service method).
- "Access has expired" member-facing state: revoke-access not reachable through API/UI (V2-7).
- Board-reference warning path on status deletion: requires a board column referencing a task-free status; not
  constructible in the available UI within this pass.
- Permanent project deletion & post-deletion 404s: 30-day grace period.

Environment/state note: verification created tenant `v2-workspace` (owner v2owner@t.local) with project V2P and users
editor@t.local / viewer@t.local / decliner@t.local (all `Passw0rd!23`). member@t.local is soft-broken by V2-2 and its
user record was deleted during the S-F user-deletion step. Test data left in place for V3 screenshotting.

### V3 execution notes (2026-08-26) — Screenshot capture

Executor used Playwright MCP against UI `http://localhost:4200` / server `http://localhost:8787`, logged in as owner
`v2owner@t.local`. Screenshots were saved under `product-analysis/screenshots/` (89 files, full-page). Viewports:
Desktop 1440×900, Tablet 768×1024, Mobile 390×844.

Seed data added for realistic renders (API): renamed leftover "hacked" task to a real title; created tasks V2P-4…V2P-8
across REOPENED/IN_REVIEW/DONE/IN_PROGRESS; labels `ux` + `v2label` attached to V2P-3/V2P-4; one comment on V2P-3;
ViewerSprint started then completed (to exercise the completion flow, see V3-6); fresh user v3shots@t.local + tenant
`v3-shots-workspace` created via the real registration/onboarding flow to capture P07 steps 1–4.

Coverage per page:

| Page                                  | Desktop             | Tablet     | Mobile     | Extra states                                                                                                    |
| ------------------------------------- | ------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| P01 login                             | ✔                   | ✔          | ✔          | forgot-password link visible                                                                                    |
| P02 register                          | ✔                   | ✔          | ✔          |                                                                                                                 |
| P03 forgot-password                   | ✔                   | ✔          | ✔          |                                                                                                                 |
| P04 reset-password                    | ✔ (invalid token)   | ✔          | ✔          | valid-token state not captured (no live token)                                                                  |
| P05 accept-invitation                 | ✔ (invalid/expired) | ✔          | ✔          | pending state not capturable logged-out (token lives in server console only); admin-side summary visible in P08 |
| P06 visitor landing                   | ✔                   | ✔          | ✔          | logged out                                                                                                      |
| P07 workspace/create                  | ✔ steps 1–4         | ✔ step 1   | ✔ step 1   | slug availability check exercised                                                                               |
| P08 tenant home                       | ✔ (+dark)           | ✔          | ✔          | My-Tasks empty widget + pending-invitations card                                                                |
| P09 projects                          | ✔                   | ✔          | ✔          |                                                                                                                 |
| P10 overview                          | ✔                   | ✔          | ✔          |                                                                                                                 |
| P11 board                             | ✔ (+dark)           | ✔          | ✔          | sprint-scoped `?sprintId=` desktop                                                                              |
| P12 tasks table                       | ✔ (+dark)           | ✔          | ✔          | create-task dialog, filtered-empty state                                                                        |
| P13 task detail                       | ✔ (+dark)           | ✔          | ✔          | edit mode; conflict dialog NOT reproducible cheaply (needs concurrent editor)                                   |
| P14 sprints list                      | ✔                   | ✔          | ✔          | Backlog/Future/Completed groups incl. completed sprint                                                          |
| P15 backlog                           | ✔                   | ✔          | ✔          |                                                                                                                 |
| P16 sprint detail                     | ✔                   | ✔          | ✔          | completed-no-dialog state (V3-6)                                                                                |
| P17 project members                   | ✔                   | ✔          | ✔          |                                                                                                                 |
| P18 settings hub                      | ✔                   | ✔          | ✔          |                                                                                                                 |
| P19 settings/general                  | ✔                   | ✔          | ✔          | locked key hint                                                                                                 |
| P20 statuses/task-types/labels/boards | ✔ all four          | ✔ statuses | ✔ statuses | replacement/delete flows covered in V2                                                                          |
| P21 danger zone                       | ✔                   | ✔          | ✔          | typed-confirmation dialog open (`P21_delete-confirmation-dialog_desktop.png`)                                   |
| P22 tenant settings                   | ✔                   | ✔          | ✔          |                                                                                                                 |
| P23 tenant members                    | ✔                   | ✔          | ✔          | broken undefined-tenant state documented (V3-3)                                                                 |
| P24 preferences                       | ✔                   | ✔          | ✔          | actual route `/settings` (V3-7)                                                                                 |
| P25 help (/faq)                       | ✔                   | ✔          | ✔          | /docs & /support exist but not separately captured                                                              |

Dark-theme spot checks (desktop, `_dark` suffix): P08, P11, P12, P13. Theme toggled via Preferences → Dark → back to
Light; preference persisted across reloads.

Mobile horizontal overflow: checked programmatically (`document.scrollWidth > innerWidth`) on P08–P13, P15–P18, P20–P23,
P25 — **no page overflows**; the tasks/members tables compress rather than scroll (columns get very tight at 390px but
remain usable).

Console errors/warnings collected during navigation:

- Missing i18n keys: `projectSettings.defaultBoardDeleteHint` (P20 boards), `tenantHome.noPendingInvitations` (P08 empty
  state) — logged as V3-2/V3-4.
- Repeated `GET /api/tenants/undefined/members` on P23 direct load (and spuriously from task detail) — V3-3.
- One `POST /api/tenants/undefined/members/invite` → 403 observed when invite dialog opened from broken P23 state.
- Expected 404s from negative tests only (invalid invitation/reset tokens). No unexpected JS exceptions.
- Transient single `GET /api/auth/me → 404` blip during one navigation (not reproducible, dev-server race).

Design checklist quick verdicts (full visual judgment deferred to Review package):

1. Max-width container consistent — pass on all pages/viewports.
2. Spacing rhythm — pass, no obvious one-offs spotted.
3. Header/sidebar alignment + active nav — pass on desktop/tablet; sidebar collapses correctly on mobile.
4. Helm variants consistent — pass; no raw controls seen.
5. Text overflow/truncation — pass for long task titles/emails at all viewports.
6. Empty/loading/error states distinct — pass (filtered-empty table, no-members, invitation-error all render dedicated
   states).
7. Contrast light/dark — no obvious violations in dark spot checks; final call with Review package.
8. Tables sane at desktop — pass; board column duplication issue is logic-level (V3-1), not CSS.
9. Modals centered/dimmed/focus-visible — pass (create-task, delete-confirmation dialogs).
10. Console clean — fail (see V3-2/V3-3/V3-4 warnings above).

### V4 execution notes (2026-08-26) — Robustness QA (R-1…R-6)

Environment: UI `http://localhost:4200`, server `http://localhost:8787`, mongo docker. Owner `v2owner@t.local` (tenant
`v2-workspace`, project `V2P`), fresh users `v4qa@t.local` / `v4fresh@t.local` (`Passw0rd!23`). API checks via
python/curl with owner JWT; UI via Playwright MCP (single shared context, session alternation for the conflict test).
~65 tasks created in V2P for R-4 stress; payload tasks V2P-11…V2P-19 for R-2/R-3; sprint "V4 Completion Sprint" for the
completion-flow check; workspace `v4-qa-workspace` + project `V4S` via the real S-A flow.

**Showstopper found at bootstrap**: the app rendered a **blank page on every URL** —
`NG04014: Invalid configuration of route 'settings': redirectTo and canActivate cannot be used together`
(`app.routes.ts` — the V3-7 preferences-redirect fix added `canActivate` to a `redirectTo` route). With user approval
this one-line regression was fixed during the round (V4-1, `canActivate` removed; the `profile/preferences` target
already carries `authGuard`); all subsequent verification ran against the fixed build.

R-1 Length limits — **pass with defects**:

- Server caps all correct: title 255 accepted / 256 → 400 `VALIDATION_ERROR` ("Task title must be at most 255
  characters"); description 5000 accepted (cap 10000); comment 2000 accepted / 5001 → 400; label 100 accepted / 101 →
  400; workspace name 100 chars → slug truncated to exactly 48, normalized, valid; 60-char email local part registers
  fine; project name 200 accepted.
- UI: task detail renders the 5000-char markdown description and 2000-char comment without layout blowout. Defects: no
  client-side maxlength/inline validation on the task title (V4-3); server validation error surfaces as raw i18n key
  `errors.validation` (V4-4); long unbreakable project name blows out the overview header (V4-2).

R-2 Pathological strings — **pass**:

- No-space 200-char, emoji 🚀🔥, RTL `مرحبا بالعالم`, CJK `日本語テスト`, `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>` all stored (201) and rendered as inert text in table, board cards and task detail —
  zero script tags / injected imgs in the DOM, no console errors, no alert() fired.
- Markdown injection `[x](javascript:alert(1))` renders as a link with **empty href** (sanitized, not clickable to
  `javascript:`); raw `<img onerror=…>` shown as literal text in description and comments.
- Slug: `My Workspace!!` → `my-workspace` (normalized); explicit invalid slug via API → clean 400; unicode-only name
  (`日本語 ワークスペース 🚀`) → 409 `SLUG_TAKEN` "Tenant name cannot be converted to a valid slug" — works but wrong
  status code/semantics (V4-6).

R-3 Special characters — **pass**:

- UI create-task trims title before POST (`title.trim()`); server stores untrimmed via direct API (info only).
- Quotes/backslash/newlines title stored and rendered safely (newline collapsed in table cell, fine).
- Label dedup is case- AND whitespace-insensitive: `Bug` → 201; `Bug ` and `bug` → 409 `DUPLICATE_LABEL`.

R-4 Table stress — **pass with defects**:

- 63 tasks: pagination renders 4 pages (20/page) with URL sync (`?page=2`), page-size selector offers
  Auto/10/20/30/50/70/100; Auto computes limit from viewport (5 in the headless run), persists via
  `PUT /api/preferences`, repaginates (13 pages).
- Sort by title works (`?sort=title:asc`, correct binary order incl. leading-space title first); column widths stable
  (fixed layout) — but the Title header itself is broken (V4-8). Filter chip "Status: Done" appears with remove button,
  URL gains `status=<id>`, short last page keeps filler row (no collapse). Defects: V4-7 (undefined search regression),
  V4-8 (Title header 0-width/overlap), V4-9 (combobox shows lowercase "auto"), V4-10 (Filters dialog has no filter
  fields despite its copy).

R-5 Concurrent edit — **pass**:

- Session A (UI) opened edit on V2P-6; session B (API) saved a title change (version 1→2); A saved → 409 → "Version
  Conflict" dialog with "Reload Task"; reload shows B's title; A's edit discarded, B's change intact.

R-6 Regression smoke — **mixed**:

- S-A (register → welcome → workspace wizard steps 1–4 → tenant home → create project → create task): **pass**. Success
  toasts, no `?limit=NaN`, no `undefined` requests, empty states render real copy (V3-4 key fixed). Note: project Key is
  not auto-suggested from the name (minor UX gap, not logged as defect).
- S-G: logout works; wrong password shows neutral **"Invalid email or password."** (V1-8 fix holds).
- Members: tenant members page loads with correct tenant id — **no `tenants/undefined`** (V1-10/V2-1/V3-3 fixed); shared
  member table with Change role / Revoke / Restore / Resend on tenant table and Change role / Remove on project table
  (U4 verified, role dialog opens on both).
- Status display names everywhere (board headers, table badges, selects) — DR-1 fix holds.
- S-B: **fail** — "Start Sprint" on a FUTURE sprint immediately COMPLETES it (V4-11, critical regression from the V1-7
  fix); the completion disposition dialog could not be exercised because of it. Board DnD / empty-column placeholder /
  multi-status prompt not verifiable via Playwright MCP (same trusted-input limitation as V1; owner verified manually
  last round). Board column duplication (V3-1/DR-2) confirmed still present (V4-12).

Items not verifiable / why:

- Sprint completion disposition dialog: blocked by V4-11 (start path never yields an ACTIVE sprint to complete).
- Board drag-and-drop, empty-column drop zone, multi-status prompt: CDK pointer-drag not reliably synthesizable via
  Playwright MCP (V1-6 precedent; manual owner verification recommended).
- Failed-move rollback via network throttle: skipped (low value this round).
- Password-reset full cycle: verified in V1 (console fallback); not re-run.

New defects (V4):

| ID    | Page/Flow                | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status         |
| ----- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| V4-1  | App bootstrap (all URLs) | critical | `NG04014` — route `settings` in `app.routes.ts` declared with both `canActivate` and `redirectTo` (introduced by the V3-7 preferences-redirect fix); router config validation throws at bootstrap and the entire app renders a **blank page** on every URL. **Fixed during V4** by removing `canActivate` (target route already guarded).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | fixed          |
| V4-2  | P10 project overview     | major    | Header does not constrain long unbreakable project names: a 200-char name expands the header row to ~2981px (no `truncate`/`min-w-0`); the Sprints/Settings action buttons are pushed off-screen and unreachable (overflow clipped by an ancestor, so no scrollbar either). Needs ellipsis + flexible title container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | fixed-verified |
| V4-3  | Tasks new / edit         | minor    | Task title input has no `maxlength` and no inline max-length validation — 256 chars are accepted silently until submit fails with a server 400. Add `maxlength=255` or a signal-form validator with inline error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | fixed-verified |
| V4-4  | Tasks new                | minor    | Server validation failure renders the raw i18n key `errors.validation` in the destructive alert — `create-task.html` binds `{{ error() }}` (a transloco key returned by `getErrorMessage`) without the `transloco` pipe. The key exists in all locales; only the binding is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | fixed-verified |
| V4-5  | Tasks new                | info     | Default status preselect matches `name === 'todo'`; projects without a To Do status (e.g. V2P after the V2 deletion test) fall back to the first status ("In Progress"). Fresh projects default correctly to "To Do". Consider a persisted project default-status field instead of name matching. CLOSED by R3-P1: preselection is now id-based — `project.defaultStatusId` when present among the loaded statuses, else first status by position; default type = first type by position (no name matching anywhere).                                                                                                                                                                                                                                                                                                     | fixed-verified |
| V4-6  | Workspace create (API)   | minor    | Tenant create with a unicode-only name returns `409 SLUG_TAKEN` ("Tenant name cannot be converted to a valid slug") — semantically a validation failure; should be `400 VALIDATION_ERROR` so the UI maps it to a field error rather than a conflict toast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | fixed-verified |
| V4-7  | P12 tasks table          | major    | **REGRESSION of V1-2/V3-8**: search input is again pre-filled with the literal string `undefined` on every fresh load of the tasks table (reproducible). The U6b fix did not hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | fixed-verified |
| V4-8  | P12 tasks table          | major    | Title column `<th>` has no width class in the fixed table layout → computes to **0px**; the adjacent "Type" header overlaps the Title sort button (visually garbled "TType") and intercepts pointer events — **Title sort is unclickable by mouse** (works only via keyboard/JS). Sort logic itself is correct. Root cause (found V6): `table-fixed` ignores `min-width`, so the fix-round-2 `w-[30%] min-w-[200px]` could never work — the ten fixed-px columns already overflowed the container. Fixed during V6 by removing `table-fixed` from the tasks table (`task-table.html`, one-line blocker fix); auto layout + per-cell `truncate` keeps widths stable and honors the Title `min-width`. Verified at 1440 AND 1280: Title th = 200px, trusted mouse click navigates with `sort=title:asc`, no header overlap. | fixed-verified |
| V4-9  | P12 tasks table          | minor    | After selecting "Auto", the page-size combobox displays lowercase `auto` (raw value) instead of the option label "Auto".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | fixed-verified |
| V4-10 | P12 filters dialog       | minor    | Filters dialog copy promises "Filter tasks by status, priority, assignee and more" but the dialog contains only Saved-Filter management; actual filtering lives in per-column funnel icons — misleading empty dialog. Either add the filter controls or fix the copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | fixed-verified |
| V4-11 | P16 sprint detail        | critical | **REGRESSION introduced by the V1-7 fix**: "Start Sprint" (FUTURE→ACTIVE) runs the _complete_ flow — `completeSprint()` hardcodes `status: COMPLETED` (`sprint-detail.ts`) and is called for every transition. Result: starting a sprint instantly COMPLETES it (startDate null, endDate set) and silently moves unfinished tasks to backlog without the disposition dialog. Reproduced via UI + confirmed via API.                                                                                                                                                                                                                                                                                                                                                                                                       | fixed-verified |
| V4-12 | P11 board                | major    | Confirms V3-1/DR-2 still open after the U-round: combined column "In Progress / Reopened (61)" repeats every card also rendered in "In Progress (60)" — 123 cards for 62 tasks. Column queries still overlap; the disjoint-column fix was not implemented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | fixed-verified |

Fix-round priorities from V4: V4-11 (critical, sprint lifecycle broken), V4-7 + V4-8 (major, tasks-table features
broken), V4-2 (major, header blowout), then the minor copy/validation items V4-3/V4-4/V4-6/V4-9/V4-10 and info V4-5.

### V5 execution notes (2026-08-26) — Re-verification round

Environment unchanged (UI :4200, server :8787, mongo docker). Owner `v2owner@t.local`, fresh users `v5qa@t.local`
(tenant `v5-smoke-workspace`, project `V5S`) and invitee `v5member@t.local`. API checks via curl JWTs; UI via Playwright
MCP.

Focus 1 — V4 fix verification matrix:

| Fix   | Verdict  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V4-11 | PASS     | Start Sprint on FUTURE sprint S2 sent `{status: ACTIVE}` → sprint ACTIVE, startDate set, endDate null, unfinished tasks stayed assigned. Complete with 2 unfinished tasks opened the disposition dialog (Backlog default); tasks moved to backlog (sprintId null), Done task stayed; sprint COMPLETED with endDate. Empty sprint S3 completed directly without dialog.                                                                     |
| V4-12 | PASS     | Board columns disjoint: "In Progress / Reopened (1)" held only the REOPENED task; "In Progress (59)", "In Review (1)", "Done (2)". Total cards 63 == total tasks; zero duplicate keys (programmatic DOM check).                                                                                                                                                                                                                            |
| V4-7  | PASS     | Search input empty on fresh load of `/tasks` (no `?search=`), placeholder only.                                                                                                                                                                                                                                                                                                                                                            |
| V4-8  | REOPENED | Title `<th>` still computes **0px** (`min-w-[200px] w-auto` is ineffective under `table-fixed` when the other explicit widths sum ≥ available width); Playwright trusted click on the Title sort button times out — `<span>Type</span>` intercepts pointer events. Sort logic itself works (URL `sort=title:*`). Needs real width redistribution (e.g. drop fixed px on enough columns or set Title `width:auto` with smaller fixed sums). |
| V4-2  | PASS     | R1LONG (200-char name) overview header clamps (`break-words line-clamp-2` inside `min-w-0 flex-wrap` container); no horizontal overflow; Sprints/Settings actions visible and clickable.                                                                                                                                                                                                                                                   |
| V4-3  | PASS     | `maxlength=255` present on create (`tasks/new`) AND edit (task detail) title inputs; 256-char fill truncates to 255 client-side.                                                                                                                                                                                                                                                                                                           |
| V4-4  | PASS     | `create-task.html` binds `{{ error()                                                                                                                                                                                                                                                                                                                                                                                                       | transloco }}`; `errors.validation` resolves to human copy in en.json (runtime trigger not reachable anymore because maxlength blocks oversize titles client-side). |
| V4-6  | PASS     | Unicode-only tenant name → `400 VALIDATION_ERROR` "Workspace name must contain letters or numbers" (no longer 409 SLUG_TAKEN).                                                                                                                                                                                                                                                                                                             |
| V4-9  | PASS     | Page-size combobox displays "Auto" after selecting Auto.                                                                                                                                                                                                                                                                                                                                                                                   |
| V4-10 | PASS     | Filters dialog renders actual filter fields (Search/Status/Type/Priority/Assignee/Reporter/Sprint/Label) + Saved Filters; Apply sets `?status=Done` + chip + filtered table; Clear removes param/chip and restores list.                                                                                                                                                                                                                   |

Focus 2 — regression smoke:

- **S-A PASS**: register v5qa@t.local → auto-login → welcome → wizard steps 1–4 (slug autogen + availability check) →
  tenant home → create project V5S (toast) → task created via `tasks/new` (default status To Do) → navigated to `V5S-1`
  detail → visible in tasks table. No `?limit=NaN`, no `undefined` requests.
- **S-B partial**: board renders 4 columns with display names and empty-column placeholders; DnD move / multi-status
  prompt NOT verifiable via Playwright MCP (same CDK trusted-input limitation as V1/V4 — manual owner verification still
  required).
- **S-D abbreviated PASS** except V5-2 below: UI invite (correct tenant id, toast, "Invitation pending" row) → accept
  via emailed link (auto-login, MEMBER badge) → role edit Member→Admin via Change-role dialog (PATCH 200, toast) →
  Remove member (confirm dialog, DELETE 200).
- **S-G PASS**: logout returns to login; wrong password shows neutral "Invalid email or password."

Focus 3 — fresh-eyes sweep: tenant home, project overview, board, tasks, task detail, sprints, backlog, project members,
tenant members, settings hub, settings/general (+ back-link correct), settings/boards (no missing-key warning; default
board Delete disabled), tenant settings, preferences (`/settings` → `/profile/preferences`). No horizontal overflow, no
raw i18n keys, no console errors/warnings during navigation (only the expected 401 from the wrong-password test).

New defects (V5):

| ID   | Page/Flow                    | Severity | Description                                                                                                                                                                                                                                                                                                                                            | Status         |
| ---- | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| V5-1 | P16 sprint completion dialog | minor    | Disposition-dialog copy renders the raw interpolation placeholder `{count}` ("{count} task(s) are not done yet…") instead of the actual number — transloco params not passed.                                                                                                                                                                          | fixed-verified |
| V5-2 | P05 accept-invitation        | major    | Recurrence of V2-2: inviting an email with NO account still creates a placeholder user; accept page says "You already have an account", offers no password setup, auto-logs-in once, and any later login attempt returns 401 — the account is permanently unusable after the session ends. Reproduced with v5member@t.local.                           | fixed-verified |
| V5-3 | P24 preferences              | info     | Theme/Zoom/Language comboboxes display raw stored values ("light", "100", "en") rather than human labels ("Light", "100%", "English"). Cosmetic.                                                                                                                                                                                                       | fixed-verified |
| V6-1 | P08/P14 interpolated counts  | minor    | Transloco params interpolate but leave literal braces: tenant home shows "{2} invitation(s) awaiting acceptance"; sprints list shows "{63} tasks" / "{4} sprints". Locale strings use single-brace `{count}` placeholders where transloco expects `{{ count }}` (or the pipe call passes params incorrectly). Cosmetic copy bug, no functional impact. | open           |

Verdict: **needs one more targeted round** — V4-8 (Title column/sort clickability) and V5-2 (invitee-without-account
flow) remain user-blocking; V5-1/V5-3 are trivial copy fixes.

### V6 execution notes (2026-08-26) — Final targeted re-verification

Environment unchanged (UI :4200, server :8787, mongo docker). Owner `v2owner@t.local`, fresh invitee `v6member@t.local`
(`Passw0rd!23`). API checks via curl JWTs; UI via Playwright MCP at 1440×900 and 1280×900.

One-line blocker fix applied during this round (justified): **V4-8** had failed two fix attempts because `table-fixed`
ignores `min-width` — the ten non-Title columns' px widths (sum 1120px) exceeded the table container (928px at 1280), so
the Title `<th>` mathematically could never get width while fixed layout was active. Removed `table-fixed` from
[`ui/src/app/features/tasks/task-table/task-table.html`](../ui/src/app/features/tasks/task-table/task-table.html)
(single class) and updated the corresponding spec assertion in
[`task-table.spec.ts`](../ui/src/app/features/tasks/task-table/task-table.spec.ts). All other cells keep `truncate`, so
ellipsis behavior and sane widths are preserved. Full UI suite re-run after the change: **52 files / 582 tests PASS**;
eslint + typecheck clean.

Verification matrix:

| Item | Verdict | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V4-8 | PASS    | Title `<th>` = 200px at BOTH 1440 and 1280 (`elementFromPoint` over its center resolves to its own span); Playwright trusted mouse click navigates to `?sort=title:asc` with correctly ordered rows; other columns 56–120px, no header overlap.                                                                                                                                                                                                                                           |
| V5-2 | PASS    | Owner invited brand-new `v6member@t.local` via UI dialog → accept link (from console-email fallback) shows **"Create Account & Accept"** form (Display Name + Password + Confirm) → submit → POST `/api/auth/accept-invitation` 200 → auto-logged-in as MEMBER on tenant home → sign out → login with chosen password → **200**, lands in workspace. Registered invitee (`v5qa@t.local`) gets the simple path: "You already have an account…" + single Accept button, NO password fields. |
| V5-1 | PASS    | New FUTURE sprint + 2 unfinished tasks → Start Sprint sent ACTIVE (startDate set, endDate null) → Complete Sprint opened disposition dialog showing "**2 task(s) are not done yet.**" (real count, no `{count}`) → confirm moved both tasks to backlog (Tasks (0)), sprint COMPLETED with endDate.                                                                                                                                                                                        |
| V5-3 | PASS    | Preferences triggers show human labels: Theme "Light"/"Dark"/"Light 1"/"Light 2", Zoom "100%", Language "English".                                                                                                                                                                                                                                                                                                                                                                        |

Regression quick-pass:

- Tasks table: Priority sort by mouse → `?sort=priority:asc`, LOW first; Filters dialog Apply Status=Done → chip
  "Status: Done" + URL param + filtered list (2 items); chip remove restores list; page-size combobox labeled "Auto";
  search input empty on fresh load; no `undefined` anywhere.
- Board: columns disjoint — "In Progress / Reopened (1)" [only the REOPENED task] + "In Progress (59)" + "In Review (1)"
  - "Done (2)" = 63 == total tasks, zero duplicate keys; human status names in all headers; empty-column placeholders
    verified in V5 (no empty column existed this round).
- Sprint lifecycle: start → ACTIVE (not completed); complete-with-unfinished → dialog with real count (above).
- Login: wrong password → neutral "**Invalid email or password.**"
- Console across all visited pages: clean except the expected 401 from the wrong-password test. No i18n missing-key
  warnings, no `tenants/undefined` requests.

New finding: **V6-1** (minor/cosmetic, open) — literal braces around interpolated counts on tenant home ("{2}
invitation(s) awaiting acceptance") and sprints list ("{63} tasks", "{4} sprints"); see row above.

Info note (not a defect regression): the tasks-table container scrolls horizontally at 1280/1440 because the sum of
column minimums (~1193px) exceeds the ~928px container — pre-existing behavior (was 1120px before the V6 fix).

**Final verdict: CLEAN for all P0/P1 items of the cycle** — V4-8, V5-1, V5-2, V5-3 all fixed-verified; every previously
user-blocking defect is closed. Remaining known issues are cosmetic minors only: new V6-1 (brace artifacts) and info
V4-5 (default-status name matching). Servers left running.

### V7 execution notes (2026-08-26) — Round-3 verification (33 §2 P1–P9)

Environment: mongo rs0, wrangler dev :8787, ng serve :4200 (1440×900 primary; 700px height check for P3). Fresh user
`v7r3@taskboard.test` registered through the wizard; project `V7R` created; all checks driven via Playwright MCP.

Per-package results:

| Pkg | Verdict                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **PASS**                                                                      | Discriminator built in Settings → Statuses: "Done" moved to position 0 and "To Do" renamed "Backlog" → tasks/new preselects **Backlog** (= `project.defaultStatusId`, id-based), NOT "Done" (first-by-position fallback) — proves the V4-5 fix.                                                                                                                                                                                                                           |
| P2  | **PASS** (DOM-state verification; pointer-drag remains manual-check per V1-6) | Toggled `dragInProgress` via component debug (`ng.getComponent`): during drag each EMPTY column renders a card-sized (80px) dashed drop slot at the TOP (`data-drop-zone`, first child), "No tasks in this column" hidden; on drag end placeholder returns, slots removed.                                                                                                                                                                                                |
| P3  | **PASS**                                                                      | 255-char unbreakable title (server caps at 255): title cell fixed 200px, nowrap + ellipsis + native tooltip, no page h/v scroll. Auto mode: limit recomputed 13 @900px → 9 @700px on window resize (ResizeObserver); scroller bottom 828/628, pagination bottom 868/668 — layout tracks viewport, no dead space beyond the constant 32px page padding.                                                                                                                    |
| P4  | **PASS** (after V7-3 blocker fix below)                                       | Chooser popover lists all 11 columns; Key/Title checkboxes disabled+checked. Reporter toggle removes/adds the column live and persists across reload (PATCH 200 + GET 200 after fix). Header right-click → context menu with "Select columns…" + "Hide this column"; hide works and persists.                                                                                                                                                                             |
| P5  | **PASS** with one gap (see V7-4b)                                             | No Edit button; title click-to-edit with ✓/✕ + Enter/Escape (Enter saved, PATCH 200); description click → Milkdown with explicit Save/Cancel (saved 200); priority badge + select show title-case "Medium"; labels add (create inline) / remove (×) directly in side panel; long-title header: key whitespace-nowrap single line, title line-clamp-2 (exactly 2 lines measured), badge on its own row under title. Gap: board-card chips still render raw MEDIUM (V7-4b). |
| P6  | **PASS**                                                                      | `/auth/login` and `/auth/register`: scrollHeight == clientHeight == 900, no vertical scrollbar.                                                                                                                                                                                                                                                                                                                                                                           |
| P7  | **PASS with defect V7-4**                                                     | Real table Time·Actor·Action·Entity·Changes; Time sort toggle refetches (`?sort=desc`); Action/Entity/Actor filter comboboxes; diffs human-readable ("name: To Do → Backlog"); zero raw UUIDs on page; history icon inside the heading row. Defect: task entity label renders `TASK-2` instead of `V7R-2`. Pagination component not mounted at ≤1 page (only 9 events) — not falsifiable this round.                                                                      |
| P8  | **PASS** with cosmetic V7-5                                                   | Settings shows Date format (DD/MM/YYYY · MM/DD/YYYY · YYYY-MM-DD) + Time format (24h · 12h); selecting MM/DD/YYYY + 12h PUTs 200 and tasks table renders "08/26/2026 1:01 PM", task detail "Created 08/26/2026 12:53 PM". Cosmetic: unset selects render an empty trigger; selected time format trigger shows stored value "12h" not the option label.                                                                                                                    |
| P9  | **PASS with minor V7-6**                                                      | Buttons, select triggers, pagination items, table rows all computed cursor:pointer. Gap: sortable column-header buttons (Key/Title/…) compute `default`.                                                                                                                                                                                                                                                                                                                  |

Regression quick-pass:

- Register fresh user → workspace wizard → project create → task via tasks/new (redirect to detail, toast) → inline
  title edit → sprint start (ACTIVE) → complete-with-unfinished-task → **disposition dialog shown** (V1-7/V3-6 fix
  holds), confirm moved task out, sprint COMPLETED → members page loads with real tenant id, **no `tenants/undefined`**
  (V1-10/V2-1/V3-3 hold) → logout → login OK.
- Console: clean apart from missing-i18n warnings (V7-1) and the two defects' own request failures.

New defects (V7):

| ID   | Page/Flow                                                            | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status         |
| ---- | -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| V7-1 | Wizard / tenant home / sidebar / tasks-new / sprints / sprint-detail | minor    | Broad i18n regression: entire namespaces missing from en.json — createWorkspace.slug/plan/checkout/confirmation + continue/back, tenantHome (whole section), taskCreate (title/status/priority/labels/create…), taskDetail.editTitle/editDescription, sidebar.projectSettings, pagination.auto, boardView.allTasks, sprints.backlog, sprintDetail.moveToBacklog/completeAndMove, taskCreate.noLabelsFound/createLabel/removeLabelAria. Raw keys rendered + console warnings on nearly every page. Recurrence of the V1-1/V3-4 class at larger scale. **V8 residual**: `projectSettings.taskTypes/taskTypesDesc/statuses/statusesDesc/labels/labelsDesc` were still missing from ALL 11 locales (raw keys + console warnings on the settings hub); fixed during V8 as a data-only blocker fix (6 keys added to every locale file), re-verified clean. | fixed-verified |
| V7-2 | Tasks table · Auto page size                                         | minor    | Selecting "Auto" persists pageSize: 0 (sentinel, task-table.ts) but PUT /api/preferences schema requires min(5) → 400; Auto preference never survives a reload (combobox reverts to 20). Schema/sentinel mismatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | fixed-verified |
| V7-3 | Project preferences (P4/P8 persistence)                              | critical | PATCH/GET /api/projects/:id/preferences 500: upsert $setOnInsert omitted createdAt, so toDomain crashed on undefined.toISOString() — column-visibility (and any project-preference) writes AND reads failed. **Fixed during V7 as a one-line-class blocker** (user-preferences.repository.ts: createdAt: now in $setOnInsert + tolerant toDomain for already-persisted docs); re-verified: PATCH 200, toggle survives reload. Typecheck/tests(7)/lint green.                                                                                                                                                                                                                                                                                                                                                                                         | fixed-verified |
| V7-4 | Audit log entity labels                                              | minor    | Task events render "TASK TASK-2" instead of "V7R-2": audit-enrichment.service.ts builds keys from projectKeyById, but project ids are only collected from PROJECT-entity events — never from fetched task rows — so the 'TASK' fallback always wins for TASK entities. Also (b) board-card priority chips still show raw MEDIUM (title-case sweep missed the board card).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | fixed-verified |
| V7-5 | Settings · date/time format                                          | info     | Date/Time format comboboxes render an empty trigger when unset (no default label like "DD/MM/YYYY"); chosen time format trigger displays stored value "12h" instead of option label "12-hour (AM/PM)" (V5-3 class). Functionality itself works end-to-end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | fixed-verified |
| V7-6 | Tasks table header sort buttons                                      | info     | Sortable column-header buttons compute cursor: default — missed by the P9 primitive sweep (plain buttons styled as text).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | fixed-verified |
| V7-7 | Sprints · create with dates                                          | major    | Creating a sprint with start/end dates from the UI always 400s: UI sends new Date(...).toISOString() (full datetime) while CreateSprintSchema uses z.iso.date() (YYYY-MM-DD only). Dialog shows generic "Please check your input and try again." Sprint creation only works dateless or via API. Regression risk introduced with the R3 form work. Note (V8): sprint dates have NO edit control anywhere in the UI (pre-existing gap, not a regression of this fix); date edits were verified at API level (PATCH 200 valid / 400 "endDate must be >= startDate" for invalid ordering).                                                                                                                                                                                                                                                              | fixed-verified |

Info notes:

- P1 has no direct UI control for changing defaultStatusId; verification used the equivalent in-settings mutation
  (rename + reorder) to construct a discriminator — see P1 row.
- Audit pagination could not be exercised (single page of data); component presence deferred to fix-round re-check.

**Final verdict: FIX ROUND NEEDED** — all nine R3 packages functionally verified; one critical blocker (V7-3) was fixed
inline and re-verified. Remaining: V7-7 (major, sprint creation broken from UI), V7-1 (broad i18n), V7-2 (Auto page-size
persistence), V7-4 (audit task labels + board chip case), plus info items V7-5/V7-6. Servers left running.

### V8 execution notes (2026-08-26) — Final re-verification

Environment unchanged (mongo rs0, wrangler dev :8787, ng serve :4200, Playwright MCP at default viewport). Fresh user
`v8final@taskboard.test` (`Passw0rd!23`) registered through the real wizard; tenant `v8-final` ("V8 Final Workspace"),
project `V8V` created via UI; task V8V-1 created via `tasks/new`; sprint "V8 Sprint Dates" used for lifecycle checks.

One data-only blocker fix applied during this round (justified): **V7-1 residual** — the settings-hub links rendered raw
keys `projectSettings.taskTypes/taskTypesDesc/statuses/statusesDesc/labels/labelsDesc` with console warnings because
those six keys were missing from ALL 11 locale files. Added the six keys to every locale
(`ui/public/assets/i18n/*.json`, pure JSON data, no code change); re-loaded page renders "Task Types / Statuses /
Labels" with descriptions and zero warnings.

Verification matrix:

| Item | Verdict                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V7-7 | PASS                               | Create-sprint dialog with Start 2026-09-10 / End 2026-09-01 → 400 + inline alert "Please check your input and try again." (clean error, dialog stays open); corrected End 2026-09-25 → POST 201, sprint listed FUTURE "2026-09-10 — 2026-09-25". Date EDIT: no UI control exists anywhere (pre-existing gap, not part of V7-7) — verified at API level: PATCH `{startDate,endDate}` → 200 (dates reflected in UI header), invalid ordering → 400 `"endDate must be >= startDate"`. |
| V7-1 | PASS (after V8 residual fix above) | Full sweep register → wizard steps 1–4 → tenant home (empty states render real copy: "No tasks assigned to you", "No pending invitations") → tasks/new (all labels English) → project settings hub → members → sprints → audit → tasks table: no missing-i18n console warnings after the six-key fix; overdue badge key present in sprints list copy. Console across the whole session: clean (only vite debug + Angular dev-mode notice).                                         |
| V7-2 | PASS                               | Selecting Auto → PUT /api/preferences **200** (no 400), limit recomputed (13/14 @ viewport); full page reload → combobox still shows "Auto", GET preferences 200.                                                                                                                                                                                                                                                                                                                  |
| V7-4 | PASS                               | Audit rows show entity label "**TASK V8V-1**" (project key, not "TASK-n") for CREATED/UPDATED task events; sprint events show "SPRINT V8 Sprint Dates". Board card chip shows title-case "Medium"; sprint-detail task row chip "Medium"; tasks-table cell "Medium"; task-detail badge+select "Medium".                                                                                                                                                                             |
| V7-5 | PASS                               | Unset Date format AND Time format triggers show "**System default**"; selecting 12h → trigger shows "**12-hour (AM/PM)**" (PUT 200); tasks table + task detail immediately render "2026-08-26 1:58 PM".                                                                                                                                                                                                                                                                            |
| V7-6 | PASS                               | Programmatic check over all 11 sortable header buttons + 7 filter-icon buttons: computed `cursor: pointer` on every one.                                                                                                                                                                                                                                                                                                                                                           |

Regression quick-pass:

- Register v8final@taskboard.test → auto-login → welcome → wizard (slug availability check, plan, checkout summary,
  confirm) → tenant home → create project V8V (toast) → task via tasks/new (redirect to detail, toast) → inline title
  edit (Enter saves, PATCH 200) → description Milkdown edit + Save (PATCH 200).
- Sprint lifecycle: assign V8V-1 via task-detail Sprint select (PATCH 200) → Start Sprint → ACTIVE (startDate set,
  endDate untouched — V4-11 holds) → Complete Sprint → disposition dialog with REAL count ("**1** unfinished task(s)
  will be moved…") → confirm Move-to-backlog → task moved (sprintId null), sprint COMPLETED.
- Column chooser: Reporter toggle removes column live (PATCH 200) and stays hidden after full reload.
- Date-format change reflects in tasks table and task detail timestamps (12-hour).
- Members pages load with real tenant id — no `tenants/undefined`.
- Logout → login page → login 200 → tenant home.
- Board DnD incl. multi-status prompt: NOT verifiable via Playwright MCP (same CDK trusted-input limitation documented
  since V1/V5/V7-P2; owner manual verification stands).

**Final verdict: CLEAN** — all six V7 fixes verified fixed; the single residual found during V8 (six missing
`projectSettings.*` i18n keys) was fixed inline as a data-only change and re-verified. No open P0/P1 defects remain;
known deferred items are cosmetic/info only (V4-5 default-status name matching is closed; remaining: none blocking).
Servers left running.
