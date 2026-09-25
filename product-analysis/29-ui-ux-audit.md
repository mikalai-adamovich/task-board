# 29 — UI/UX Audit

Screen-by-screen review of the current Angular UI against the agreed IA
([06-information-architecture.md](06-information-architecture.md)) and screen spec
([08-screen-and-page-specification.md](08-screen-and-page-specification.md)). Verdicts: **KEEP** · **IMPROVE** ·
**REWORK** · **REMOVE** · **REPLACE**. Decision questions at the end (UQ-01…UQ-09).

---

## 1. Cross-cutting findings

### X-1 — Dead global search in the header (REMOVE or REPLACE)

`shell/header/header-search/header-search.ts` rendered an input bound to a local `searchValue` signal with **no behavior
at all** — it could not search anything. Meanwhile the Tasks table already has a working, URL-bound search that acts as
a table filter (which is exactly what [08-screen-and-page-specification.md](08-screen-and-page-specification.md) S11
specifies). Options: remove the header input entirely (MVP), or replace it later with a real global search / command
palette (roadmap). → **UQ-01**.

### X-2 — Broken project deep links: `projectId` passed where the router expects `projectKey`

Routes were defined as `projects/:projectKey` ([app.routes.ts](../ui/src/app/app.routes.ts):57), but at least two places
navigated with the **id**:

- `owner-dashboard.html:85` — My Recent Tasks linked `[... 'projects', task.projectId, 'tasks', task.id]`
- `workspace-detail.html:63` — the project list linked `'projects', project.id`

Unless `projectGuard` resolves ids, these links 404/misroute. Root cause is the unresolved choice between key-based and
id-based URLs. → **UQ-03**.

### X-3 — Role-split dashboards duplicate the tenant home concept (REWORK)

Root `/` renders one of five sub-views (`landing`, `welcome`, `invitation-view`, `member-dashboard`, `owner-dashboard`).
The spec ([08 §S6](08-screen-and-page-specification.md)) defines **one** Tenant dashboard (projects grid + Create
Project CTA) reached after login/tenant selection — not role-specific cross-tenant pages. Current issues:

- `owner-dashboard` shows the same stat twice ("Total tasks" card duplicated — copy-paste bug);
- Member vs Owner dashboards mostly duplicate workspace lists;
- The post-login routing rule "one accessible tenant → that tenant's home" is not implemented (root always intercepts).
  → **UQ-02**.

### X-4 — Non-canonical task URLs

Task detail lives at `projects/:projectKey/tasks/:taskId`; the spec defines canonical `/tasks/:taskId`
([06-information-architecture.md](06-information-architecture.md) §3). Nested URLs break when a task is shared after
project key changes are disallowed anyway — but they also make the "My Tasks" links awkward. Tied to UQ-03.

### X-5 — Missing project Settings hub

Only `settings/statuses`, `settings/task-types`, `settings/labels` exist. There is **no** project General settings page
(rename, description, key pre-first-task), no Boards administration page (board creation is a dialog inside
project-detail), and the **Danger Zone is rendered directly on the project overview**
([project-detail.html:71-100](../ui/src/app/features/projects/project-detail/project-detail.html)) instead of inside a
settings area ([08 §S15](08-screen-and-page-specification.md)). → **UQ-05**.

### X-6 — Help/support surfaces outside MVP scope

Public `/faq`, `/docs`, `/support` pages plus a `support-client` service and header help-menu exist. The analysis scoped
these out ([23-mvp-scope.md](23-mvp-scope.md)); they dilute the product surface and need maintenance (11 locales each).
→ **UQ-06**.

### X-7 — Notifications button without a notification center

`shell/header/notifications-button` exists while the notification center is explicitly deferred (DEC-014). If it renders
a non-functional bell, it teaches users to expect a feature that isn't there. → **UQ-07**.

## 2. Screen-by-screen verdicts

