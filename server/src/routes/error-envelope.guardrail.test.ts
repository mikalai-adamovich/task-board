/**
 * Error-envelope guardrail.
 *
 * The contract every client depends on is that a 4xx/5xx answer is JSON of the
 * shape `{ error: { code, message } }` and nothing else. F6 (not-found / 405)
 * and F11 (`QUERY_TIMEOUT`) closed the two biggest holes; F15 adds the E11000 →
 * 409 mappings. What none of them can do is stop the NEXT route from
 * reintroducing one with a hand-rolled `c.text('Not found', 404)` or a
 * `c.json({ message: 'oops' }, 500)`.
 *
 * THIS TEST is that enforcement point, in the same spirit as F5's route table
 * and F9's path-parameter guardrail: a source-level scan that fails the build
 * rather than a review comment. It stays deliberately simple — a scan, not a
 * type system.
 *
 * Scans `routes/**`, `middleware/**` (recursively, specs excluded) plus the two
 * composition-root sources that build responses themselves (`app.ts`,
 * `index.ts`) and asserts:
 *   1. the scan actually finds route sources (a rename must not silently
 *      disable the guardrail);
 *   2. no handler builds a response with `c.text` / `c.body` / `c.html` /
 *      `new Response` — those bypass the JSON envelope by construction;
 *   3. every `c.json(body, status)` whose status is 4xx/5xx renders an
 *      `error:` envelope (a 2xx must never carry one, and a 4xx/5xx must never
 *      carry a bare body);
 *   4. every failure response built OUTSIDE the envelope implementation is a
 *      declared exception — checked in both directions, so the list can neither
 *      grow quietly nor rot quietly.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorHandler } from '../middleware/error-handler.js';
import { assertCorrespondence } from '../testing/correspondence.js';
import { Hono } from 'hono';
import type { AppEnv } from '../types/context.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` type clash
// that `fileURLToPath(new URL(...))` runs into under @cloudflare/workers-types.
const SRC_DIR = join(dirname(import.meta.filename), '..');
/** Directory trees scanned recursively — a route module in a subdirectory is a route. */
const SCANNED_DIRS = ['routes', 'middleware'];
/**
 * Every source that builds a failure response of its own, and why. An entry is a
 * `<path>:<status>` pair — a path survives any edit above the line, a line
 * number does not.
 */
const ENVELOPE_EXCEPTIONS: Record<string, string> = {
  'routes/readyz.ts:503':
    'the readiness probe renders its own envelope so an orchestrator can poll it without the client error contract (Q-14)',
  'app.ts:503':
    'the MONGODB_URI fail-fast answers before a service graph exists, so there is no AppError to throw; it renders the standard envelope directly',
  'middleware/body-limit.ts:413':
    'the 5 MB body cap (decision 20) is rendered here rather than thrown: the framework body-limit onError must RETURN a Response, and its default would be a bare text/plain body escaping the client contract',
};
/**
 * Single sources at the root that render responses themselves. `app.ts` used to
 * sit outside the scan entirely while building a 503 of its own, which is the
 * kind of gap that lets the next one in unremarked.
 */
const SCANNED_FILES = ['app.ts', 'index.ts'];

/** Every `.ts` file under `dir`, recursively, as a `/`-separated relative path. */
function sourceFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

