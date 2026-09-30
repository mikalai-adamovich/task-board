/**
 * The compensating security headers, asserted on BOTH tiers.
 *
 * The defect this closes is an ABSENCE, and an absence is exactly the kind of
 * thing a test has to be written for deliberately: nothing in the application
 * referenced these header names, so nothing failed when they were missing and
 * nothing will fail if a later edit drops one. This file is that something.
 *
 * TWO TIERS, ONE INVARIANT. The deployment has two halves — the static site
 * (Cloudflare Pages, `ui/public/_headers`) and the cross-origin API (the
 * Worker, `server/src/middleware/security-headers.ts`). The audit found
 * neither carrying the headers, and fixing one tier while leaving the other is
 * the obvious half-fix: a browser will happily accept a document from one
 * origin that forbids framing and a response from the other that does not. So
 * the cross-tier assertions below are the point, not the individual values.
 *
 * The static tier is asserted by READING the deployed file rather than by
 * booting a server, because the file is the artefact: `ui/angular.json` copies
 * `ui/public/**` into the build output verbatim, so `_headers` is what
 * Cloudflare Pages reads. A test that rendered the page would assert about the
 * application and not about the header file that is actually shipped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import { API_CSP, SECURITY_HEADERS, securityHeaders } from '../middleware/security-headers.js';
import type { AppEnv } from '../types/context.js';

/** `server/src/middleware` -> `server/` -> repo root, then the static tier's file. */
const STATIC_HEADERS_FILE = join(dirname(import.meta.filename), '..', '..', '..', 'ui', 'public', '_headers');
const STATIC_HEADERS = readFileSync(STATIC_HEADERS_FILE, 'utf8');
/**
 * The header names both tiers must carry. Written out here rather than derived
 * from `SECURITY_HEADERS`, so removing one from the implementation fails this
 * test instead of quietly redefining the requirement to match the code.
 */
const REQUIRED_HEADERS = [
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

describe('C-4: the API tier sends the standard security headers', () => {
  /** The middleware in the position it is mounted in `app.ts`. */
  function app() {
    const instance = new Hono<AppEnv>();

    instance.onError(errorHandler);
    instance.use('*', requestIdMiddleware);
    instance.use('*', securityHeaders());
    instance.get('/ok', (c) => c.json({ data: { ok: true } }));
    instance.get('/boom', () => {
      throw new Error('handler failure');
    });

    return instance;
  }

  it('sets every required header on a SUCCESS response', async () => {
    const res = await app().request('/ok');

    expect(res.status).toBe(200);
    for (const name of REQUIRED_HEADERS) {
      expect(res.headers.get(name), `${name} missing from a success response`).not.toBeNull();
    }
  });

  it('sets them on an ERROR response too — the rejection path is the one under attack', async () => {
    // A 500 is exactly when a header is worth having, and a middleware mounted
    // at the wrong depth (inside the routes rather than at `*`) would set them
    // on successes and lose them here.
    const res = await app().request('/boom');

    expect(res.status).toBe(500);
    for (const name of REQUIRED_HEADERS) {
      expect(res.headers.get(name), `${name} missing from an error response`).not.toBeNull();
    }
  });

  it('sets them on a NOT-FOUND response, which no handler ever runs for', async () => {
    // `notFound` short-circuits before any handler; only a middleware mounted
    // ahead of the router can put headers on this response.
    const instance = app();

    instance.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));

    const res = await instance.request('/nothing-here');

    expect(res.status).toBe(404);
    for (const name of REQUIRED_HEADERS) {
      expect(res.headers.get(name), `${name} missing from a not-found response`).not.toBeNull();
    }
  });

  it('the exported set and the middleware agree — the constant is the contract', async () => {
    // Guards the two halves of this module against drifting apart: the record
    // is what the tier documents, the middleware is what it sends.
    const res = await app().request('/ok');

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), `${name} not sent with its declared value`).toBe(value);
    }
  });

  it('is mounted in app.ts, ahead of the routes', () => {
    // A middleware that exists but is never mounted is the exact regression this
    // file is for, and it is invisible from the middleware's own tests.
    const source = readFileSync(join(dirname(import.meta.filename), '..', 'app.ts'), 'utf8');
    const mountedAt = source.indexOf("app.use('*', securityHeaders())");

    expect(mountedAt, 'app.ts must mount securityHeaders()').toBeGreaterThan(-1);
    expect(mountedAt, 'security headers must be mounted before the first route').toBeLessThan(
      source.indexOf("app.get('/api/ping'"),
    );
  });
});

