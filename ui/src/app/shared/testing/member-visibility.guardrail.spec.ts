/**
 * G9 guardrail: `protected` must have a referent, and the only referents it can
 * have are a subclass, a template, or a host binding.
 *
 * A component template type-checks against the class and accepts `private`, so a
 * template-read member no longer needs `protected` on the strength of the
 * compiler. `protected` still means "a subclass must reach this", so a member
 * marked `protected` on a class nothing extends reads as a missing `private`,
 * and a future subclass then reaches into state it was never meant to own.
 *
 * Two reasons still justify `protected` for a template-read member, and this
 * file's exemption covers both. A subclass reaches it. Or — the case that
 * matters in practice — its ONLY read site is the template: `noUnusedLocals`
 * reports such a member as TS6133 when it is `private`, because TypeScript's
 * unused check never sees a template reference. That is a real constraint, not a
 * preference, and it is why the exemption below is a read-site test rather than
 * a blanket allowance.
 *
 * Rule A — a `protected` member is redundant when the ONLY thing that reads it
 *   is TypeScript inside the class that declares it, and no class in this app
 *   extends that class. Nothing outside can see it, so `private` states the same
 *   thing and compiles. The members this replaced were exactly that shape.
 *
 * Three read sites count as "outside the class", and the first two are the ones
 * that are easy to miss because the read is not written as `this.member`:
 *   * the component TEMPLATE (`templateUrl` / inline `template`),
 *   * the component's HOST BINDINGS (`host: { '(dragstart)': 'onDragStart($event)' }`),
 *   * any other TypeScript file in `ui/src`.
 *
 * The expectation is DERIVED from the code on every run — the `extends` clauses
 * and the read sites of `ui/src` are re-read each time. There is no list of
 * approved names, no allow-list and no expected count, so the rule cannot rot:
 * adding a redundant member fails with no edit to this file, and removing one
 * needs no edit either.
 *
 * A member that NOTHING reads is deliberately outside Rule A. Such a member is
 * dead weight, and `private` would make the compiler report it as such (TS6133,
 * `noUnusedLocals`) — a different defect with a different fix. Failing it here
 * would push the author to delete behaviour to satisfy a visibility rule.
 *
 * The rule is asserted against the SOURCES, so it covers every component in the
 * app, including ones no unit test instantiates — the same pattern as
 * `reactive-fetch.guardrail.spec.ts` and `icon-button-names.spec.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = join(__dirname, '..', '..');

/** Recursively collect every non-spec `.ts` source under `ui/src`. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collectSources(path, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

const SOURCES = collectSources(SRC);
/** Absolute path -> file text, read once. */
const TEXT = new Map(SOURCES.map((f) => [f, readFileSync(f, 'utf8')]));
/** An identifier used as a value: not preceded by `.`, not part of a longer name. */
const readOf = (name: string) => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`);

/** The text of a `{ … }` block that starts at `open`, brace-matched. */
function blockAt(text: string, open: number): string {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * Everything Angular compiles on the class's behalf and type-checks against it:
 * the template, and the host bindings. Both are reads from OUTSIDE the class
 * body even though they live in the same file, which is why `private` is TS2341
 * for them.
 */
function frameworkReads(file: string): string {
  const text = TEXT.get(file) ?? '';
  let out = '';
  const inline = /\btemplate:\s*`([\s\S]*?)`/.exec(text);

  if (inline?.[1] !== undefined) out += inline[1];

  const host = /\bhost:\s*\{/.exec(text);

  if (host) out += blockAt(text, host.index + host[0].length - 1);

  const url = /\btemplateUrl:\s*['"]([^'"]+)['"]/.exec(text);

  if (url?.[1]) {
    try {
      out += readFileSync(join(dirname(file), url[1]), 'utf8');
    } catch {
      // A template the file does not resolve to is not a read site.
    }
  }
  return out;
}

interface ClassInfo {
  name: string;
  base: string | null;
}

/** Every class declared in a non-spec source, with the class it extends. */
function classes(): ClassInfo[] {
  const out: ClassInfo[] = [];

  for (const text of TEXT.values()) {
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)\s*(?:extends\s+([\w.]+))?/.exec(line);

      if (m?.[1]) out.push({ name: m[1], base: m[2] ?? null });
    }
  }
  return out;
}

interface Member {
  className: string;
  member: string;
  file: string;
  line: number;
  /** The file with this member's own declaration line removed. */
  withoutDeclaration: string;
}

/** Every member declared `protected` in a non-spec source. */
function protectedMembers(): Member[] {
  const out: Member[] = [];

  for (const [file, text] of TEXT) {
    const lines = text.split('\n');
    const stack: string[] = [];

    lines.forEach((line, i) => {
      const decl = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(line);

      if (decl?.[1]) stack.push(decl[1]);

      // The two-space indent is what makes this a class member: a nested object
      // literal or a call argument is indented deeper or not at all.
      const member = /^ {2}protected\s+(?:readonly\s+)?(?:static\s+)?(\w+)/.exec(line);

      if (member?.[1] && stack.length) {
        out.push({
          className: stack[stack.length - 1] ?? '',
          member: member[1],
          file,
          line: i + 1,
          withoutDeclaration: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n'),
        });
      }
    });
  }
  return out;
}

/**
 * Rule A. `protected` is redundant when the member is readable only from the
 * class that declares it, and nothing extends that class.
 */
function isRedundantProtected(input: {
  classIsExtended: boolean;
  readByFramework: boolean;
  readByOtherFile: boolean;
  readByAnything: boolean;
}): boolean {
  // A subclass is the reason `protected` exists.
  if (input.classIsExtended) return false;
  // The template and the host bindings are compiled against the class.
  if (input.readByFramework) return false;
  if (input.readByOtherFile) return false;
  // Nothing reads it at all: dead code, which TS6133 (noUnusedLocals) reports.
  if (!input.readByAnything) return false;
  return true;
}

const ALL_CLASSES = classes();
const DECLARED = new Set(ALL_CLASSES.map((c) => c.name));
/** Classes something in this app extends. */
const EXTENDED = new Set(
  ALL_CLASSES.filter((c) => c.base && DECLARED.has(c.base.split('.')[0] ?? '')).map((c) => c.name),
);
const MEMBERS = protectedMembers();

describe('member visibility guardrail (G9)', () => {
  it('reads a non-empty set of members and a non-empty set of classes', () => {
    // A rule whose scan matches nothing passes every other assertion here.
    expect(MEMBERS.length).toBeGreaterThan(0);
    expect(ALL_CLASSES.length).toBeGreaterThan(0);
  });

  it('the rule accepts exactly the shapes it is meant to accept', () => {
    const shape = (o: Partial<Parameters<typeof isRedundantProtected>[0]>) =>
      isRedundantProtected({
        classIsExtended: false,
        readByFramework: false,
        readByOtherFile: false,
        readByAnything: true,
        ...o,
      });

    // A template- or host-binding-read member: legitimately protected.
    expect(shape({ readByFramework: true })).toBe(false);
    // A member another file reaches.
    expect(shape({ readByOtherFile: true })).toBe(false);
    // A subclass-reached member — the reason the modifier exists.
    expect(shape({ classIsExtended: true })).toBe(false);
    // Dead code: `private` would surface it as TS6133 instead.
    expect(shape({ readByAnything: false })).toBe(false);
    // The defect: readable only from inside, on a class nobody extends.
    expect(shape({})).toBe(true);
  });

  it('no `protected` member is readable only from inside its own class', () => {
    const offenders: string[] = [];

    for (const m of MEMBERS) {
      const pattern = readOf(m.member);
      const readByFramework = pattern.test(frameworkReads(m.file));
      const readByOtherFile = [...TEXT].some(([file, text]) => file !== m.file && pattern.test(text));
      // Inside a class body a member is only ever reached through `this`, so that
      // is the precise signal. A bare mention elsewhere in the file is ambiguous:
      // `protected readonly COLUMN_COUNT = COLUMN_COUNT` binds the module-level
      // constant of the same name, not the member.
      const readByAnything =
        readByFramework || readByOtherFile || new RegExp(`\\bthis\\s*\\.\\s*${m.member}\\b`).test(m.withoutDeclaration);

      if (
        isRedundantProtected({
          classIsExtended: EXTENDED.has(m.className),
          readByFramework,
          readByOtherFile,
          readByAnything,
        })
      ) {
        offenders.push(`${m.file}:${m.line} ${m.className}.${m.member}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