| Screen / route                               | Verdict              | Notes                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing (`/` visitor)                        | **KEEP**             | Simple sign-up/log-in entry per spec S1.                                                                                                                                                                                                                                                                                                                   |
| Login / Register                             | **KEEP**, IMPROVE    | Solid; add "Forgot password" only after DEC-023 lands; ensure neutral error copy.                                                                                                                                                                                                                                                                          |
| Accept-invitation (`auth/accept-invitation`) | **REWORK**           | Must become the `/invite/:token` token landing per DEC-027 (validate token → login/register resume).                                                                                                                                                                                                                                                       |
| Root dashboard state machine                 | **REWORK**           | See X-3; unify into single tenant-home behavior + root redirect rule.                                                                                                                                                                                                                                                                                      |
| Welcome view (new user)                      | **KEEP**, IMPROVE    | Good free-plan framing; will gain the mock-checkout step (DEC-022) after it.                                                                                                                                                                                                                                                                               |
| Invitation view (pending invites)            | **KEEP**             | Works as the DEC-027 _fallback_ channel once token landing is primary.                                                                                                                                                                                                                                                                                     |
| Owner/Member dashboards                      | **REPLACE**          | Merge into the unified tenant home (X-3); fix duplicated stat card and broken task links before removal.                                                                                                                                                                                                                                                   |
| Workspace detail (`tenants/:tenantId`)       | **KEEP**, IMPROVE    | Reasonable tenant home. Improvements: direct "Create project" CTA (currently routed via project-list page), non-collapsible project grid, show pending-invitations summary for admins, Plan/Billing entry (DEC-022).                                                                                                                                       |
| Tenant settings                              | **KEEP**, IMPROVE    | Add Danger Zone placement check (archive/delete tenant w/ typed confirm per BR-004) and Plan/Billing tab.                                                                                                                                                                                                                                                  |
| Tenant member list                           | **KEEP**, IMPROVE    | Align status display with DEC-018 (ACCESS_REVOKED-until-accepted shown as "Invitation pending"), resend/revoke actions per doc 16 §5.                                                                                                                                                                                                                      |
| Project list                                 | **KEEP**, IMPROVE    | Add archived-projects filter/tab (BR-004 visibility) and inline create dialog.                                                                                                                                                                                                                                                                             |
| Project detail (overview)                    | **REWORK**           | Currently boards-grid + danger zone. Spec S9 wants: task summary by status, active-sprint block, recent tasks, members preview, shortcuts. Move Danger Zone out (X-5); keep quick board access. → UQ-04/UQ-05.                                                                                                                                             |
| Board view                                   | **KEEP**, IMPROVE    | Best screen in the app: optimistic moves, multi-status prompt, error toasts. Improvements: keyboard move path + accessible "move to column" menu ([13 §3.2](13-board-and-kanban-analysis.md)), hidden-card count disclosure when filtered, per-column "load more", visible sprint-scoping indicator when `?sprintId` present, overdue flag hook (DEC-029). |
| Task table                                   | **KEEP**             | Exemplary: URL-bound filters/sort/pagination, per-column filter popovers, saved-filter dialog, page-size preference. Minor: debounce text search (~300 ms), show active-filter chips with one-click clear ([20 §2](20-error-empty-loading-states.md) "Empty (filtered)" state).                                                                            |
| Task detail                                  | **KEEP**, IMPROVE    | Inline editing + conflict dialog match DEC-030. Improvements: History/activity tab (US-AUD-01, needs DEC-021 action), relationships panel polish, keep-mine deferred per DEC-030.                                                                                                                                                                          |
| Create task dialog                           | **KEEP**, IMPROVE    | Ensure default-status preselection (BR-007) and label case-insensitive reuse (BR-019) are wired; keyboard shortcut `c` (SHOULD-have, [23](23-mvp-scope.md)).                                                                                                                                                                                               |
| Sprint list                                  | **KEEP**, IMPROVE    | Active/Future/Completed groups match spec S13. Add **Backlog** group/section (spec includes it; currently only a separate sprint-backlog component) and overdue badge (DEC-029).                                                                                                                                                                           |
| Sprint detail / sprint backlog               | **KEEP**, IMPROVE    | Completion dialog must implement unfinished-task disposition (BR-031) and date population rules (DEC-016 server-side already planned). Deep-link sprint board via board `?sprintId`.                                                                                                                                                                       |
| Statuses / Task types / Labels managers      | **KEEP**, IMPROVE    | Wire the replacement-aware deletion flows (BR-016/017 warning UI listing affected counts/boards) if not fully implemented; invalid-board-reference red marking belongs in a future Boards admin page (X-5).                                                                                                                                                |
| Project member list                          | **KEEP**, IMPROVE    | Same DEC-018 status semantics; removal copy must state "stays in tenant, history preserved" (BR-038).                                                                                                                                                                                                                                                      |
| User preferences `/settings`                 | **KEEP**, IMPROVE    | Theme/zoom/language fine; rename route to `/profile/preferences` conceptually (or keep) to avoid ambiguity with tenant/project settings; add profile display-name editing here.                                                                                                                                                                            |
| Help pages (faq/docs/support)                | **REMOVE?**          | Out of MVP scope (X-6). → UQ-06.                                                                                                                                                                                                                                                                                                                           |
| Header search                                | **REMOVE / REPLACE** | X-1. → UQ-01.                                                                                                                                                                                                                                                                                                                                              |
| Notifications button                         | **REMOVE?**          | X-7. → UQ-07.                                                                                                                                                                                                                                                                                                                                              |
| Tenant switcher                              | **KEEP**             | Matches spec; ensure it implements the "clears project context" rule ([06 §2.1](06-information-architecture.md)).                                                                                                                                                                                                                                          |

## 3. Thematic improvement backlog (post-decision)

1. **Navigation truthfulness** — sidebar/header reflect effective permissions (already partly done via
   `canManageProject`); extend to Viewer (hide admin entries entirely).
2. **State hygiene** — every screen gets the four-state treatment from doc 20 (loading skeleton / empty+CTA /
   filtered-empty / error+retry); several screens currently conflate empty and loading.
