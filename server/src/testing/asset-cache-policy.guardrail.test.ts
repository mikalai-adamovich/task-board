/**
 * The runtime assets are content-hashed, and the cache policy
 * follows them into the deployed output.
 *
 * The item was "116 stable-named runtime assets with no cache policy". Either
 * half alone is a defect: a long lifetime on a stable name serves a stale asset
 * after a release, and hashing with no lifetime buys nothing. The two are
 * therefore asserted together, and so is the third thing that makes them
 * observable — that CI and CD both RUN the step, and that the deployed path
 * still points at the directory the step writes into.
 *
 * The hashing script verifies its own output and exits non-zero, so the runtime
 * behaviour of the step is covered by running it; what this file adds is the
 * wiring a build cannot see: that the step exists, that nothing marks it
 * advisory, and that the two consumers read the names it writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const HASH_SCRIPT = 'ui/scripts/hash-runtime-assets.mjs';
const HASH_COMMAND = 'node ui/scripts/hash-runtime-assets.mjs';
const read = (relative: string): string => readFileSync(join(REPO, relative), 'utf8');
/** The `run:`-bearing step whose body mentions the command, plus the lines after it. */
const stepAround = (workflow: string, needle: string): string => {
  const lines = workflow.split('\n');
  const at = lines.findIndex((line) => line.includes(needle));

  expect(at, `${needle} is not in the workflow`).toBeGreaterThan(-1);

  return lines.slice(Math.max(0, at - 4), at + 4).join('\n');
};

describe('the runtime assets carry a cache policy their names can support (C-3 / D-16)', () => {
  it('the hashing step exists and is not optional', () => {
    expect(existsSync(join(REPO, HASH_SCRIPT)), `${HASH_SCRIPT} is missing`).toBe(true);
    // `continue-on-error` here would make the whole item advisory, which is the
    // defect class this decision table keeps finding.
    expect(read(HASH_SCRIPT), 'the script must fail the build, not warn').not.toContain('process.exit(0)');
  });

  it('CI runs it after the UI build, and CD runs it before the Pages deploy', () => {
    const ci = read('.github/workflows/ci.yml');
    const cd = read('.github/workflows/cd.yml');

    expect(ci).toContain(HASH_COMMAND);
    expect(cd).toContain(HASH_COMMAND);
    expect(ci.indexOf('Build UI')).toBeLessThan(ci.indexOf(HASH_COMMAND));
    expect(cd.indexOf(HASH_COMMAND)).toBeLessThan(cd.indexOf('pages deploy'));

    for (const [name, step] of [
      ['ci.yml', stepAround(ci, HASH_COMMAND)],
      ['cd.yml', stepAround(cd, HASH_COMMAND)],
    ] as const) {
      expect(step, `the ${name} hashing step must not be allowed to fail silently`).not.toContain('continue-on-error');
    }
  });

  it('the deploy still uploads the directory the step writes into', () => {
    // The outage this repository already had once: a bare `.` uploads the source
    // tree instead of the build output. The hashed names and `_headers` live in
    // `ui/dist/ui/browser`, so that path is load-bearing twice over.
    const cd = read('.github/workflows/cd.yml');

    expect(cd).toContain('wrangler pages deploy ui/dist/ui/browser');
  });

  it('the static header file ships, and the step completes it', () => {
    const authored = read('ui/public/_headers');

    // The authored half is the security policy; the cache half is written
    // by the step, because the names it names do not exist until it has run.
    expect(authored).toContain('X-Frame-Options');
    // `max-age=31536000` also appears in the HSTS header, which is a different
    // thing entirely, so the assertion is about the CACHE lifetime specifically:
    // a `Cache-Control` naming a year, authored for names that do not change,
    // is the stale-asset bug this item exists to remove.
    expect(authored, 'the authored file must not hand a year-long Cache-Control to stable-named assets').not.toMatch(
      /Cache-Control:[^\n]*max-age=31536000/,
    );
    expect(read(HASH_SCRIPT)).toContain('max-age=31536000');
  });

  it('both runtime consumers read the names the step writes', () => {
    // Themes: the loader must take the file name from the manifest entry, or a
    // hashed release 404s on the first theme switch.
    const themeLoader = read('ui/src/app/services/theme-loader.ts');

    expect(themeLoader).toMatch(/findById\(/);

    // Translations: the loader must consult the generated name map.
    const translocoLoader = read('ui/src/app/transloco-loader.ts');

    expect(translocoLoader).toContain('/assets/i18n/manifest.json');
  });
});
