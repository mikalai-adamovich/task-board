/**
 * Opaque board pagination cursor.
 *
 * The cursor carries the sort keys of the last card of a loaded column page
 * (`priorityLevel` + `number`) so the next page can resume with a keyset
 * predicate — no offsets, no skips. It is intentionally opaque: callers pass
 * the base64url string back verbatim and never read raw keys from the URL.
 *
 * The wire payload is versioned (`v`) so the format can be extended without
 * breaking old cursors — bump the version and branch in
 * {@link decodeBoardCursor}. The base64url codec is the package's own
 * (`utils/base64url.ts`), shared with the comment cursor: no globals are used,
 * because `btoa`/`Buffer` differ across Workers/Node/browsers.
 */
import { TASK_PRIORITY_LEVELS, type TaskPriorityLevel } from '../constants/priority.js';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/** Sort keys of the last card of a loaded board column page. */
export interface BoardPageCursor {
  priorityLevel: TaskPriorityLevel;
  number: number;
}

/** Thrown when a cursor is malformed or tampered with — maps to HTTP 400. */
export class InvalidBoardCursorError extends Error {
  constructor(message = 'Invalid board cursor') {
    super(message);
    this.name = 'InvalidBoardCursorError';
  }
}

/** Wire format version — bump when the payload shape changes. */
const CURSOR_VERSION = 1;
/** Generous upper bound: the canonical payload is ~32 chars. */
const MAX_CURSOR_LENGTH = 64;

function isValidLevel(value: unknown): value is TaskPriorityLevel {
  return (
    typeof value === 'number' && Number.isInteger(value) && (TASK_PRIORITY_LEVELS as readonly number[]).includes(value)
  );
}

function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Encode sort keys into an opaque cursor string.
 *
 * @throws {@link InvalidBoardCursorError} when the keys are out of range
 * (programmer error — the typed signature already narrows them).
 */
export function encodeBoardCursor(cursor: BoardPageCursor): string {
  if (!isValidLevel(cursor.priorityLevel) || !isValidNumber(cursor.number)) {
    throw new InvalidBoardCursorError('Board cursor keys are out of range');
  }

  const json = JSON.stringify({ v: CURSOR_VERSION, p: cursor.priorityLevel, n: cursor.number });
  const bytes = new Uint8Array(json.length);

  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);

    // The payload is digits and JSON punctuation by construction (ASCII-only).
    if (code > 255) throw new InvalidBoardCursorError('Board cursor payload is not encodable');
    bytes[i] = code;
  }

  return encodeBase64Url(bytes);
}

/**
 * Decode and validate an opaque cursor string.
 *
 * @throws {@link InvalidBoardCursorError} for empty, overlong, non-base64url,
 * non-JSON or out-of-range payloads (malformed/tampered input → HTTP 400).
 */
export function decodeBoardCursor(value: unknown): BoardPageCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new InvalidBoardCursorError('Board cursor must be a short non-empty string');
  }

  const bytes = decodeBase64Url(value);

  if (bytes === null) throw new InvalidBoardCursorError('Board cursor is not base64url');

  const json = String.fromCharCode(...bytes);
  let parsed: unknown;

  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidBoardCursorError('Board cursor payload is not JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidBoardCursorError('Board cursor payload must be an object');
  }

  const record = parsed as Record<string, unknown>;

  if (record['v'] !== CURSOR_VERSION || !isValidLevel(record['p']) || !isValidNumber(record['n'])) {
    throw new InvalidBoardCursorError('Board cursor payload is out of range');
  }

  return { priorityLevel: record['p'], number: record['n'] };
}
