/**
 * Upper bounds for repository reads that return a COLLECTION.
 *
 * Lives beside `query-timeout.ts` rather than in `repositories/` because it is
 * the other half of the same question — how much work one query is allowed to
 * do. `maxTimeMS` bounds a read in TIME; these bound it in ROWS. A read with
 * neither can be made arbitrarily expensive by the data alone.
 *
 * Every one of these queries used to call `.toArray()` with no `limit`, so the
 * response grew with the data: the inbound body cap (`middleware/body-limit.ts`,
 * 5 MB) bounds what a caller may SEND, and nothing bounded what the Worker
 * answered with. A reference list is small in practice, "in practice" is not a
 * property a read may rely on, and the failure mode is a Worker that runs out of
 * memory building a JSON body rather than an error anyone can act on.
 *
 * These are BOUNDS, not pagination. A bound truncates and says so in a comment;
 * only a paginated list tells a caller that more exists. For the per-project
 * reference lists and the member lists below, truncation is the right trade for
 * this pass: the lists are small by construction, the alternative is a contract
 * change across the route, the service and the UI client for a read that is not
 * currently reachable at these sizes.
 *
 * COMMENTS ARE NO LONGER IN THIS FILE. A thread is open-ended by nature, so
 * bounding it could only ever truncate, and the bound it used to carry kept the
 * OLDEST 500 — a busy task therefore hid its own newest activity, which is the
 * part a reader opened the task for, and the older comments were unreachable
 * anyway because nothing said they existed. `GET /tasks/:taskId/comments` is
 * cursor-paginated instead (`COMMENT_PAGE_SIZE` in `@task-board/shared`): the
 * repository still issues a `limit`, so it is still bounded in rows, but the
 * bound is a PAGE the caller chose and walks through rather than a ceiling on
 * the thread.
 *
 * Every bound below states why its number is what it is.
 */

/**
 * Relationships touching one task (as source or as target).
 *
 * Relationships are hand-authored edges — blocks / relates / duplicates — and
 * grow with deliberate human action, not with usage. 200 is already an order of
 * magnitude beyond a realistic task graph, so hitting it means the data is wrong
 * rather than merely large.
 */
export const MAX_RELATIONSHIPS_PER_TASK = 200;

/**
 * Statuses in one project (the board's columns).
 *
 * A workflow column list is chosen by a team and re-ordered, not generated. 200
 * columns is far past the point where a board is unusable in a UI, so a larger
 * value would only defer the same failure.
 */
export const MAX_PROJECT_STATUSES = 200;

/**
 * Task types in one project.
 *
 * Same reasoning as the status list: a hand-maintained vocabulary. 200 types
 * (bug, story, epic, …) is several times any real taxonomy.
 */
export const MAX_PROJECT_TASK_TYPES = 200;

/**
 * Labels in one project.
 *
 * Labels are the one reference list that plausibly grows with usage — a large
 * project accumulates conventions like `area/frontend` and `needs-triage` over
 * years. 1 000 leaves room for that growth while keeping the response to a
 * payload a browser can hold in memory.
 */
export const MAX_PROJECT_LABELS = 1000;

/**
 * Sprints in one project.
 *
 * A project that has run sprints continuously for a decade holds a few hundred.
 * 1 000 keeps every historical sprint readable while bounding the list.
 */
export const MAX_PROJECT_SPRINTS = 1000;

/**
 * Saved filters one user keeps in one project.
 *
 * These are personal view presets, created a few at a time. 500 is far beyond
 * what a person curates, so the bound only fires on data that is not really a
 * filter list.
 */
export const MAX_SAVED_FILTERS_PER_USER = 500;

/**
 * Members of one project.
 *
 * Membership is granted by an admin, so the list grows with the team. 1 000 is a
 * large-company-sized project; beyond it the read is answering a question the
 * member list is not the right shape for.
 */
export const MAX_PROJECT_MEMBERS = 1000;

/**
 * Members of one tenant (workspace).
 *
 * The widest legitimate list in the system: a workspace is the unit that spans
 * teams, so 5 000 covers an organisation several times over before the bound
 * fires.
 */
export const MAX_TENANT_MEMBERS = 5000;

/**
 * Projects in one workspace.
 *
 * A workspace spans teams, so this is the second-widest legitimate list in the
 * system after its own membership list. 1 000 projects is already more boards
 * than a person can navigate, and this read is what renders the workspace's
 * project list — a longer answer is not a more useful one.
 */
export const MAX_PROJECTS_PER_TENANT = 1000;

/**
 * Memberships one user holds, across every tenant.
 *
 * Bounded by how many workspaces a person belongs to. 1 000 is generous for a
 * human account and keeps the authorization read (which every scoped request
 * performs) from materializing an arbitrary number of rows.
 */
export const MAX_USER_MEMBERSHIPS = 1000;

/**
 * Invitations addressed to one e-mail address.
 *
 * Invitations are issued one tenant at a time, so a real address accumulates a
 * handful. 100 leaves room for a migration or a bulk re-invite while staying a
 * bound: an address with more pending invitations than this is not a person.
 */
export const MAX_INVITATIONS_PER_EMAIL = 100;

/**
 * Documents returned by a bulk `$in` lookup.
 *
 * The id sets handed to `findByIds` are already page-scoped by their callers
 * (one audit page, one board's column set, one user's invitation set), so this
 * is a backstop rather than a working limit: it turns a future caller that
 * forgets to scope its id list into a truncated read instead of an unbounded
 * one. Set above every current caller's largest id set so no existing path can
 * reach it.
 */
export const MAX_BULK_ID_LOOKUP = 1000;
