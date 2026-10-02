/**
 * Minimal base64url codec for opaque pagination cursors.
 *
 * `btoa` and `Buffer` are deliberately not used: the same cursor has to survive
 * a round trip through a Worker (encode), a query string (transport) and a
 * browser or Node test (decode), and those three disagree about binary strings
 * and about characters outside Latin-1. Both cursors in this package — the board
 * column cursor and the comment cursor — therefore share this one implementation
 * instead of each carrying a private copy that can drift.
 *
 * The alphabet is the URL-safe one and the output is UNPADDED, so a cursor can
 * be handed to `URLSearchParams` and back without any escaping.
 */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;

    out += BASE64URL_ALPHABET[(triplet >> 18) & 63];
    out += BASE64URL_ALPHABET[(triplet >> 12) & 63];

    if (i + 1 < bytes.length) out += BASE64URL_ALPHABET[(triplet >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL_ALPHABET[triplet & 63];
  }

  return out;
}

/**
 * Decode an unpadded base64url string.
 *
 * @returns the decoded bytes, or `null` when `text` is not a well-formed
 * unpadded base64url string. The caller owns the error it throws for that, so
 * each cursor reports malformed input in its own vocabulary.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  // A 4-character group encodes 3 bytes, so a length of 4n+1 cannot be produced
  // by any input — the one structural rejection the alphabet check cannot make.
  if (text.length % 4 === 1) return null;

  const values = new Uint8Array(text.length);

  for (let i = 0; i < text.length; i += 1) {
    const index = BASE64URL_ALPHABET.indexOf(text[i] ?? '');

    if (index < 0) return null;
    values[i] = index;
  }

  const bytes: number[] = [];

  for (let i = 0; i < values.length; i += 4) {
    const c0 = values[i] ?? 0;
    const c1 = values[i + 1] ?? 0;
    const c2 = values[i + 2];
    const c3 = values[i + 3];
    const triplet = (c0 << 18) | (c1 << 12) | ((c2 ?? 0) << 6) | (c3 ?? 0);

    bytes.push((triplet >> 16) & 255);
    if (c2 !== undefined) bytes.push((triplet >> 8) & 255);
    if (c3 !== undefined) bytes.push(triplet & 255);
  }

  return Uint8Array.from(bytes);
}
