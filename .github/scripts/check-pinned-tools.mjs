/**
 * Guardrail: the pipeline must not execute code the repository
 * does not pin.
 *
 * THE PROPERTY. Every `npx <spec>` appearing in a non-comment line of a
 * workflow under `.github/workflows/` must be either
 *
 *   (a) resolvable from a committed lockfile — the tool is a dependency or
 *       devDependency of one of the workspaces, so `npm ci` installed an exact
 *       version and `npx` resolves that local binary; or
 *   (b) carrying an exact `@x.y.z` version, so a registry fetch is
 *       reproducible.
 *
 * Anything else — `npx -y tsx`, `npx -y some-tool@latest`, `npx -y t@^4` — is
 * resolved by the registry at the moment the step runs. In the `deploy` job
 * that step's environment carries the Atlas URI, the JWT signing secret and the
 * Cloudflare API token, so the fetched code runs with production credentials in
 * scope. Every `uses:` Action in the same files is already pinned to a full
 * commit SHA; this closes the equivalent hole on the `run:` side.
 *
 * WHY IT IS NOT A LIST. There is no allowlist of tools and no allowlist of
 * files. A newly added `npx <tool>` is judged by the same two rules, so the
 * check fails on the defect class rather than on a remembered name, and a
 * correctly pinned invocation needs no exemption to be added here.
 *
 * Exit code 0 = every invocation is pinned; 1 = at least one is not, each
 * reported as `file:line`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

/** Workspace manifests — the only place a version may come from. */
const MANIFESTS = ['package.json', 'server/package.json', 'ui/package.json', 'shared/package.json'];

/** An exact semver version. A range, a tag or a wildcard is not a pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/;

/**
 * Every binary name the repository's committed dependencies publish. Reading
 * each dependency's own `bin` field is what makes this a property check: it
 * asks "does the lockfile pin a binary by this name?", not "is this name on a
 * list?".
 */
function collectDeclaredBins() {
  const bins = new Set();
  for (const manifest of MANIFESTS) {
    const manifestPath = path.join(repoRoot, manifest);
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        const depManifest = path.join(repoRoot, 'node_modules', name, 'package.json');
        if (!existsSync(depManifest)) continue;
        const dep = JSON.parse(readFileSync(depManifest, 'utf8'));
        if (typeof dep.bin === 'string') {
          bins.add(dep.name.startsWith('@') ? dep.name.split('/')[1] : dep.name);
        } else if (dep.bin && typeof dep.bin === 'object') {
          for (const binName of Object.keys(dep.bin)) bins.add(binName);
        }
      }
    }
  }
  return bins;
}

/** Split `pkg@1.2.3` / `@scope/pkg@^4` / `pkg` into { name, version }. */
function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const declaredBins = collectDeclaredBins();
const violations = [];
let invocations = 0;

if (!existsSync(workflowsDir)) {
  console.error(`check-pinned-tools: ${workflowsDir} does not exist — nothing to scan.`);
  process.exit(1);
}

for (const file of readdirSync(workflowsDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()) {
  const lines = readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
  lines.forEach((raw, index) => {
    // A comment documents an invocation; it does not perform one. `npx` inside
    // prose must not be judged, and a commented-out example must not be able to
    // hide a real one — so the rule is per-line, and only whole-line comments
    // are skipped.
    if (/^\s*#/.test(raw)) return;
    // The spec is captured up to whitespace or a shell delimiter, so a range
    // character (`tsx@^4`) is captured WHOLE and judged as a non-exact version
    // rather than being silently truncated into something that looks pinned.
    for (const match of raw.matchAll(/\bnpx\s+(?:(?:-y|--yes)\s+)*([^\s'"`|;&)]+)/g)) {
      invocations++;
      const { name, version } = parseSpec(match[1]);
      const location = `${file}:${index + 1}`;
      if (version === null) {
        if (!declaredBins.has(name)) {
          violations.push(
            `${location}  npx ${name} — no workspace declares a binary by that name, ` +
              `so the registry is asked for "latest". Declare it, or pin it: npx ${name}@x.y.z`,
          );
        }
      } else if (!EXACT_VERSION.test(version)) {
        violations.push(
          `${location}  npx ${match[1]} — ${version ? `"${version}" is not an exact version` : 'trailing "@" with no version'}`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`Unpinned tooling in the pipeline (${violations.length} of ${invocations} invocations):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`check-pinned-tools: ${invocations} npx invocation(s), all pinned.`);