describe('C-4: the STATIC tier sends the same headers', () => {
  /**
   * Parse the `_headers` file into `pattern -> header names`, ignoring comments
   * and the blank lines that separate blocks. Cloudflare Pages' format is
   * `Name: value` indented under a path pattern.
   */
  function parsedBlocks(): Map<string, Set<string>> {
    const blocks = new Map<string, Set<string>>();
    let current: Set<string> | null = null;

    for (const rawLine of STATIC_HEADERS.split('\n')) {
      const line = rawLine.trim();

      if (line.length === 0 || line.startsWith('#')) {
        continue;
      }

      // A path pattern is not indented in the source and carries no colon-space.
      if (!/^\s/.test(rawLine) && !line.includes(': ')) {
        current = new Set<string>();
        blocks.set(line, current);
        continue;
      }

      const name = line.split(':', 1)[0];

      if (name !== undefined) {
        current?.add(name);
      }
    }

    return blocks;
  }

  it('the file exists and is read by the platform from the build output', () => {
    // The file has to be in `ui/public/` — `ui/angular.json` copies that
    // directory into the deployed root, and Pages reads `_headers` from there.
    // A file anywhere else would be a correct-looking file that never ships.
    expect(STATIC_HEADERS.length).toBeGreaterThan(0);
    expect(STATIC_HEADERS_FILE.endsWith(join('ui', 'public', '_headers'))).toBe(true);
  });

  it('applies the required headers to every path', () => {
    const root = parsedBlocks().get('/*');

    expect(root, 'the _headers file must have a /* block').toBeDefined();
    for (const name of REQUIRED_HEADERS) {
      expect(root?.has(name), `${name} is not set for /* in ui/public/_headers`).toBe(true);
    }
  });

  it('carries a Content-Security-Policy in REPORT-ONLY mode, never enforcing', () => {
    // The staged rollout the owner approved. If an enforcing header ever
    // appears here, the switch has happened without the four prerequisites the
    // file header lists — and this test is the thing that noticed.
    const root = parsedBlocks().get('/*');

    expect(root?.has('Content-Security-Policy-Report-Only')).toBe(true);
    expect(root?.has('Content-Security-Policy'), 'the policy must not be enforcing yet').toBe(false);
    expect(STATIC_HEADERS).toContain('report-uri /__csp-report');
  });

  it('names what an enforcing switch would need, so the decision stays reviewable', () => {
    // The report-only phase is only worth running if somebody can act on it.
    // These four are the prerequisites; the comment must keep naming them.
    for (const prerequisite of ['REPORT COLLECTOR', 'DEPLOYED API ORIGIN', 'ROLLBACK COMMIT']) {
      expect(STATIC_HEADERS, `the _headers comment no longer records: ${prerequisite}`).toContain(prerequisite);
    }
  });
});

describe('C-4: the two tiers agree on the header NAMES they send', () => {
  it('every header the API sends is also set on the static tier', () => {
    // The cross-tier invariant. A name present on one tier and absent from the
    // other is a half-fix, and it is the shape this defect actually had.
    const root = parsedBlockNames();

    for (const name of Object.keys(SECURITY_HEADERS)) {
      if (name === 'Content-Security-Policy-Report-Only') {
        continue; // Compared by mode in the block below, not by name.
      }
      expect(root.has(name), `${name} is sent by the API but not by the static tier`).toBe(true);
    }
  });

  it('both tiers are in report-only mode for the CSP', () => {
    const root = parsedBlockNames();

    expect(SECURITY_HEADERS['Content-Security-Policy-Report-Only']).toBe(API_CSP);
    expect(root.has('Content-Security-Policy-Report-Only')).toBe(true);
    expect(root.has('Content-Security-Policy')).toBe(false);
  });
});

/** The `/*` block's header names, for the cross-tier comparisons above. */
function parsedBlockNames(): Set<string> {
  const names = new Set<string>();
  let inRoot = false;

  for (const rawLine of STATIC_HEADERS.split('\n')) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    if (!/^\s/.test(rawLine) && !line.includes(': ')) {
      inRoot = line === '/*';
      continue;
    }

    if (inRoot) {
      const name = line.split(':', 1)[0];

      if (name !== undefined) {
        names.add(name);
      }
    }
  }

  return names;
}
