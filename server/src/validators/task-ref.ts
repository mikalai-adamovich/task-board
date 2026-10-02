/**
 * The `taskId` path parameter has ONE shape definition, in ONE place.
 *
 * `validators/path-params.ts` decides whether a value is a legal `:taskId`; this
 * module decides what a legal `:taskId` MEANS. They were previously two
 * independent regular expressions (the schema's and the GET route's), and only
 * ONE consumer of the accepted KEY-NUMBER form honoured it: `GET /tasks/:taskId`
 * branched on the key, while PATCH, DELETE and both comment routes handed the
 * same value to `findById`, which answers 404 for `PRO-42`. The schema therefore
 * promised a form four routes silently refused.
 *
 * Every route that resolves a `:taskId` now goes through {@link parseTaskRef}
 * (shape) and `TaskService.resolveTaskId` (resolution), so the accepted form and
 * the honoured form cannot drift apart again.
 */

/**
 * `KEY-NUMBER`, e.g. `PRO-42`.
 *
 * Deliberately anchored and capture-grouped: it is used both as the Zod schema
 * (`path-params.ts`) and as the parser here, so widening the accepted shape in
 * one place cannot leave the other behind.
 */
export const TASK_KEY_NUMBER_PATTERN = /^([A-Z][A-Z0-9]*)-([0-9]{1,10})$/;

/** A parsed `:taskId` — a bare UUID, or a project key plus a task number. */
export type TaskRef = { kind: 'uuid'; taskId: string } | { kind: 'key'; projectKey: string; number: number };

/**
 * Classify a validated `:taskId`.
 *
 * Anything that is not KEY-NUMBER is passed through as a bare id: the path
 * parameter is already schema-validated by the time any consumer sees it, so the
 * only question here is which of the two accepted forms it is.
 */
export function parseTaskRef(value: string): TaskRef {
  const match = TASK_KEY_NUMBER_PATTERN.exec(value);

  return match?.[1] && match[2]
    ? { kind: 'key', projectKey: match[1], number: Number(match[2]) }
    : { kind: 'uuid', taskId: value };
}