3. **URL contract** — decide key-vs-id (UQ-03) then fix all internal links in one sweep; add canonical task URLs if
   chosen.
4. **Consistency kit** — shared empty-state component, confirm-dialog with typed confirmation for destructive actions
   (tenant/project delete per BR-004), standardized toast wording from error codes.
5. **Onboarding completion** — welcome → plan → mock checkout (DEC-022) → tenant home with single primary CTA.

## 4. Decision questions

**UQ-01 — Header search** (a) Remove the dead input now; reintroduce as global search/command palette post-MVP
(recommended — a dead control erodes trust); (b) keep the input and wire it to navigate to the current project's task
table with `?search=`; (c) implement true cross-project global search now (out of MVP scope).

**UQ-02 — Main page model** (a) Spec-faithful: root redirects to last/first accessible tenant home; one unified tenant
dashboard for all roles; "My Tasks" becomes a widget there (recommended); (b) keep the cross-tenant personal dashboard
as root (fix bugs, deduplicate) and treat tenant pages as secondary.

**UQ-03 — Project/task URL scheme** (a) Switch routes to ids: `/projects/:projectId`, canonical `/tasks/:taskId`
(spec-faithful, stable links; keys still displayed everywhere) (recommended); (b) keep key-based project URLs and fix
all mislinks; task stays nested. Trade-off: keys are human-readable in URLs; ids never change and avoid the guard
resolution entirely.

**UQ-04 — Project overview content** (a) Full spec overview (status summary, active sprint, recent tasks, members
preview, board shortcuts) (recommended); (b) keep lightweight boards-grid overview and rely on sidebar navigation.

**UQ-05 — Project settings hub & danger zone** (a) Create `projects/:x/settings` hub (General / Members / Types /
Statuses / Labels / Boards / Danger Zone) and move archive/delete out of the overview (recommended, matches S15); (b)
keep configuration pages flat and danger zone on overview.

**UQ-06 — Help pages (faq/docs/support)** (a) Remove from the app for MVP (locales maintenance burden, out of scope)
(recommended); (b) keep as static content without the support-form backend.

**UQ-07 — Header notifications button** (a) Remove until the notification center exists (DEC-014) (recommended); (b)
keep as disabled-with-tooltip placeholder.

**UQ-08 — Sprint board UX** (a) One board experience: board view gains a sprint selector (`?sprintId=`), sprint-detail
links into it; sprint-detail keeps planning actions (recommended — honors "boards are views"); (b) keep sprint-detail as
its own board-like page.

**UQ-09 — Backlog on the Sprints page** (a) Add a Backlog group/section to sprint-list linking to the backlog view (spec
S13) (recommended); (b) keep backlog as a standalone page reachable from sidebar only.

---

## 5. Resolutions (decided)

| UQ    | Decision                                          | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UQ-01 | **(a)** Remove header search                      | Delete `header-search` component + header slot; global search/command palette stays roadmap.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UQ-02 | **(a)** Spec-faithful main page                   | Root redirects to last/first accessible tenant home; single unified tenant dashboard for all roles; "My Tasks" becomes a widget; Owner/Member dashboards and the duplicated stat card are retired.                                                                                                                                                                                                                                                                                                            |
| UQ-03 | **(b)** Human-readable URLs **+ tenant slugs**    | Adopt slug-based scheme per DEC-032: `/t/:tenantSlug/projects/:projectKey/tasks/:taskNumber` (e.g. `/t/my-workspace/projects/ABC/tasks/ABC-123`). Slug auto-generated from workspace name, editable pre-submit, globally unique with availability check, lowercase `[a-z0-9-]`, max-length capped. [06-information-architecture.md](06-information-architecture.md) §3 rewritten. Server work: `slug` field + unique index on Tenant, availability endpoint, slug→id resolution in tenant context middleware. |
| UQ-04 | **(a)** Full project overview                     | Status summary, active-sprint block, recent tasks, members preview, board shortcuts (spec S9).                                                                                                                                                                                                                                                                                                                                                                                                                |
| UQ-05 | **(a)** Project settings hub                      | New `…/settings` index (General / Members / Types / Statuses / Labels / Boards / Danger Zone); archive/delete moves out of overview.                                                                                                                                                                                                                                                                                                                                                                          |
| UQ-06 | **(b)** Keep help pages as static example content | No support-form backend; treated as demo/static content, excluded from MVP acceptance criteria.                                                                                                                                                                                                                                                                                                                                                                                                               |
| UQ-07 | **(a)** Remove notifications UI entirely          | Both the header button **and** the notifications panel/dropdown are removed until the notification center (DEC-014) is built; they return together.                                                                                                                                                                                                                                                                                                                                                           |
| UQ-08 | **(a)** Unified board experience                  | Board view gains a sprint selector (`?sprintId=`); sprint-detail keeps planning actions and links into the scoped board.                                                                                                                                                                                                                                                                                                                                                                                      |
| UQ-09 | **(a)** Backlog section on Sprints page           | Sprint-list gains a Backlog group linking to the backlog view (spec S13).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
