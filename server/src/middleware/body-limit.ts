/**
 * The request-body size cap (hand-back, decision 20, option (a)).
 *
 * Until this module nothing in `server/src` bounded a request body: there was
 * no framework body-limit option and no `Content-Length` check anywhere. Two
 * array bounds had been added for specific routes, which closes the paths that
 * could realistically produce a very large document and leaves every other
 * route unbounded. The guarantee was therefore the hosting platform's, not the
 * application's — a weaker guarantee than it looks, because the application had
 * no say in where the line was.
 *
 * ── WHY 5 MB ─────────────────────────────────────────────────────────────────
 * The owner's decision is 5 MB. The reasoning, so the number is reviewable
 * rather than arbitrary:
 *
 * • It must ADMIT every legitimate payload. The largest single write this API
 *   accepts is a bulk task update — `BulkUpdateTasksSchema` caps at 100 task ids
 *   (`server/src/schemas/task.ts`), and each task's own `description` is capped
 *   at 10 000 characters. Even a pathological legal request — 100 tasks at the
 *   full 10 000-character description, plus JSON escaping and UUID overhead —
 *   lands around 2 MB, comfortably inside 5 MB. A bulk reorder of 100 board
 *   columns or a 100-status reorder is orders of magnitude smaller. There is no
 *   file upload, no binary attachment and no import endpoint in this product,
 *   so nothing legitimate approaches the ceiling.
 *
 * • It must be BELOW the platform's own cap, so the application rejects with
 *   its own contract rather than being cut off by the edge. Cloudflare Workers
 *   accepts request bodies far larger than 5 MB; the point of a smaller
 *   application limit is to answer 413 in the standard error envelope — naming
 *   the limit — instead of letting a multi-megabyte allocation happen and then
 *   failing somewhere less legible. (The exact platform ceiling is a platform
 *   fact this change does not depend on and does not assert.)
 *
 * • It must still BOUND a pathological allocation. 5 MB is deliberately
 *   generous rather than tight: the goal is to cap the damage a single request
 *   can do to an isolate, not to shave the last few percent off an attack that
 *   is already capped. A tighter value (say 1 MB) would risk rejecting a legal
 *   bulk write for no security gain worth the support cost; a looser one (say
 *   50 MB) would be closer to "no cap" than to a cap. 5 MB sits at the point
 *   where the largest legal payload has roughly 2.5× of headroom and a
 *   pathological one is still bounded by a number this repository owns.
 *
 * ── 413, in the application's own envelope ───────────────────────────────────
 * Hono's `bodyLimit` middleware throws an `HTTPException(413)` carrying a bare
 * `text/plain` body by default. That would be a raw platform-shaped error
 * escaping the `{ error: { code, message } }` contract every client parses, so
 * `onError` is supplied and it renders the standard envelope itself. The status
 * is 413 (`Content Too Large` / historically `Payload Too Large`) — the
 * semantically correct one, and the one a client can act on (do not retry,
 * shrink the payload) rather than the generic 400.
 *
 * ── Why the code is `PAYLOAD_TOO_LARGE` ──────────────────────────────────────
 * The bespoke code is the precise answer: the shape of the request is legal,
 * its SIZE is not, so the user is told to send less rather than to check their
 * input. It was left as `VALIDATION_ERROR` when this cap landed, because a
 * member of the shared `ERROR_CODES` list makes the client's exhaustive
 * `Record<ErrorCode, string>` message map (`ui/src/app/interceptors/
 * error.interceptor.ts`) fail to compile until it has an entry — and shipping a
 * code the client cannot render is worse than reusing one it can, since an
 * unrecognised code falls through to a generic message and the 413 arrives
 * unexplained. That follow-up is now done, in the one commit the note asked
 * for: the member is in `shared/src/types/common.ts`, the client maps it to
 * `errors.payloadTooLarge`, and all eleven locale files carry that string
 * (`ui/scripts/check-i18n.mjs` and `ui/src/app/shared/testing/
 * shared-contract.spec.ts` are what hold it there).
 */
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/context.js';

/** 5 MB, expressed in bytes. See the file header for why this value. */
export const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

/** Human-readable form used in the 413 message, so the client can see the limit. */
export const MAX_REQUEST_BODY_LABEL = '5 MB';

/**
 * The framework-level body cap. Mounted on `/api/*` BEFORE anything reads the
 * body (auth, the DB middleware, the zod body validators), so an over-sized
 * upload is refused without a service graph, a database connection or a parse.
 *
 * `Content-Length` is checked first when present (Hono's own behaviour, and
 * the cheap path); a chunked request with no declared length is measured while
 * streaming and cut off as soon as it crosses the cap, so the cap holds for a
 * request that lies about (or omits) its length.
 */
export function requestBodyLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Request body must not exceed ${MAX_REQUEST_BODY_LABEL}`,
          },
        },
        413,
      ),
  });
}
