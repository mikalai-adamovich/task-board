/**
 * The prose MUSTs get enforcing artefacts.
 *
 * `AGENTS.md` states these as MUST with no test, no lint rule and no type
 * constraint, and three of the ten had already decayed with nothing loud. This
 * file moves the server-side ones to scans. Each scan asserts a **property**, not
 * today's shape: a scan that names the current call sites would block the next
 * correct fix, which is this file's whole point.
 *
 * | Rule | Property asserted here |
 * | ---- | ---------------------- |
 * | P-01 | A collection is reached through a service, never inline in a handler |
 * | P-02 | The service graph is request-scoped: no DB-backed collaborator is built at module level |
 * | P-03 | A repository extends `BaseRepository` or declares a dated, reasoned exception |
 * | P-04 | A request body is read only through a validated accessor |
 *
 * **P-06** (path parameters are validated by mounted middleware) already has its
 * own enforcing artefact and is deliberately not duplicated here:
 * `routes/param-validation.guardrail.test.ts`. Two scans for one rule is how
 * they drift.
 *
 * Every scan is comment-stripped first, so documenting a removed pattern in a
 * comment (which these files legitimately do) cannot trip a rule.
 *
 * The final describe block is **not** one of the P-xx rules: it is FX17's
 * cross-document scan, landed here because FX16 owns this file —
 * one scan per fact, in the file that already does source scanning.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(SRC, '..', '..');
/** Strip comments, keeping every offset and line break so `file:line` stays true. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');

function sourceFiles(dir: string, extension: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, extension));
    } else if (entry.endsWith(extension) && !entry.endsWith(`.test${extension}`)) {
      out.push(full);
    }
  }

  return out.sort();
}

const serverFiles = sourceFiles(SRC, '.ts');

/** 1-based line numbers of every match of `pattern` in comment-stripped source. */
function hitLines(source: string, pattern: RegExp): number[] {
  const stripped = code(source);
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(stripped)) !== null) {
    out.push(stripped.slice(0, match.index).split('\n').length);
  }

  return out;
}

/** `file:line` for every match of `pattern` in a file, comment-stripped. */
function hits(file: string, pattern: RegExp): string[] {
  return hitLines(readFileSync(file, 'utf8'), pattern).map((line) => `${relative(REPO_ROOT, file)}:${line}`);
}

// ─── P-01 ─────────────────────────────────────────────────────────────────────

