/**
 * Comment cursor contract tests (shared helpers, exercised via the built
 * `@task-board/shared` dist — the same artifact that ships to Workers).
 *
 * Covers: encode/decode round-trip over the whole key space, opacity (no raw
 * keys in the string a client passes around), and every malformed input the
 * route has to answer with 400 rather than 500.
 */
import { describe, it, expect } from 'vitest';
import {
  COMMENT_CURSOR_MAX_LENGTH,
  COMMENT_PAGE_SIZE,
  InvalidCommentCursorError,
  decodeCommentCursor,
  encodeCommentCursor,
} from '@task-board/shared';

const KEY = { createdAtMs: 1_781_234_567_890, objectId: '0123456789abcdef01234567' };
/** The encoding a test uses to forge a payload the decoder must judge. */
const forge = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('comment cursor', () => {
  it('round-trips the ordering key', () => {
    for (const createdAtMs of [0, 1, KEY.createdAtMs, 4_102_444_800_000]) {
      for (const objectId of ['000000000000000000000000', 'ffffffffffffffffffffffff', KEY.objectId]) {
        expect(decodeCommentCursor(encodeCommentCursor({ createdAtMs, objectId }))).toEqual({ createdAtMs, objectId });
      }
    }
  });

  it('is opaque base64url — no JSON and no raw key leaks into the wire string', () => {
    const encoded = encodeCommentCursor(KEY);

    expect(encoded).toMatch(/^[A-Za-z0-9-_]+$/);
    expect(encoded).not.toContain('{');
    expect(encoded).not.toContain(KEY.objectId);
    // Short enough to be a query parameter on every page of a long traversal.
    expect(encoded.length).toBeLessThanOrEqual(COMMENT_CURSOR_MAX_LENGTH);
  });

  it('fits the declared page size in one cursor per page request', () => {
    // The page size is a shared constant for a reason: a client that mirrors it
    // never has to guess how many comments one "load older" click will bring.
    expect(COMMENT_PAGE_SIZE).toBe(30);
  });

  it('rejects empty, non-string and overlong input', () => {
    expect(() => decodeCommentCursor('')).toThrow(InvalidCommentCursorError);
    expect(() => decodeCommentCursor(null)).toThrow(InvalidCommentCursorError);
    expect(() => decodeCommentCursor(undefined)).toThrow(InvalidCommentCursorError);
    expect(() => decodeCommentCursor(42)).toThrow(InvalidCommentCursorError);
    expect(() => decodeCommentCursor('x'.repeat(COMMENT_CURSOR_MAX_LENGTH + 1))).toThrow(InvalidCommentCursorError);
  });

  it('rejects non-base64url characters (a tampered query parameter)', () => {
    expect(() => decodeCommentCursor('not a cursor!!!')).toThrow(InvalidCommentCursorError);
    expect(() => decodeCommentCursor('ab+c/def=')).toThrow(InvalidCommentCursorError);
    // Structurally impossible base64url length (4n+1).
    expect(() => decodeCommentCursor('abcde')).toThrow(InvalidCommentCursorError);
  });

  it('rejects payloads outside the cursor shape', () => {
    for (const raw of [
      'plain-text',
      '[1,2,3]',
      '"just-a-string"',
      '42',
      'null',
      forge({ v: 999, t: KEY.createdAtMs, i: KEY.objectId }),
      forge({ v: 1, t: KEY.createdAtMs }),
      forge({ v: 1, i: KEY.objectId }),
    ]) {
      expect(() => decodeCommentCursor(raw)).toThrow(InvalidCommentCursorError);
    }
  });

  it('rejects out-of-range keys at decode time', () => {
    for (const payload of [
      { v: 1, t: '1781234567890', i: KEY.objectId },
      { v: 1, t: 1.5, i: KEY.objectId },
      { v: 1, t: Number.NaN, i: KEY.objectId },
      { v: 1, t: 1e21, i: KEY.objectId },
      { v: 1, t: KEY.createdAtMs, i: 'not-an-object-id' },
      { v: 1, t: KEY.createdAtMs, i: '0123456789ABCDEF01234567' },
      { v: 1, t: KEY.createdAtMs, i: '0123456789abcdef0123456' },
    ]) {
      expect(() => decodeCommentCursor(forge(payload))).toThrow(InvalidCommentCursorError);
    }
  });

  it('rejects out-of-range keys at encode time', () => {
    expect(() => encodeCommentCursor({ createdAtMs: 1.5, objectId: KEY.objectId })).toThrow(InvalidCommentCursorError);
    expect(() => encodeCommentCursor({ createdAtMs: KEY.createdAtMs, objectId: 'nope' })).toThrow(
      InvalidCommentCursorError,
    );
  });
});
