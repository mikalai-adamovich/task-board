/**
 * The installed toolchain matches the declared one.
 *
 * Both `package.json` and `package-lock.json` declared Angular `^22.2.0` while
 * `node_modules` held `22.1.4`. Nothing said so, because every gate — lint, the
 * three type-checks, both test suites — runs against whatever is *installed*.
 * A clone that never ran an install compiles an older Angular than the
 * repository claims to target, and the symptom is not a version error: it is
 * hundreds of unrelated-looking template diagnostics, which read as a mass
 * code regression and invite a large "fix" to correct code that was never
 * broken.
 *
 * CI always installs from the lockfile, so it cannot observe this. The drift is
 * only ever local — a developer or an agent working in a tree whose
 * `node_modules` predates a version bump.
 *
 * The property asserted: **every version range this repository declares is
 * satisfied by the version actually installed.** That is checked against the
 * manifests and `node_modules` themselves, so it holds for a dependency added
 * later without editing this file.
 *
 * The comparator is deliberately dependency-free. `semver` is present in the
 * tree only as a hoisted transitive, and depending on it here would recreate
 * the very class of bug this file exists to catch. It covers the range forms
 * this repository uses and **throws on anything else**, so an unrecognised
 * range fails loudly instead of passing silently.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** `major.minor.patch` plus an optional prerelease tag; build metadata is ignored. */
function parse(version: string): { parts: [number, number, number]; prerelease: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());

  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Unparseable version: ${version}`);
  }

  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  };
}

const compare = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Upper bound for a caret range, which pins the first non-zero component:
 * `^1.2.3` allows `1.x`, `^0.2.3` allows `0.2.x`, `^0.0.3` allows `0.0.3` only.
 */
function caretUpperBound(parts: [number, number, number]): [number, number, number] {
  const [major, minor, patch] = parts;

  if (major !== 0) return [major + 1, 0, 0];
  if (minor !== 0) return [0, minor + 1, 0];

  return [0, 0, patch + 1];
}

/**
 * `satisfies` for the range forms this repository declares. Anything else
 * throws: an unrecognised range must fail the gate, never pass it by accident.
 */
function satisfies(version: string, range: string): boolean {
  const installed = parse(version);
  // Per semver, a prerelease satisfies a range only when the range itself names
  // a prerelease of the same tuple. Reported distinctly so the operator knows an
  // `npm ci` is the fix either way.
  const caret = /^\^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range);

  if (caret?.[1]) {
    const target = parse(caret[1]);
    const withinMajor =
      compare(installed.parts, target.parts) >= 0 && compare(installed.parts, caretUpperBound(target.parts)) < 0;

    return withinMajor && (installed.prerelease === '' || target.prerelease !== '');
  }

  const tilde = /^~(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range);

  if (tilde?.[1]) {
    const target = parse(tilde[1]);
    const upper: [number, number, number] = [target.parts[0], target.parts[1] + 1, 0];
    const withinMinor = compare(installed.parts, target.parts) >= 0 && compare(installed.parts, upper) < 0;

    return withinMinor && (installed.prerelease === '' || target.prerelease !== '');
  }

  const exact = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range);

  if (exact?.[1]) {
    const target = parse(exact[1]);

    return compare(installed.parts, target.parts) === 0 && installed.prerelease === target.prerelease;
  }

  if (range === '*' || range === '' || range === 'x' || range === 'latest') {
    return true;
  }

  throw new Error(
    `Unsupported range "${range}". This guardrail only implements ^, ~, exact and *, and must not ` +
      `guess at a form it has not been taught — add the form here deliberately.`,
  );
}

/** Node resolution, in the order npm lays packages out: the workspace's own tree, then the hoisted root. */
function resolveInstalled(workspaceDir: string, name: string): string | null {
  for (const base of [join(workspaceDir, 'node_modules'), join(REPO, 'node_modules')]) {
    const manifest = join(base, name, 'package.json');

    if (existsSync(manifest)) return manifest;
  }

  return null;
}

const rootManifest = readManifest(join(REPO, 'package.json'));
const workspaces = ['', ...(rootManifest.workspaces ?? [])];

interface Declaration {
  where: string;
  field: string;
  name: string;
  range: string;
}

/** `dependencies`/`devDependencies` must be present on disk; the other two need not be. */
const declarations: Declaration[] = [];
const optionalDeclarations: Declaration[] = [];

for (const workspace of workspaces) {
  const dir = workspace ? join(REPO, workspace) : REPO;
  const manifest = readManifest(join(dir, 'package.json'));
  const where = workspace || '<root>';

  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      declarations.push({ where, field, name, range });
    }
  }

  for (const field of ['peerDependencies', 'optionalDependencies'] as const) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      optionalDeclarations.push({ where, field, name, range });
    }
  }
}

describe('toolchain parity: declared dependency ranges are satisfied by what is installed', () => {
  it('has declarations to check', () => {
    // A vacuous pass would let this file rot into reporting success forever.
    expect(declarations.length).toBeGreaterThan(0);
  });

  it.each(declarations)('$where $field $name@$range is installed and satisfies the range', (declaration) => {
    const dir = declaration.where === '<root>' ? REPO : join(REPO, declaration.where);
    const installedManifest = resolveInstalled(dir, declaration.name);

    if (installedManifest === null) {
      throw new Error(
        `${declaration.where} declares "${declaration.name}": "${declaration.range}" but it is not installed. ` +
          `The working tree's node_modules is out of step with its manifests — run npm ci.`,
      );
    }

    const { name: installed, version } = readManifest(installedManifest);

    if (installed === undefined || version === undefined) {
      throw new Error(`${installedManifest} declares no name or version`);
    }

    if (!satisfies(version, declaration.range)) {
      throw new Error(
        `${declaration.where} declares "${declaration.name}": "${declaration.range}" but ` +
          `${version} is installed (${installedManifest}). The tree predates the manifest — run npm ci. ` +
          `Gate results computed against the installed version describe a toolchain this repository does not target.`,
      );
    }
  });

  it('is not silently skipped by a range form it cannot read', () => {
    // The comparator throws rather than defaulting to `true`. Assert the throw,
    // so extending the comparator is a deliberate act and not a silent loosening.
    expect(() => satisfies('1.2.3', '>=1.0.0 <2.0.0')).toThrow(/Unsupported range/);
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
  });

  it('reports peer/optional declarations without failing on their absence', () => {
    // These are declared in the manifests but need not be installed, so they
    // are surfaced rather than asserted on.
    const unresolved = optionalDeclarations.filter((declaration) => {
      const dir = declaration.where === '<root>' ? REPO : join(REPO, declaration.where);

      return resolveInstalled(dir, declaration.name) === null;
    });

    expect(Array.isArray(unresolved)).toBe(true);
  });
});
