/**
 * Free-text task-search bounds (shared by the API schema and the task table).
 *
 * The query-plan facts: `search` compiles to an `$or` over
 * five regexes (title, description and three snapshot display names). No B-tree
 * can serve that shape, so the planner walks the whole `{projectId}` range and
 * evaluates five regexes per document — measured 25,250 documents examined and
 * 728–766 ms for a 20-row page on a 25k-task project. The cheapest payload
 * (`?search=a`) is the most expensive one to serve.
 *
 * The length bounds do NOT make the scan cheaper (the pattern is an unanchored
 * substring either way) — they exist to stop a query that is guaranteed to
 * return most of the project, and to bound the compiled pattern's size. The
 * hard cost backstop is `maxTimeMS` on the query itself (see
 * `server/src/db/query-timeout.ts`).
 *
 * - `TASK_SEARCH_MIN_LENGTH` = 2: a one-character term matches virtually every
 *   task in a project and is never what a user means. Two characters keeps
 *   genuine acronym searches ("QA", "UI", "UX") working, so the guard does not
 *   silently break the filter panel.
 * - `TASK_SEARCH_MAX_LENGTH` = 100: longer terms cannot narrow a substring match
 *   further, and every character is multiplied by five regex evaluations per
 *   scanned document.
 */
export const TASK_SEARCH_MIN_LENGTH = 2;
export const TASK_SEARCH_MAX_LENGTH = 100;
