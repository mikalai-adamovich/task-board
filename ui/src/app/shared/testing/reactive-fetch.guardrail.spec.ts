/**
 * F21 guardrail: data fetching must not live inside an `effect()`, and no
 * `rxResource` may fire with blank params.
 *
 * The audit that produced this rule found two hand-rolled
 * `effect(() => { …client.get(…).subscribe(…) })` fetches and five `rxResource`s
 * whose `stream` ran with an empty id. Both are the same bug class from the
 * user's point of view: a request is issued with an id the route does not have
 * yet (`/projects//tasks`, `/projects//filters`, …), the response is the
 * SPA-fallback HTML rather than JSON, and the resource is poisoned with a
 * JSON-parse error — the page then shows an empty state forever.
 *
 * The rules are asserted against the SOURCES, not against one rendered
 * instance, which is strictly stronger: it covers every component and store,
 * including ones no unit test instantiates. The same pattern is used by
 * `icon-button-names.spec.ts` and by the server-side
 * `param-validation.guardrail.test.ts`.
 *
 * Rule A — no FETCH PRIMITIVE inside an `effect(...)` body. In Angular 22 a
 *   fetch belongs in `resource`/`rxResource` over a `*-client.ts` service: the
 *   resource cancels the request on teardown and on param change, and routes
 *   failures to `error()`. An effect can do neither.
 *
 *   The callee set is the set of ways this codebase can issue a request, not one
 *   spelling of it: `.subscribe(`, `firstValueFrom(`, `.toPromise(`
 *   and `fetch(`. Before, only `.subscribe(` was checked, so the identical bug
 *   written with a promise was green. The rule is about *fetching*, never about
 *   a particular API: `effect(() => this.refStore.ensure(pid, [...]))` — the
 *   pattern `AGENTS.md` prescribes for shared per-project reference data — still
 *   passes, because the store owns the request, dedupes it and caches it; only
 *   the effect's own direct call is forbidden.
 *
 * Rule B — every `resource`/`rxResource`/`httpResource` must short-circuit on a
 *   blank param, i.e. not issue the request when a required id is falsy.
 *
 *   The guard is detected as a PROPERTY, not as a list of accepted spellings
 *   The resource's declared param names are read out of its own
 *   `params:` literal, and the call is accepted when at least one of those names
 *   is tested for absence before the request — in a ternary, a logical
 *   short-circuit, a comparison against `null`/`undefined`/`''`, or a negation.
 *   Before, only two regexes were accepted, so a correct third spelling failed
 *   the suite while a resource guarding the WRONG param passed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

/**
 * The ways an effect can issue a request in this codebase. `firstValueFrom` and
 * `.toPromise()` are what the promise-shaped rewrite of the original F21 defect
 * looks like, and `fetch(` is what a hand-rolled `HttpClient` bypass looks like.
 */
