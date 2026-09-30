/**
 * a11y guardrail: no icon-only button may ship without an accessible name.
 *
 * The audit that produced this rule found 16 buttons that were labelled
 * ONLY by a tooltip. `hlmTooltip` renders a `<p role="tooltip">` and wires
 * `aria-describedby` — a described-by, not a name — so a screen reader
 * announced the button as an unlabelled "button". A tooltip is a visual
 * affordance, never an accessible name.
 *
 * Several of the affected templates cannot be asserted at runtime: the Milkdown
 * toolbar is behind `!fallbackMode()` (the test env always falls back), and
 * every overlay body lives in a CDK portal that unit tests never attach. So
 * this spec asserts the RULE against the template sources instead — which is
 * strictly stronger than spot-checking one rendered instance, because it covers
 * every button in every template, including ones no test renders.
 *
 * Accepted ways to name a button:
 *   - `aria-label` / `aria-labelledby` on the button, or
 *   - visible text content, or
 *   - an `sr-only` text node inside it (the pattern the vendored HlmButton
 *     close button uses).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

/** Recursively collect every `.html` template under `ui/src/app`. */
function collectTemplates(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collectTemplates(path, out);
    else if (entry.endsWith('.html')) out.push(path);
  }

  return out;
}

const BUTTON_RE = /<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g;
const SR_ONLY_RE = /class="[^"]*\bsr-only\b/;
// Covers `aria-label=`, `[attr.aria-label]=`, `[ariaLabel]=` and the same three
// for `aria-labelledby`. The `attr.` prefix and the closing `]` are both valid
// A button that is itself `aria-hidden="true"` is removed from the accessibility
// tree entirely, so it needs no name (the TaskTableColumns cursor anchor is
// such a button).
const ARIA_HIDDEN_RE = /\baria-hidden\s*=\s*"true"/;
// Angular template spellings, so both are matched explicitly.
const NAME_RE = /\b(?:attr\.|host\.)?aria-(label|labelledby)("|\])\s*=|\[aria-?Label(ledBy)?\]\s*=/i;

interface Unnamed {
  file: string;
  line: number;
  snippet: string;
}

describe('icon-only buttons have an accessible name (F20)', () => {
  const offenders: Unnamed[] = [];

  for (const file of collectTemplates(SRC)) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(BUTTON_RE)) {
      const attrs = match[1] ?? '';
      const inner = match[2] ?? '';
      // NOTE: `{{ … | transloco }}` is NOT stripped — an interpolated-only body
      // still renders visible (and therefore accessible) text.
      const visibleText = inner.replace(/<[^>]*>/g, '').trim();

      if (visibleText !== '') continue;
      if (SR_ONLY_RE.test(inner)) continue;
      if (ARIA_HIDDEN_RE.test(attrs)) continue;
      if (NAME_RE.test(attrs)) continue;

      const line = source.slice(0, match.index).split('\n').length;

      offenders.push({
        file: relative(SRC, file).split(sep).join('/'),
        line,
        snippet: `<button${attrs.replace(/\s+/g, ' ').slice(0, 110)}>`,
      });
    }
  }

  it('finds no button that relies on a tooltip alone', () => {
    // Printed in full so a regression names the exact file:line to fix.
    const report = offenders.map((o) => `${o.file}:${o.line}  ${o.snippet}`).join('\n');

    expect(report).toBe('');
  });

  it('actually inspects the templates the F20 audit flagged', () => {
    // Guards the guardrail: a broken path/glob would make the test above vacuous.
    const templates = collectTemplates(SRC);
    const audited = [
      'app/shared/milkdown-editor/milkdown-editor.html',
      'app/features/projects/board-columns/board-columns.html',
      'app/features/tasks/task-table/task-table.html',
      'app/shared/member-table/member-table.html',
      'app/features/sprints/sprint-detail/sprint-detail.html',
    ].map((rel) => templates.find((f) => f.endsWith(sep + rel.split('/').join(sep))));

    expect(audited.every(Boolean)).toBe(true);
  });
});
