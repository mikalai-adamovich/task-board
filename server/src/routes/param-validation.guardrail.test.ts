/**
 * Path parameter validation guardrail.
 *
 * 62 path parameters across 48 routes used to reach MongoDB completely
 * unvalidated. The fix is `pathParamValidation()` middleware mounted once per
 * route factory (see `middleware/validation.ts`), driven by the per-name schema
 * registry in `validators/path-params.ts`.
 *
 * Middleware alone is not enough: it is possible for a new route to be added to
 * a factory that forgets the `use(...)` line, or to declare a `:param` that the
 * registry has never heard of. THIS TEST is the enforcement point — it fails
 * the build (not just the review) in both cases. It is deliberately a test
 * rather than a lint rule: the assertions are semantic (does this source file
 * register the middleware? is this declared parameter covered by a schema? is
 * this handler reading the parameter through the validated accessor?), which a
 * purely syntactic ESLint rule cannot express, and it runs in the same
 * `npm test` gate the rest of the suite already lives in.
 *
 * Scans `server/src/routes/**` (RECURSIVELY, excluding specs) and asserts:
 *   1. no route file reads a path parameter via a bare `c.req.param(`;
 *   2. every factory that declares a `:param` registers `pathParamValidation()`;
 *   3. every `:param` declared anywhere in `routes/**` has a schema in
 *      `PATH_PARAM_SCHEMAS`;
 *   4. the inventory is not silently empty (a scan that matches nothing must
 *      fail, otherwise a rename would disable the guardrail).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATH_PARAM_NAMES, pathParamSchema } from '../validators/path-params.js';
import { routeParamNames } from '../middleware/validation.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` type clash
// that `fileURLToPath(new URL(...))` runs into under @cloudflare/workers-types.
const ROUTES_DIR = dirname(import.meta.filename);
/**
 * Route sources, recursively — a route module in a subdirectory is still a
 * route module, and a flat `readdirSync` would have stopped covering the tree the
 * moment one appeared. Specs excluded: a spec is allowed to build a bare app.
 */
const routeSources = readdirSync(ROUTES_DIR, { recursive: true })
  .map((entry) => String(entry))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort();

interface FactoryFacts {
  file: string;
  name: string;
  /** Source of the factory body only (not the whole file). */
  body: string;
  declaredParams: string[];
}

const ROUTE_REGISTRATION = /\.(?:get|post|put|patch|delete|options|head|all)\(\s*'([^']*)'/g;
const FACTORY_HEADER = /export function (create\w+Routes)\(/g;
// No `g` flag on purpose: this regex is used with `.test()` across many sources,
// and a global regex carries a stateful `lastIndex` between calls.
const REGISTRATION = /router\.use\('\*', pathParamValidation\(\)\);/;
const facts: FactoryFacts[] = routeSources.flatMap((file) => {
  const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
  const headers = [...source.matchAll(FACTORY_HEADER)];

  return headers.map((header, index) => {
    // The factory body runs from its header to the next factory header (or EOF).
    const start = header.index ?? 0;
    const end = headers[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);

    return {
      file,
      name: header[1] ?? 'unknown',
      body,
      declaredParams: declaredParamsIn(body),
    };
  });
});

/**
 * Every `:param` declared by a route-registration call in a source chunk:
 * `router.get('/projects/:projectId/tasks', …)`.
 */
function declaredParamsIn(source: string): string[] {
  const names: string[] = [];

  for (const match of source.matchAll(ROUTE_REGISTRATION)) {
    for (const name of routeParamNames(match[1] ?? '')) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }

  return names;
}

const allParams = [...new Set(facts.flatMap((f) => f.declaredParams))].sort();
const factoriesWithParams = facts.filter((f) => f.declaredParams.length > 0);
const filesWithParams = new Set(factoriesWithParams.map((f) => f.file));

describe('path parameter validation guardrail (F9)', () => {
  it('4: the scan actually finds route sources (a rename must not silently disable it)', () => {
    expect(routeSources.length).toBeGreaterThan(10);
    expect(facts.length).toBeGreaterThan(10);
    expect(filesWithParams.size).toBeGreaterThan(10);
    expect(allParams.length).toBeGreaterThan(10);
  });

  it('1: no route file reads a path parameter via a bare c.req.param(', () => {
    const offenders = routeSources.filter((file) =>
      /c\.req\.param\b/.test(readFileSync(join(ROUTES_DIR, file), 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('1b: no route file destructures c.req.params / spreads the param object', () => {
    const offenders = routeSources.filter((file) =>
      /c\.req\.params\b|\.\.\.c\.req\.param\(/.test(readFileSync(join(ROUTES_DIR, file), 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('2: every factory that declares a path parameter registers pathParamValidation()', () => {
    // Scoped to the factory BODY, not the file: a param-free sibling factory
    // (e.g. createUserPreferencesRoutes) must not demand its own registration,
    // and a factory that declares `:param` without the `use(...)` line fails.
    const offenders = factoriesWithParams.filter((f) => !REGISTRATION.test(f.body)).map((f) => `${f.file}:${f.name}`);

    expect(offenders).toEqual([]);
  });

  it('3: every declared path parameter has a schema in PATH_PARAM_SCHEMAS', () => {
    const uncovered = allParams.filter((name) => pathParamSchema(name) === undefined);

    expect(uncovered).toEqual([]);
  });

  it('3b: every registered schema name is actually declared by some route (no dead entries)', () => {
    const unused = PATH_PARAM_NAMES.filter((name) => !allParams.includes(name));

    expect(unused).toEqual([]);
  });
});