const FETCH_PRIMITIVES: { name: string; pattern: RegExp }[] = [
  { name: '.subscribe()', pattern: /\.subscribe\s*\(/ },
  { name: 'firstValueFrom()', pattern: /(?<![\w$.])firstValueFrom\s*\(/ },
  { name: '.toPromise()', pattern: /\.toPromise\s*\(/ },
  { name: 'fetch()', pattern: /(?<![\w$.])fetch\s*\(/ },
];
/** The three spellings of Angular's request-carrying resource. */
const RESOURCE_FACTORIES = ['resource', 'rxResource', 'httpResource'] as const;

/** Recursively collect every non-spec `.ts` source under `ui/src/app`. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collectSources(path, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(path);
  }

  return out;
}

/** Skip a string/template literal starting at `start`; returns the closing index. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    // A backtick template may embed `${…}` with a nested template; the
    // approximation below treats the FIRST unescaped backtick as the end,
    // which is correct for every call body in this codebase.
    i++;
  }

  return -1;
}

/** Index of the `(` that opens the call whose callee ends before `from`. */
function openParen(source: string, from: number): number {
  const match = /\(/.exec(source.slice(from));

  return match ? from + match.index : -1;
}

/**
 * Extract the balanced text of the call whose opening paren is at `openIdx`.
 * Skips comments, string/template literals and regex literals so that braces or
 * parens inside them cannot corrupt the depth counting.
 */
function balancedCall(source: string, openIdx: number): string | null {
  let depth = 0;
  let previousSignificant = '';

  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (ch === '/' && next === '/') {
      const eol = source.indexOf('\n', i);

      if (eol < 0) return null;
      i = eol;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);

      if (end < 0) return null;
      i = end + 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(source, i);

      if (end < 0) return null;
      i = end;
      previousSignificant = 'x';
      continue;
    }

    // Regex literal: a `/` in operand position (never after a value char).
    if (ch === '/' && '(,=:[!&|?{};+-*%~^<>'.includes(previousSignificant)) {
      let j = i + 1;
      let inClass = false;

      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        else if (source[j] === '\n') break;
        j++;
      }
      i = j;
      previousSignificant = 'x';
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;

      if (depth === 0) return source.slice(openIdx, i + 1);
    }

    if (!/\s/.test(ch)) previousSignificant = ch;
  }

  return null;
}

/** Every `<name>(…)` call site in a source, as `{ line, text }`. */
function callSites(source: string, name: string): { line: number; text: string }[] {
  const sites: { line: number; text: string }[] = [];
  // Word boundary that also rejects `fooEffect(` / `some.rxResource(`.
  const marker = new RegExp(`(?<![\\w$.])${name}(?=\\s*(<[^;=()]*>)?\\s*\\()`, 'g');

  for (const match of source.matchAll(marker)) {
    const start = match.index as number;
    const openIdx = openParen(source, start + match[0].length - (match[0].endsWith('(') ? 1 : 0));

    if (openIdx < 0) continue;

    const text = balancedCall(source, openIdx);

    if (text === null) continue;

    sites.push({ line: source.slice(0, start).split('\n').length, text });
  }

  return sites;
}

/**
 * Deliberate, justified exceptions to Rule A. Each entry must keep MATCHING its
 * source (a needle that only exists in that call body) — the
 * "every declared exemption is still in use" test fails as soon as the code
 * changes, so the allowlist can never quietly grow stale.
 */
const EFFECT_FETCH_EXEMPTIONS: { file: string; needle: string; reason: string }[] = [
  {
    file: 'features/tenants/create-workspace/create-workspace.ts',
    needle: 'isSlugAvailable',
    reason:
      'Debounced slug-availability probe: the request is issued from a setTimeout ' +
      'callback, not from the effect body, and is already guarded by isValidTenantSlug, ' +
      'a per-slug dedupe and a stale-response check. Converting it to a resource would ' +
      'change the debounce contract and the "checking" state machine (out of F21 scope).',
  },
];

/** The param names a resource declares, read from its own `params:` literal. */
function declaredParamNames(call: string): string[] {
  const literal = /params\s*:\s*\(\s*\)\s*=>\s*\(\s*\{([\s\S]*?)\}/.exec(call)?.[1] ?? '';
  const names = [...literal.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*[,:}]/g)].map((match) => match[1] as string);

  return [...new Set(names)].filter((name) => name !== 'params' && name !== 'return');
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the call tests one of its OWN declared params for absence — the
 * property "do not request until the id is meaningful", independent of how it
 * is spelled. `guard` is null when the resource declares no params (nothing to
 * be blank, so nothing to guard).
 */
function paramGuard(call: string): RegExp | null {
  const names = declaredParamNames(call);

  if (names.length === 0) return null;

  // A reference to a declared param, with or without the `params.` the stream
  // destructures it through. The lookbehind rejects `this.projectId()`, so a
  // signal READ that happens to share the name is not mistaken for a test.
  const ref = `(?:params\\s*\\.\\s*)?(?:${names.map(escapeRe).join('|')})`;

  return new RegExp(
    // x is used as a condition — `x ? … : …`, `x && …`, `x || …`, `x ?? …`,
    // `x == null`, `x === ''` …
    `(?<![\\w$.])${ref}\\s*(?:\\?|&&|\\|\\||\\?\\?|===|==|!==|!=)` +
      // … or x is negated before the request runs: `if (!x) return of(…)`
      `|!\\s*${ref}(?![\\w$])`,
  );
}

function scanSource(source: string, file: string): { subscribeInEffect: Offender[]; unguarded: Offender[] } {
  const subscribeInEffect: Offender[] = [];
  const unguarded: Offender[] = [];
  const label = relative(SRC, file).split(sep).join('/');

  for (const site of callSites(source, 'effect')) {
    const used = FETCH_PRIMITIVES.filter((primitive) => primitive.pattern.test(site.text));

    if (used.length === 0) continue;
    if (EFFECT_FETCH_EXEMPTIONS.some((e) => e.file === label && site.text.includes(e.needle))) continue;

    subscribeInEffect.push({
      file: label,
      line: site.line,
      snippet: `${used.map((p) => p.name).join('+')} — ${site.text.replace(/\s+/g, ' ').slice(0, 100)}`,
    });
  }

  // `resource`, `rxResource` and `httpResource` are the same construct with three
  // spellings; checking one of them left the other two unchecked.
  for (const name of RESOURCE_FACTORIES) {
    for (const site of callSites(source, name)) {
      const guard = paramGuard(site.text);

      if (guard !== null && !guard.test(site.text)) {
        unguarded.push({
          file: label,
          line: site.line,
          snippet: `${name}: declares ${declaredParamNames(site.text).join(', ')} but never tests one — ${site.text
            .replace(/\s+/g, ' ')
            .slice(0, 90)}`,
        });
      }
    }
  }

  return { subscribeInEffect, unguarded };
}

const sources = collectSources(SRC);
const scanned = sources.map((file) => ({ file, result: scanSource(readFileSync(file, 'utf8'), file) }));

describe('no data fetching inside effect() (F21)', () => {
  it('scans the whole ui/src/app source tree', () => {
    // Guards against a silently broken scanner: a rule that matches nothing is
    // indistinguishable from a rule that passes.
    expect(sources.length).toBeGreaterThan(60);
    expect(sources.some((f) => f.endsWith('tenant-home.ts'))).toBe(true);
  });

  it('every declared exemption is still in use (no stale allowlist entries)', () => {
    const unmatched = EFFECT_FETCH_EXEMPTIONS.filter(
      (exemption) =>
        !scanned.some(
          (s) =>
            s.file.endsWith(exemption.file) &&
            callSites(readFileSync(s.file, 'utf8'), 'effect').some(
              (site) =>
                site.text.includes(exemption.needle) &&
                FETCH_PRIMITIVES.some((primitive) => primitive.pattern.test(site.text)),
            ),
        ),
    );

    expect(unmatched.map((e) => `${e.file} (${e.needle})`)).toEqual([]);
  });

  it('finds no fetch primitive inside an effect()', () => {
    const report = scanned
      .flatMap((s) => s.result.subscribeInEffect)
      .map((o) => `${o.file}:${o.line}  ${o.snippet}`)
      .join('\n');

    expect(report).toBe('');
  });
});

describe('every resource guards its params (F21)', () => {
  it('finds at least one rxResource in the tree (scanner sanity)', () => {
    const total = sources.reduce(
      (sum, f) => sum + RESOURCE_FACTORIES.reduce((n, name) => n + callSites(readFileSync(f, 'utf8'), name).length, 0),
      0,
    );

    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('finds no resource that can fire with blank params', () => {
    const report = scanned
      .flatMap((s) => s.result.unguarded)
      .map((o) => `${o.file}:${o.line}  ${o.snippet}`)
      .join('\n');

    expect(report).toBe('');
  });
});

describe('the scanner itself (F21 guardrail meta-test)', () => {
  const scan = (src: string) => scanSource(src, join(SRC, 'fixture.ts'));

  it('flags a raw subscribe() inside an effect()', () => {
    const result = scan(`
      class A {
        constructor() {
          effect(() => {
            const id = this.route.params['id'];
            this.client.list(id).subscribe({ next: (r) => this.rows.set(r) });
          });
        }
      }
    `);

    expect(result.subscribeInEffect).toHaveLength(1);
  });

  it('accepts an effect that only delegates to a shared cache loader', () => {
    const result = scan(`
      class A {
        constructor() {
          effect(() => {
            const pid = this.projectId();
            if (!pid) return;
            this.refStore.sprintEntities(pid);
            void this.refStore.ensure(pid, ['sprints']).catch(() => {});
          });
        }
      }
    `);

    expect(result.subscribeInEffect).toHaveLength(0);
  });

  it('flags an rxResource whose stream runs with a blank projectId', () => {
    const result = scan(`
      const resource = rxResource({
        params: () => ({ projectId: this.projectId() }),
        stream: ({ params }) => this.taskClient.list(params.projectId, { limit: 5 }),
        defaultValue: [],
      });
    `);

    expect(result.unguarded).toHaveLength(1);
  });

  it('accepts every guard SPELLING, not a fixed list of two', () => {
    // The anti-coupling half: a correct third spelling of "don't request until
    // the id is meaningful" must pass. Each of these was rejected by the old
    // two-regex list even though none of them can fire with a blank id.
    const spellings: Record<string, string> = {
      ternary: `
        const r = rxResource({
          params: () => ({ projectId: this.projectId() }),
          stream: ({ params }) => (params.projectId ? this.client.list(params.projectId) : of([] as T[])),
          defaultValue: [] as T[],
        });
      `,
      earlyReturn: `
        const r = rxResource<number, { pid: string }>({
          params: () => ({ pid: this.projectId() }),
          stream: ({ params }) => {
            if (!params.pid) return of(0);
            return this.client.list(params.pid);
          },
          defaultValue: 0,
        });
      `,
      logicalAnd: `
        const r = rxResource({
          params: () => ({ sprintId: this.sprintId() }),
          stream: ({ params }) => params.sprintId && this.client.get(params.sprintId),
          defaultValue: null as S | null,
        });
      `,
      nullComparison: `
        const r = resource({
          params: () => ({ boardId: this.boardId() }),
          request: ({ params }) => (params.boardId == null ? null : this.client.get(params.boardId)),
          defaultValue: null,
        });
      `,
      multiParam: `
        const r = httpResource({
          params: () => ({ projectId: this.projectId(), ready: this.ready() }),
          request: ({ params }) => (params.projectId && params.ready ? this.client.list(params.projectId) : of([])),
          defaultValue: [],
        });
      `,
    };

    for (const [name, source] of Object.entries(spellings)) {
      expect(scan(source).unguarded, name).toHaveLength(0);
    }
  });

  it('rejects a resource that guards a param it did not declare', () => {
    // The property is "a DECLARED param is tested", not "something is tested":
    // guarding an unrelated local while the id stays blank still 404s.
    const result = scan(`
      const r = rxResource({
        params: () => ({ projectId: this.projectId() }),
        stream: ({ params }) => (this.unrelated ? this.client.list(params.projectId) : of([] as T[])),
        defaultValue: [] as T[],
      });
    `);

    expect(result.unguarded).toHaveLength(1);
  });

  it('does not require a guard from a resource that declares no params', () => {
    const result = scan(`
      const r = resource({
        request: () => this.client.list({ limit: 5 }),
        defaultValue: [],
      });
    `);

    expect(result.unguarded).toHaveLength(0);
  });

  it('flags every fetch primitive in an effect(), not only .subscribe()', () => {
    // The gap this scan exists for: the promise-shaped rewrite of the same defect was green.
    const primitives: Record<string, string> = {
      firstValueFrom: `effect(() => { void firstValueFrom(this.client.get()); });`,
      toPromise: `effect(() => { void this.client.get().toPromise(); });`,
      fetch: `effect(() => { void fetch('/api/tasks'); });`,
    };

    for (const [name, body] of Object.entries(primitives)) {
      const result = scan(`class A { run() { ${body} } }`);

      expect(
        result.subscribeInEffect.map((o) => o.snippet),
        name,
      ).toHaveLength(1);
    }
  });

  it('does not count a member named like the callee (fooEffect / store.rxResource)', () => {
    const result = scan(`
      class A {
        readonly sideEffect = () => this.client.list('x').subscribe();
        readonly cache = { rxResource: 1 };
        run() {
          this.sideEffect();
        }
      }
    `);

    expect(result.subscribeInEffect).toHaveLength(0);
    expect(result.unguarded).toHaveLength(0);
  });
});