describe('P-01 — a collection is reached through a service, never inline', () => {
  /**
   * `getCollection()` resolves the request's `Db` out of AsyncLocalStorage, so
   * an inline call in a handler is a route that talks to Mongo directly: no
   * tenant assertion, no RBAC, no audit. The composition root is the one place
   * that is supposed to name a collection, so it is where the rule stops — an
   * allow-list of PLACES, not of call sites, so a new collection added there is
   * fine and a new inline call anywhere else is not.
   */
  const COLLECTION_ACCESS_ALLOWED_IN = [join('container.ts'), join('db', 'mongo.ts')];

  it('has no inline getCollection() outside the composition root', () => {
    const offenders = serverFiles.flatMap((file) =>
      COLLECTION_ACCESS_ALLOWED_IN.includes(relative(SRC, file)) ? [] : hits(file, /\bgetCollection\s*\(/g),
    );

    expect(offenders).toEqual([]);
  });

  it('the matcher finds a collection access in code but not in a comment', () => {
    // Vacuity guard: an empty sweep is indistinguishable from a broken matcher.
    // Synthetic source, so the assertion is about the matcher and not about a
    // count that dies with the next repository.
    const source = [
      'const a = getCollection("tasks");',
      '// const b = getCollection("comments");',
      'const c = getCollection("labels");',
    ].join('\n');

    expect(hitLines(source, /\bgetCollection\s*\(/g)).toEqual([1, 3]);
    expect(hits(join(SRC, 'container.ts'), /\bgetCollection\s*\(/g).length).toBeGreaterThan(0);
  });
});

// ─── P-02 ─────────────────────────────────────────────────────────────────────

describe('P-02 — the service graph is request-scoped', () => {
  /**
   * A repository or a DB-backed service built at module level captures whatever
   * `Collection` it was handed — and in `durable` mode that is a pool inside a
   * Durable Object, shared by every request the DO serves. `container.ts` builds
   * the graph per request and `container.test.ts` fails on an undefined
   * dependency, so the rule is: nothing DB-backed is constructed at module
   * scope, anywhere.
   *
   * `rbacService` is a module-level instance of a class with no state and no
   * database handle — a policy table, not a collaborator — so it carries a
   * reasoned exception, in its own file, like every other one.
   */
  const MODULE_LEVEL_DB_COLLABORATOR =
    /^(?:export\s+)?(?:const|let|var)\s+\w+[^=\n]*=\s*new\s+\w*(?:Repository|Service)\s*\(/gm;
  const MODULE_LEVEL_DB_RESOLVER = /^(?:export\s+)?(?:const|let|var)\s+\w+[^=\n]*=\s*(?:getDb|getCollection)\s*\(/gm;
  const EXCEPTION_MARKER = /guardrail:no-module-level-(?:service|repository)\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)/;
  const offenders = serverFiles.flatMap((file) => [
    ...hits(file, MODULE_LEVEL_DB_COLLABORATOR),
    ...hits(file, MODULE_LEVEL_DB_RESOLVER),
  ]);

  it('builds no DB-backed collaborator at module level', () => {
    const unexplained = offenders.filter((at) => {
      const file = join(REPO_ROOT, at.split(':')[0] ?? '');
      const source = readFileSync(file, 'utf8');

      return !EXCEPTION_MARKER.test(source);
    });

    expect(unexplained).toEqual([]);
  });

  it('requires every module-level exception to carry a date and a reason', () => {
    for (const at of offenders) {
      const file = join(REPO_ROOT, at.split(':')[0] ?? '');
      const source = readFileSync(file, 'utf8');
      const marker = source.match(EXCEPTION_MARKER);

      expect(marker, `${file} has a module-level collaborator with no guardrail marker`).not.toBeNull();
      expect(marker?.[1] ?? '').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((marker?.[2] ?? '').trim().length).toBeGreaterThan(20);
    }
  });
});

// ─── P-03 ─────────────────────────────────────────────────────────────────────

describe('P-03 — a repository extends BaseRepository or declares why not', () => {
  const repositories = sourceFiles(join(SRC, 'repositories'), '.ts').filter(
    (file) => !file.endsWith('base.repository.ts'),
  );
  const EXCEPTION =
    /guardrail:no-base-repository\s+(\d{4}-\d{2}-\d{2})\s+—\s+([\s\S]+?)(?=\n(?:\/\/|\s*\/\*|import |export |const |function |interface )|$)/;
  const EXCEPTION_HEAD = /guardrail:no-base-repository\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)/;
  const report = repositories.map((file) => {
    const source = readFileSync(file, 'utf8');

    return {
      file: relative(REPO_ROOT, file),
      extendsBase: /extends\s+BaseRepository\b/.test(code(source)),
      exception: source.match(EXCEPTION_HEAD),
    };
  });

  it('has no repository that is neither derived nor excepted', () => {
    expect(report.filter((entry) => !entry.extendsBase && entry.exception === null).map((entry) => entry.file)).toEqual(
      [],
    );
  });

  it('requires every exception to state a date and a substantive reason', () => {
    for (const entry of report) {
      if (entry.extendsBase) {
        // A converted repository must drop its exception, or the next reader
        // inherits a stale justification for a constraint that no longer holds.
        expect(entry.exception === null ? '' : entry.file).toBe('');
        continue;
      }

      expect(entry.exception, `${entry.file} extends nothing and excepts nothing`).not.toBeNull();
      expect(entry.exception?.[1] ?? '').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(EXCEPTION.test(readFileSync(join(REPO_ROOT, entry.file), 'utf8'))).toBe(true);
    }
  });

  it('sweeps every repository file (the scan is not vacuous)', () => {
    expect(repositories.length).toBeGreaterThan(15);
    expect(report.some((entry) => entry.extendsBase)).toBe(true);
  });
});

// ─── P-04 ─────────────────────────────────────────────────────────────────────

describe('P-04 — a request body is read only through a validated accessor', () => {
  /**
   * `validateBody(schema)` is this repository's `zValidator('json', schema)`
   * (see `middleware/validation.ts`); the parsed, typed value is then read with
   * `c.req.valid('json')`. Two halves, because either alone is satisfiable by
   * the wrong code: a raw `c.req.json()` re-introduces the untyped body the rule
   * exists to prevent, and a `c.req.valid('json')` with no `validateBody` mount
   * in the same module reads a value no validator ever produced.
   */
  const RAW_BODY_READ = /\.\s*req\s*\.\s*(?:json|parseBody|text)\s*\(/g;

  it('reads no body outside a validated accessor', () => {
    const offenders = serverFiles
      // `middleware/validation.ts` IS the zValidator wrapper: it is the one
      // module that legitimately mentions the raw request body.
      .filter((file) => !file.endsWith(join('middleware', 'validation.ts')))
      .flatMap((file) => hits(file, RAW_BODY_READ));

    expect(offenders).toEqual([]);
  });

  it('has a validateBody() mount in every module that reads a validated body', () => {
    const readers = serverFiles.filter((file) => readFileSync(file, 'utf8').includes("req.valid('json')"));
    const unbacked = readers.filter((file) => !readFileSync(file, 'utf8').includes('validateBody('));

    expect(unbacked.map((file) => relative(REPO_ROOT, file))).toEqual([]);
    // Vacuity guard: the sweep must actually be reading validated bodies today.
    expect(readers.length).toBeGreaterThan(5);
  });
});

// ─── Cross-document agreement ──────────────────────────────

describe('the documentation and the deployment agree on the facts both of them state', () => {
  const AGENTS = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const CD = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'cd.yml'), 'utf8');
  const MONGO_TS = readFileSync(join(SRC, 'db', 'mongo.ts'), 'utf8');

  describe('the DB_CLIENT_MODE production value is one fact, stated once and deployed', () => {
    /** The value the deploy command actually passes. */
    const deployed = [...CD.matchAll(/--var\s+DB_CLIENT_MODE:([a-z-]+)/g)].map((m) => m[1]);

    it('the deploy sets exactly one DB_CLIENT_MODE', () => {
      expect(deployed).toHaveLength(1);
    });

    it('AGENTS.md documents the mode the deploy actually sets', () => {
      // `AGENTS.md` §Stack: "production runs `durable`". Derived from the text,
      // not from a list this file keeps in step by hand — a second literal is
      // how the two copies drifted in the first place.
      const documented = AGENTS.match(/production runs `([a-z-]+)`/);

      expect(documented?.[1], 'AGENTS.md no longer states which mode production runs').toBeDefined();
      expect(deployed[0], `the deploy runs ${deployed[0] ?? '?'}, AGENTS.md documents ${documented?.[1] ?? '?'}`).toBe(
        documented?.[1],
      );
    });

    it('wrangler.toml no longer claims per-request is the production default', () => {
      const wrangler = readFileSync(join(REPO_ROOT, 'server', 'wrangler.toml'), 'utf8');

      expect(wrangler).not.toMatch(/production default stays per-request/);
    });
  });

  describe('the driver-knob claim is not stated in one copy only, and never as the refuted one', () => {
    it('both copies talk about connectTimeoutMS (delete neither)', () => {
      expect(MONGO_TS).toContain('connectTimeoutMS');
      expect(AGENTS).toContain('connectTimeoutMS');
    });

    /**
     * A correct text has to be ABLE to say what is not true, so "the word IDLE
     * never appears" is the wrong rule — it would fail on the very sentence that
     * refutes the claim. The property is per SENTENCE: a sentence that invokes
     * the idle-timeout mechanism must also carry the correction — a refutation
     * marker, a negation, or the driver's own reset (`setTimeout(0)`, cleared,
     * removed, reset). A sentence that asserts the mechanism and nothing else is
     * the defect this scan exists for, and it fails on its own.
     */
    it('no sentence invokes the refuted idle-timeout mechanism without the correction', () => {
      const IDLE_CLAIM = /idle[-\s]?(?:socket\s+)?timeout/i;
      const CORRECTION = /refut|false|withdrawn|\bnot\b|cannot|never|clears?|removed|resets?|setTimeout\(0\)/i;
      // Whitespace is collapsed FIRST: both documents are hard-wrapped, and a
      // line break is not the end of a sentence — splitting there would cut
      // "… IDLE timeout, so a custom value kills idle connections …" away from
      // the "is **false for the installed driver**" that corrects it. `:` is
      // not a boundary either: "timeout: it cannot kill an established
      // connection" is one claim, and splitting on the colon would hide the
      // correction there instead.
      const chunks = (source: string): string[] => source.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|;/);

      for (const [name, source] of [
        ['server/src/db/mongo.ts', MONGO_TS],
        ['AGENTS.md', AGENTS],
      ] as const) {
        const all = chunks(source);

        // Vacuity guard: the copy must still discuss the knob at all.
        expect(
          all.some((chunk) => chunk.includes('connectTimeoutMS')),
          `${name} dropped connectTimeoutMS entirely`,
        ).toBe(true);

        for (const chunk of all) {
          if (!IDLE_CLAIM.test(chunk)) {
            continue;
          }

          expect(
            CORRECTION.test(chunk),
            `${name} invokes the idle-timeout mechanism with no correction: ${chunk.trim().slice(0, 140)}`,
          ).toBe(true);
        }
      }
    });

    it('AGENTS.md keeps the incidents marked unexplained', () => {
      // The correction withdrew an explanation; it must not withdraw the facts.
      const flat = AGENTS.replace(/\s+/g, ' ');

      expect(flat).toMatch(/unexplained/);
      expect(flat).toContain('140-320 ms');
      expect(flat).toContain('75-90 s');
    });
  });
});