/** Sources that render an HTTP response (specs excluded — a spec may build its own app). */
const sources = [
  ...SCANNED_DIRS.flatMap((dir) =>
    sourceFiles(join(SRC_DIR, dir)).map((entry) => ({
      path: `${dir}/${entry}`,
      text: readFileSync(join(SRC_DIR, dir, entry), 'utf8'),
    })),
  ),
  ...SCANNED_FILES.map((file) => ({ path: file, text: readFileSync(join(SRC_DIR, file), 'utf8') })),
].filter((source) => source.path.endsWith('.ts') && !source.path.endsWith('.test.ts'));
/** Response constructors that CANNOT produce the JSON envelope. */
const NON_ENVELOPE_WRITERS = /\bc\.(?:text|body|html)\s*\(|new Response\s*\(/;

/**
 * Split the argument list of `c.json(` starting at `open` (the index of the
 * opening paren) into top-level arguments. Commas nested inside an object,
 * array, call or string do not separate arguments.
 */
function jsonArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  for (let i = open + 1; i < source.length; i += 1) {
    const char = source[i] as string;

    if (quote) {
      current += char;
      if (char === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;

    if (char === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }

    current += char;

    if (depth === 0 && char === ')') {
      args.push(current);
      break;
    }
  }

  return args.map((arg) => arg.trim());
}

interface JsonCall {
  path: string;
  body: string;
  status: string;
}

function jsonCalls(source: { path: string; text: string }): JsonCall[] {
  const calls: JsonCall[] = [];

  for (const match of source.text.matchAll(/\bc\.json\s*\(/g)) {
    const open = (match.index as number) + (match[0] as string).length - 1;
    const args = jsonArguments(source.text, open);

    if (args.length >= 2) {
      calls.push({ path: source.path, body: args[0] as string, status: args[1] as string });
    }
  }

  return calls;
}

const allJsonCalls = sources.flatMap(jsonCalls);
const withStatus = allJsonCalls.filter((call) => /^\d{3}$/.test(call.status));

describe('error envelope guardrail (F15)', () => {
  it('1: the scan actually finds route and middleware sources', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(allJsonCalls.length).toBeGreaterThan(50);
  });

  it('2: no handler bypasses the JSON envelope with c.text / c.body / c.html / new Response', () => {
    const offenders = sources.filter((source) => NON_ENVELOPE_WRITERS.test(source.text)).map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  it('3: every c.json with a 4xx/5xx status renders an { error: { … } } envelope', () => {
    const offenders = withStatus
      .filter((call) => call.status.startsWith('4') || call.status.startsWith('5'))
      .filter((call) => !/\berror\s*:/.test(call.body))
      .map((call) => `${call.path}: c.json(${call.body}, ${call.status})`);

    expect(offenders).toEqual([]);
  });

  it('3b: no successful (2xx) response carries an error envelope', () => {
    const offenders = withStatus
      .filter((call) => call.status.startsWith('2'))
      .filter((call) => /\berror\s*:/.test(call.body))
      .map((call) => `${call.path}: c.json(${call.body}, ${call.status})`);

    expect(offenders).toEqual([]);
  });

  it('3c: every failure response built outside the envelope implementation is a declared exception', () => {
    // `middleware/error-handler.ts` and `middleware/not-found.ts` ARE the
    // envelope — they must build one response per status. Everything else is a
    // source that decided to answer a failure itself. The key is the source path
    // and the status (not a line number, which any edit above it invalidates),
    // and each entry must carry its reason. Both directions are asserted, so an
    // undeclared inline failure AND an entry that no longer describes anything
    // fail here.
    const ENVELOPE_PRODUCERS = ['middleware/error-handler.ts', 'middleware/not-found.ts'];
    const inline = [
      ...new Set(
        withStatus
          .filter((call) => call.status.startsWith('4') || call.status.startsWith('5'))
          .filter((call) => !ENVELOPE_PRODUCERS.includes(call.path))
          .map((call) => `${call.path}:${call.status}`),
      ),
    ];

    for (const [key, reason] of Object.entries(ENVELOPE_EXCEPTIONS)) {
      expect(reason.length, `${key} must say why it builds its own failure response`).toBeGreaterThan(0);
    }

    assertCorrespondence('declared error-envelope exceptions', Object.keys(ENVELOPE_EXCEPTIONS), inline);
  });
});

describe('error envelope shape (runtime)', () => {
  it('every error path of the global handler yields { error: { code, message } }', async () => {
    const app = new Hono<AppEnv>();

    app.onError(errorHandler);
    app.get('/app-error', () => {
      throw new Error('boom');
    });
    app.get('/not-found', () => {
      const err = new Error('nope') as Error & { status: number };

      err.status = 404;
      throw err;
    });

    for (const path of ['/app-error', '/not-found']) {
      const res = await app.request(path);
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(typeof body.error?.code).toBe('string');
      expect(typeof body.error?.message).toBe('string');
    }
  });
});
