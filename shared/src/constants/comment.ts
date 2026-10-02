/**
 * Page size of the comment thread (`GET /api/tasks/:taskId/comments`).
 *
 * 30 is a PAGE size, never a ceiling on how many comments a task may hold: the
 * route is cursor-paginated, so a thread of any length is fully reachable by
 * following `nextCursor` until `hasMore` is false. A comment body is capped at
 * 5 000 characters, so 30 keeps one page in the same order of magnitude as the
 * pages around it (the board serves 50 cards per column) while bounding the
 * response a single request can produce.
 *
 * The value is shared rather than declared twice because the client mirrors it
 * (the "load older" control requests exactly this many) and the server enforces
 * it as the maximum of the `limit` query parameter.
 */
export const COMMENT_PAGE_SIZE = 30;

/**
 * Upper bound on a serialized comment cursor, in characters.
 *
 * Generous on purpose: the canonical payload is
 * `{"v":1,"t":1781234567890,"i":"<24 hex>"}` — 56 bytes, 75 characters of
 * base64url — so this bound admits every legal cursor while still rejecting an
 * oversized string before it is decoded. The request query is bounded by the
 * URL length limit anyway; this is the second, explicit line.
 */
export const COMMENT_CURSOR_MAX_LENGTH = 96;
