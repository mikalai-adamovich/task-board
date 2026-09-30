/**
 * a11y guardrail: every interactive element has an accessible name, and every
 * pointer-only table row is keyboard-activatable.
 *
 * Seven form controls had **no** accessible name: the app's primary task
 * search box, the two column-filter inputs, the raw-markdown surface (which is
 * also the automatic fallback when Milkdown fails to initialise), the inline
 * title editor and the two inline name editors. The task search box — the `/`
 * hotkey's focus target and the product's main filter — was announced as
 * "edit text, blank": a placeholder is not a name, and it disappears on the
 * first keystroke.
 *
 * Two table rows were activated by pointer only. Opening a task from the
 * task list is the most repeated navigation in the product and a keyboard or
 * switch user could not perform it at all.
 *
 * Why this is a *different* spec from `icon-button-names.spec.ts` (which FX13
 * keeps as it was): that one covers icon-only **buttons** and nothing else. The
 * defect class here is "any interactive element", so the rule is stated over any
 * interactive element and both properties are scans — they cover every template
 * in the app, including surfaces no test renders (CDK portal bodies, the editor's
 * fallback textarea).
 *
 * The two properties, stated so a differently written correct control passes:
 *   1. every interactive element resolves an accessible name (label, aria, name
 *      from content, or a signal-form control inside a labelled field);
 *   2. an element that *acts* on `(click)` is reachable and operable from the
 *      keyboard — it is focusable and handles Enter/Space, or it is/contains a
 *      natively focusable control. A `(click)` that only stops propagation is
 *      not an action and is exempt.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

function collectTemplates(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collectTemplates(path, out);
    else if (entry.endsWith('.html')) out.push(path);
  }

  return out;
}

/** Elements that are interactive by their tag. */
const NAME_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
/** …and elements that become interactive by declaring one of these roles. */
const NAME_ROLES = new Set(
  'button checkbox switch toggle tab menuitem combobox searchbox radio slider spinbutton option'.split(' '),
);
/** Void elements can never take their name from content. */
const VOID_TAGS = new Set(['input']);
const SR_ONLY_RE = /class="[^"]*\bsr-only\b/;
const ARIA_HIDDEN_RE = /aria-hidden\s*=\s*["']true["']/;
const ARIA_NAME_RE = /aria-label(ledby)?\s*=\s*["'][^"']+["']|\[attr\.aria-label/;
const FORM_FIELD_RE = /\[formField\]|\(formField\)/;
const LABEL_FOR_RE = /<label[^>]*\bfor=["']([^"']+)["']/g;
const ELEMENT_RE = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
const CLICK_RE = /<([a-zA-Z][\w-]*)\b([^>]*?)\(click\)=["']([^"']*)["']([^>]*)>/g;
const KEY_ACTIVATION_RE = /\(keydown\.(enter|space)\)\s*=/;
const FOCUSABLE_TAGS_RE = /<(a|button|input|select|textarea)\b/;

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

const unnamed: Offender[] = [];
const pointerOnly: Offender[] = [];
let scannedInteractive = 0;
const templates: string[] = [];
const locate = (file: string, source: string, index: number, snippet: string): Offender => ({
  file: relative(SRC, file).split(sep).join('/'),
  line: source.slice(0, index).split('\n').length,
  snippet,
});

for (const file of collectTemplates(SRC)) {
  const source = readFileSync(file, 'utf8');
  const labelTargets = new Set([...source.matchAll(LABEL_FOR_RE)].map((m) => m[1] as string));

  templates.push(relative(SRC, file).split(sep).join('/'));

  for (const match of source.matchAll(ELEMENT_RE)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = match[2] ?? '';
    const role = /role=["']([^"']+)["']/.exec(attrs)?.[1] ?? '';

    if (!NAME_TAGS.has(tag) && !NAME_ROLES.has(role)) continue;
    if (/type\s*=\s*["']hidden["']/.test(attrs) || ARIA_HIDDEN_RE.test(attrs)) continue;

    scannedInteractive++;

    const id = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1] ?? null;
    const hasName = ARIA_NAME_RE.test(attrs) || (id !== null && labelTargets.has(id)) || FORM_FIELD_RE.test(attrs);

    if (!hasName) {
      // Name from content: an interpolated body still renders visible text.
      const inner = VOID_TAGS.has(tag)
        ? ''
        : source.slice(match.index + match[0].length, source.indexOf(`</${tag}>`, match.index));
      const text = (inner ?? '').replace(/<[^>]*>/g, '').trim();

      if (text === '' && !SR_ONLY_RE.test(inner ?? '')) {
        unnamed.push(locate(file, source, match.index, `<${tag}${role ? ` role="${role}"` : ''}>`));
      }
    }
  }

  for (const match of source.matchAll(CLICK_RE)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = `${match[2] ?? ''} ${match[4] ?? ''}`;
    const handler = (match[3] ?? '').trim();
    // The property is about table rows: an activated row is a control in its own
    // right. A `(click)` that only stops propagation is not an action at all.
    const isRow = tag === 'tr' || /role=["']row["']/.test(attrs);

    if (!isRow) continue;
    if (/^\$event\s*\.\s*stopPropagation\(\s*\)\s*;?$/.test(handler)) continue;

    const focusable = ['button', 'a', 'input', 'select', 'textarea'].includes(tag) || /tabindex\s*=/.test(attrs);
    const closes = source.indexOf(`</${tag}>`, match.index);
    const inner = closes === -1 ? '' : source.slice(match.index + match[0].length, closes);

    if (
      focusable ||
      KEY_ACTIVATION_RE.test(attrs) ||
      FOCUSABLE_TAGS_RE.test(inner) ||
      /tabindex\s*=\s*["']?0/.test(inner)
    ) {
      continue;
    }

    pointerOnly.push(locate(file, source, match.index, `<${tag}> (click)="${handler.slice(0, 60)}"`));
  }
}

const report = (rows: Offender[]): string => rows.map((r) => `${r.file}:${r.line}  ${r.snippet}`).join('\n');

describe('every interactive element has an accessible name (D-50)', () => {
  it('finds no unnamed interactive element', () => {
    expect(report(unnamed)).toBe('');
  });

  // Guards the guardrail: a broken path, a renamed tag set or an empty corpus
  // would make the assertion above pass for the wrong reason.
  it('inspects the whole template corpus, including the seven D-50 sites', () => {
    expect(scannedInteractive).toBeGreaterThan(100);
    expect(templates).toEqual(
      expect.arrayContaining([
        'features/tasks/task-table/task-table-header/task-table-header.html',
        'features/tasks/task-detail/task-detail.html',
        'features/labels/label-manager/label-manager.html',
        'features/statuses/status-manager/status-manager.html',
        'shared/member-table/member-table.html',
        'shared/milkdown-editor/milkdown-editor.html',
        'features/tasks/task-table/task-table.html',
      ]),
    );
  });
});

describe('a pointer-activated table row is keyboard-activatable (D-49)', () => {
  it('finds no click handler that only a pointer can reach', () => {
    expect(report(pointerOnly)).toBe('');
  });
});
