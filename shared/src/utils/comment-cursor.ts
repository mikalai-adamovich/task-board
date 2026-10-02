/**
 * Opaque cursor pagination cursor for a task's comment thread.
 *
 * It carries the ordering key of the OLDEST comment of the page just returned —
 * `(createdAt, _id)` — so the next page resumes with a keyset predicate rather
 * than an offset. Offsets are not usable here: a comment posted between two
 * page requests shifts every later row by one, so an offset walk either repeats
 * a comment or skips one. A keyset walk has no such window.
 *
 * `_id` is part of the key because `createdAt` is not unique. Two comments
 * written inside the same millisecond sort equally, and a page boundary landing
 * between them would otherwise make one of them unreachable — or hand it out
 * twice. The tiebreaker is what makes the traversal total.
 *
 * It is opaque by contract: the client passes the string back verbatim and never
 * reads a key from it. The `_id` is a storage handle rather than a domain id, so
 * publishing it as a query object would make the document layout part of this
 * API and would let a caller hand-craft a predicate. The payload is versioned
 * (`v`) so the shape can change without breaking cursors already in flight, and
 * it is base64url-encoded with the package's own codec (`btoa`/`Buffer` disagree
 * across Workers, Node and browsers).
 */
import { COMMENT_CURSOR_MAX_LENGTH } from '../constants/comment.js';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/** Ordering key of the oldest comment of the page that was just returned. */
export interface CommentPageCursor {
  /** `createdAt` of that comment, epoch milliseconds (UTC). */
  createdAtMs: number;
  /** Its `_id`, as 24 lowercase hex characters. */
  objectId: string;
}

/** Thrown when a cursor is malformed or tampered with — maps to HTTP 400. */
export class InvalidCommentCursorError extends Error {
  constructor(message = 'Invalid comment cursor') {
    super(message);
    this.name = 'InvalidCommentCursorError';
  }
}

/** Wire format version — bump when the payload shape changes. */
const CURSOR_VERSION = 1;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

function isValidKey(cursor: CommentPageCursor): boolean {
  return (
    typeof cursor.createdAtMs === 'number' &&
    Number.isSafeInteger(cursor.createdAtMs) &&
    typeof cursor.objectId === 'string' &&
    OBJECT_ID_PATTERN.test(cursor.objectId)
  );
}

/**
 * Encode the ordering key into an opaque cursor string.
 *
 * @throws {@link InvalidCommentCursorError} when the key is not a
 * `(epoch-ms, 24-hex)` pair, or when the encoding would exceed
 * `COMMENT_CURSOR_MAX_LENGTH` (programmer error — the typed signature already
 * narrows both fields).
 */
export function encodeCommentCursor(cursor: CommentPageCursor): string {
  if (!isValidKey(cursor)) {
    throw new InvalidCommentCursorError('Comment cursor keys are out of range');
  }

  const json = JSON.stringify({ v: CURSOR_VERSION, t: cursor.createdAtMs, i: cursor.objectId });
  const bytes = new Uint8Array(json.length);

  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);

    // Digits, JSON punctuation and hex only, so the payload is ASCII by
    // construction — the guard makes that a fact instead of an assumption.
    if (code > 255) throw new InvalidCommentCursorError('Comment cursor payload is not encodable');
    bytes[i] = code;
  }

  const encoded = encodeBase64Url(bytes);

  if (encoded.length > COMMENT_CURSOR_MAX_LENGTH) {
    throw new InvalidCommentCursorError('Comment cursor exceeds the maximum length');
  }

  return encoded;
}

/**
 * Decode and validate an opaque cursor string.
 *
 * @throws {@link InvalidCommentCursorError} for empty, overlong, non-base64url,
 * non-JSON, wrong-version or out-of-range payloads (malformed/tampered input →
 * HTTP 400).
 */
export function decodeCommentCursor(value: unknown): CommentPageCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > COMMENT_CURSOR_MAX_LENGTH) {
    throw new InvalidCommentCursorError('Comment cursor must be a short non-empty string');
  }

  const bytes = decodeBase64Url(value);

  if (bytes === null) throw new InvalidCommentCursorError('Comment cursor is not base64url');

  const json = String.fromCharCode(...bytes);
  let parsed: unknown;

  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidCommentCursorError('Comment cursor payload is not JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCommentCursorError('Comment cursor payload must be an object');
  }

  const record = parsed as Record<string, unknown>;
  const cursor: CommentPageCursor = { createdAtMs: record['t'] as number, objectId: record['i'] as string };

  if (record['v'] !== CURSOR_VERSION || !isValidKey(cursor)) {
    throw new InvalidCommentCursorError('Comment cursor payload is out of range');
  }

  return cursor;
}
