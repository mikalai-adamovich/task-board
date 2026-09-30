import { SprintStatus } from '@task-board/shared';
import type { Sprint } from '@task-board/shared';

/**
 * Visual-only overdue check: an ACTIVE sprint whose `endDate` is in
 * the past is flagged as overdue. No state changes — purely presentational.
 */
export function isSprintOverdue(sprint: Sprint, now: Date = new Date()): boolean {
  if (sprint.status !== SprintStatus.ACTIVE || !sprint.endDate) return false;

  return new Date(sprint.endDate).getTime() < now.getTime();
}
