import { ProjectStatus } from '@task-board/shared';
import { AppError, ConflictError } from '../errors/app-error.js';

/**
 * THE server-owned rule for "may this project be written to?".
 *
 * ## Why this file exists
 *
 * The user interface has always told the user one thing about a project that is
 * scheduled for deletion: *"This project is scheduled for deletion and is
 * read-only."* (`ui/public/assets/i18n/en.json`, `project.deletionPendingBanner`).
 * The server did not keep that promise. Its only read-only guard,
 * `ProjectService.requireNotArchived`, tested a DIFFERENT status (`ARCHIVED`),
 * and it lived inside one service. Every other project-scoped write path
 * resolved its project through `assertProjectInTenant`, which compares the
 * tenant id and nothing else — so tasks, comments, labels, statuses, boards,
 * sprints, task types, relationships, filters and project members all kept
 * accepting writes to a project the user was told is frozen.
 *
 * Two consequences, one user-visible and one not:
 *   - the on-screen promise is false;
 *   - data keeps GROWING inside the deletion window, so a future purge actor
 *     would delete rows that were added after the clock started.
 *
 * ## The rule
 *
 * A project accepts writes in exactly one status: `ACTIVE`. `ARCHIVED` and
 * `DELETION_PENDING` are both read-only. This is an ALLOW-LIST, not a
 * deny-list of the two frozen statuses: a status added to `ProjectStatus` in
 * future is read-only until someone decides otherwise here, which is the
 * direction a deletion window must fail in.
 *
 * ## Fail-closed on an unreadable status
 *
 * `status` is REQUIRED by every code path that produces a project (creation
 * sets `ProjectStatus.ACTIVE`, `docs/architecture.md` §data model), so a
 * project without a readable status cannot occur in production. It CAN occur in
 * a test double — and a test double that omits it must not be able to make a
 * write look legal. A project whose status cannot be read therefore does NOT
 * accept writes. Every service spec that exercises a write path states the
 * project's status explicitly, which is what a real repository returns.
 *
 * ## Scope
 *
 * This predicate governs project-scoped CONTENT and CONFIGURATION writes. The
 * project delete/archive state machine (`deleteProject`, `archiveProject`,
 * `restoreProject`, `cancelDeletion`, `permanentDelete`) is deliberately NOT
 * routed through it: those transitions are what move a project INTO and OUT OF
 * a frozen status, and a later package owns that machine. In particular a
 * second `deleteProject` on a `DELETION_PENDING` project still re-arms the
 * deadline exactly as it does today — changing that is the state machine's
 * decision, not this predicate's.
 *
 * A purge actor added later will call {@link projectAcceptsWrites} for the
 * opposite question (may this project be purged?) — the same single place.
 */

/** The only project status in which a project-scoped write is legal. */
export const WRITABLE_PROJECT_STATUSES: readonly ProjectStatus[] = [ProjectStatus.ACTIVE];

/**
 * The minimum a resolved project must expose for the rule to be decidable.
 *
 * `status` is optional in the TYPE so that a repository double which does not
 * model it still compiles; it is NOT optional in the RULE — see
 * {@link projectAcceptsWrites}, which treats an unreadable status as frozen.
 */
export interface WriteGuardedProject {
  status?: ProjectStatus | string | null;
}

/**
 * THE predicate: does this project accept writes?
 *
 * Pure, total and side-effect free, so the purge actor in a later package and
 * every write path in this one ask the same question of the same function.
 */
export function projectAcceptsWrites(project: WriteGuardedProject | null | undefined): boolean {
  if (!project) {
    return false;
  }

  return WRITABLE_PROJECT_STATUSES.includes(project.status as ProjectStatus);
}

/**
 * The write-path assertion: {@link projectAcceptsWrites} with the refusal
 * attached. Call it immediately after the tenant assertion, which has already
 * resolved the project, so no call site needs a second lookup.
 *
 * Status codes follow the repository's error taxonomy: a frozen project is a
 * conflict with the project's current state (409), never a 403 (the caller is
 * perfectly entitled to write — the project is simply not accepting writes) and
 * never a 404 (the project exists and the caller may see it).
 */
export function assertProjectAcceptsWrites(project: WriteGuardedProject | null | undefined, label = 'Project'): void {
  if (projectAcceptsWrites(project)) {
    return;
  }

  if (project?.status === ProjectStatus.ARCHIVED) {
    // The code and message the archived guard has always produced — unchanged,
    // so no client contract and no existing assertion moves.
    throw new AppError(409, 'PROJECT_ARCHIVED', 'Project is archived and cannot be modified');
  }

  throw new ConflictError(
    `${label} is scheduled for deletion and is read-only — cancel the deletion to make changes`,
    'CONFLICT',
  );
}
