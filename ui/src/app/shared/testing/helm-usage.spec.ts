/**
 * P-05 — "UI kit: Spartan Helm components only; do not hand-roll
 * buttons/dialogs/selects/etc." was a prose MUST with no enforcing artefact, and
 * it had already decayed: the audit found hand-rolled `<button>` elements styled
 * with a hand-written class list instead of the Helm button directive.
 *
 * ## What the property is
 *
 * NOT "every `<button>` in the app has `hlmBtn`" — that is the wrong shape. Many
 * buttons in these templates are **not ours**: a `<button hlmDropdownMenuItem>`
 * is styled by its own component, and a `<button>` written inside an `<hlm-…>`
 * element is part of a Spartan component's own template. Requiring `hlmBtn` on
 * those would be a coupling, and a coupling blocks the next correct fix.
 *
 * The property is: **a button the application itself authors is a Helm button.**
 * So the scan classifies every `<button>` open tag in every template under
 * `src/app` and rejects only the ones that are neither Helm-styled nor
 * Spartan-owned.
 *
 * ## Why the classifier is itself under test
 *
 * A source scan that silently stops matching is worse than no scan: it is
 * trusted and vacuous. So the classifier is exercised against synthetic markup
 * that contains one of each kind, and the sweep is asserted to have found
 * something. A parser that starts matching nothing fails here instead of turning
 * the sweep green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = resolve(process.cwd(), 'src/app');

/** Angular templates under `src/app` — the whole application surface. */
function htmlFiles(dir: string = APP_DIR): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...htmlFiles(full));
    } else if (entry.endsWith('.html')) {
      out.push(full);
    }
  }

  return out.sort();
}

interface ButtonTag {
  /** `file:line`, for an actionable failure message. */
  at: string;
  /** The attributes, whitespace-collapsed. */
  attrs: string;
  /** True when the tag carries any `hlm…` directive/attribute. */
  helmStyled: boolean;
  /** True when the tag sits inside a Spartan-owned element. */
  spartanOwned: boolean;
}

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const HLM_ATTR_RE = /\bhlm[A-Z][\w-]*/;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source']);

/** Replace HTML comments with blanks, keeping every offset and line break intact. */
function blankComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Find every `<button>` the application authors, with the two facts the rule
 * needs: is it Helm-styled, and is it Spartan-owned.
 */
export function findAuthoredButtons(source: string, at = 'test'): ButtonTag[] {
  const markup = blankComments(source);
  const open: string[] = [];
  const found: ButtonTag[] = [];
  let match: RegExpExecArray | null;

  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(markup)) !== null) {
    const [, closing, rawName, attrs, selfClose] = match;
    const name = (rawName ?? '').toLowerCase();

    if (closing) {
      // Close back to the matching open tag; an unclosed tag in a template is
      // not a reason to lose the rest of the stack.
      const index = open.lastIndexOf(name);

      if (index !== -1) {
        open.length = index;
      }

      continue;
    }

    const spartanOwned = open.some((tag) => tag.startsWith('hlm-'));

    if (name === 'button') {
      found.push({
        at: `${at}:${lineAt(markup, match.index)}`,
        attrs: (attrs ?? '').replace(/\s+/g, ' ').trim(),
        helmStyled: HLM_ATTR_RE.test(attrs ?? ''),
        spartanOwned,
      });
    }

    if (!selfClose && !VOID_TAGS.has(name)) {
      open.push(name);
    }
  }

  return found;
}

describe('P-05 — every authored button is a Spartan Helm button', () => {
  describe('the classifier discriminates (a scan that cannot tell them apart is not a rule)', () => {
    it('flags a hand-rolled button', () => {
      const [button] = findAuthoredButtons(
        '<button class="flex gap-1 hover:text-foreground" (click)="go()">x</button>',
      );

      expect(button?.helmStyled).toBe(false);
      expect(button?.spartanOwned).toBe(false);
    });

    it('accepts a Helm button', () => {
      const [button] = findAuthoredButtons('<button hlmBtn variant="ghost" size="sm">x</button>');

      expect(button?.helmStyled).toBe(true);
    });

    it('accepts a button owned by another Spartan component', () => {
      // `hlmDropdownMenuItem` styles its own host; a bespoke Helm directive on a
      // button is equally not a hand-rolled button.
      const [menuItem] = findAuthoredButtons('<button hlmDropdownMenuItem (click)="go()">x</button>');

      expect(menuItem?.helmStyled).toBe(true);

      // A button written INSIDE a Spartan component's template is that
      // component's business, not ours.
      const [inside] = findAuthoredButtons('<hlm-select-trigger><button class="size-4"></button></hlm-select-trigger>');

      expect(inside?.spartanOwned).toBe(true);
    });

    it('ignores a button that only appears inside an HTML comment', () => {
      expect(
        findAuthoredButtons('<!-- <button class="hand-rolled">x</button> --><button hlmBtn>x</button>'),
      ).toHaveLength(1);
    });

    it('is not fooled by a multi-line open tag', () => {
      const [button] = findAuthoredButtons('<button\n  class="hand-rolled"\n  (click)="go()">\n  x\n</button>');

      expect(button?.helmStyled).toBe(false);
      expect(button?.attrs).toContain('hand-rolled');
    });
  });

  describe('the application templates', () => {
    const files = htmlFiles();
    const authored = files.flatMap((file) =>
      findAuthoredButtons(readFileSync(file, 'utf8'), relative(process.cwd(), file)),
    );
    const handRolled = authored.filter((button) => !button.helmStyled && !button.spartanOwned);

    it('sweeps every template under src/app', () => {
      // Vacuity guard: if the walker or the parser stopped matching, this fails
      // instead of the sweep quietly approving the whole application.
      expect(files.length).toBeGreaterThan(20);
      expect(authored.length).toBeGreaterThan(20);
      expect(authored.some((button) => button.helmStyled)).toBe(true);
      expect(authored.some((button) => button.spartanOwned)).toBe(true);
    });

    it('has no hand-rolled <button> left', () => {
      expect(handRolled.map((button) => `${button.at}  <button ${button.attrs.slice(0, 120)}>`)).toEqual([]);
    });
  });
});
