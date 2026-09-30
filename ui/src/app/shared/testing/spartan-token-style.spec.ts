/**
 * A `spartan-*` style token in `ui/libs` resolves to NOTHING, so writing
 * one silently drops the style it was supposed to name.
 *
 * ## The mechanism this guards
 *
 * Spartan's style system resolves a class like `spartan-nova-button` by looking
 * it up in the active style map. The audit ran the CLI's own `createStyleMap`
 * over all six shipped maps: eleven tokens are `has: false` in **every** one of
 * them. In `applyStyle` the `tailwind` branch resolves to `[]`, `mergeClasses`
 * is skipped, `removeSpartanClasses` deletes the token, and nothing is applied.
 * The rendered result is correct **only because** the utilities are written out
 * inline next to the token wherever one appears
 * (`ui/libs/ui/native-select/src/lib/hlm-native-select.ts:115`).
 *
 * So the property is not "these eleven tokens are unresolvable" — a count that
 * dies the moment Spartan changes. It is: **a `spartan-*` token never appears in
 * a class position in this repository.** Today the set is empty, which makes
 * this a pure regression guard with no behaviour change; the first person to
 * write `class="spartan-nova-button"` gets a red test telling them to write the
 * utilities inline instead.
 *
 * ## Why the matcher is careful about what it ignores
 *
 * `spartan-` also occurs legitimately, in three non-style positions, and a
 * scanner that flagged them would be noise the first author learns to suppress:
 *   - the package specifier (`@spartan-ng/brain/…`) and its path tail;
 *   - the `data-[matches-spartan-invalid=true]` selector, a Brain state
 *     attribute, where `spartan-invalid` is part of a longer name;
 *   - filenames such as `provide-spartan-hlm.ts`.
 * Each of those is excluded by the surrounding characters, not by an allow-list
 * of today's occurrences — an allow-list of positions would be a coupling.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIBS_DIR = resolve(process.cwd(), 'libs');

function tsFiles(dir: string = LIBS_DIR): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }

  return out.sort();
}

/**
 * A `spartan-…` token sitting in a CLASS position: a whole token that is not
 * part of a longer identifier and not a package path.
 *
 * Excluded by the character before (`@` for a specifier, `-` / `[` for a longer
 * name such as `matches-spartan-invalid`) and by the character after (`/` for a
 * module path tail).
 */
export function findStyleTokens(source: string): { token: string; index: number }[] {
  const out: { token: string; index: number }[] = [];
  const re = /spartan-[a-z0-9-]+/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const before = source[match.index - 1] ?? ' ';
    const after = source[match.index + match[0].length] ?? ' ';

    if (/[@\-[]/.test(before) || after === '/') {
      continue;
    }

    out.push({ token: match[0], index: match.index });
  }

  return out;
}

describe('D-57 — no unresolvable spartan-* style token is used', () => {
  describe('the matcher tells a style token from a package path and a state attribute', () => {
    it('flags a class-position token', () => {
      expect(findStyleTokens(`classes(() => 'spartan-nova-button')`).map((t) => t.token)).toEqual([
        'spartan-nova-button',
      ]);
    });

    it('ignores a package specifier and its path', () => {
      const source = `import { BrnButton } from '@spartan-ng/brain/button';\nexport * from 'spartan-ng/helm/button';`;

      expect(findStyleTokens(source)).toEqual([]);
    });

    it('ignores the Brain invalid-state attribute', () => {
      const source = `'data-[matches-spartan-invalid=true]:ring-destructive/20 group/switch'`;

      expect(findStyleTokens(source)).toEqual([]);
    });
  });

  describe('the library sources', () => {
    const files = tsFiles();
    const used = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');

      return findStyleTokens(source).map((hit) => ({
        at: `${relative(process.cwd(), file)}:${source.slice(0, hit.index).split('\n').length}`,
        token: hit.token,
      }));
    });

    it('sweeps the Spartan libraries', () => {
      // Vacuity guard: an empty sweep is indistinguishable from a broken one.
      expect(files.length).toBeGreaterThan(20);
    });

    it('uses no spartan-* style token — the utilities are written inline', () => {
      expect(used.map((hit) => `${hit.at}  ${hit.token}`)).toEqual([]);
    });
  });
});
