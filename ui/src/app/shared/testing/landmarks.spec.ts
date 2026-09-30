/**
 * a11y guardrails for the shell: the primary navigation is a landmark and
 * the page scroller compensates for the sticky header.
 *
 * One defect in this group has an *occurrence* the audit could not
 * measure — only the mechanism (`grep scroll-mt` → 0) — so the rule is written
 * as a correspondence rather than a constant: the scroller's scroll-padding must
 * name the same height token the header declares. If the header grows, the
 * padding follows; if someone hardcodes a number, the assertion fails.
 *
 * The skip link is asserted here too because it lives on the same element: the skip
 * link's destination must not suppress its own focus indicator.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(SRC, ...rel.split('/')), 'utf8');
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collect(path, out);
    else if (entry.endsWith('.html')) out.push(path);
  }

  return out;
}

const SHELL = 'shell/app-shell/app-shell.html';
const HEADER = 'shell/header/header.html';
const SIDEBAR = 'shell/sidebar/sidebar.html';
const EDITOR = 'shared/milkdown-editor/milkdown-editor.html';
/** Comments are stripped first: this file's own prose mentions `<main>`. */
const stripComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');
const appShell = stripComments(read(SHELL));
const header = stripComments(read(HEADER));
const sidebar = stripComments(read(SIDEBAR));
const editor = stripComments(read(EDITOR));
/** The `<main …>` open tag of the app shell — the scroller and focus target. */
const mainTag = /<main\b[^>]*>/.exec(appShell)?.[0] ?? '';

describe('the primary navigation is a landmark (D-54)', () => {
  it('declares exactly one navigation landmark, on the sidebar host', () => {
    const landmarks = collect(join(SRC, '..'))
      .map((file) => [readFileSync(file, 'utf8'), file] as const)
      .filter(([source]) => /role=["']navigation["']/.test(source) || /<nav\b/.test(source));

    expect(landmarks.map(([, file]) => relative(SRC, file).split(sep).join('/'))).toEqual([
      'shell/sidebar/sidebar.html',
    ]);
    expect(sidebar).toMatch(/<hlm-sidebar\b[^>]*role="navigation"/);
  });
});

describe('the page scroller compensates for the sticky header (D-56)', () => {
  it('takes its scroll-padding from the header height token, not a literal', () => {
    // The header's own declaration is the source: `h-(--header-height)`.
    const headerHeight = /h-\((--[\w-]+)\)/.exec(header)?.[1];

    expect(headerHeight).toBeTruthy();
    expect(mainTag).toMatch(new RegExp(`scroll-pt-\\(${headerHeight}\\)`));
  });

  it('does not hardcode a scroll-padding length in the shell', () => {
    // A literal (e.g. `scroll-pt-16`) silently stops matching the header the day
    // the token changes; the correspondence above is the property.
    expect(mainTag).not.toMatch(/scroll-pt-\d/);
  });
});

describe('the skip-link destination shows a focus indicator (D-52)', () => {
  it('does not suppress the focus outline on the target it jumps to', () => {
    expect(mainTag).toContain('tabindex="-1"');
    expect(mainTag).not.toMatch(/\bfocus:outline-none\b/);
    // …and something replaces it.
    expect(mainTag).toMatch(/focus-visible:ring-\d/);
  });
});

describe('every formatting toggle reports its state (D-51)', () => {
  /** The toolbar's command names that are toggles rather than actions. */
  const TOGGLE_COMMANDS = ['strong', 'emphasis', 'strikethrough', 'inlineCode'];

  it('binds aria-pressed to a live mark state on each toggle, and to nothing else', () => {
    const buttons = [...editor.matchAll(/<button\b([\s\S]*?)>/g)].map((m) => m[1] ?? '');
    const toggles = buttons.filter((attrs) =>
      TOGGLE_COMMANDS.some((command) => attrs.includes(`runCommand('${command}')`)),
    );

    // Four toggles exist; the assertion below is about their wiring, not their count.
    expect(toggles.length).toBe(TOGGLE_COMMANDS.length);

    for (const attrs of toggles) {
      // A literal `aria-pressed="false"` would be a lie rather than a fix, so the
      // value has to come from the editor's own selection state.
      expect(attrs).toMatch(/\[attr\.aria-pressed\]="isMarkActive\('[\w_]+'\)"/);
    }

    // …and an action (the heading buttons) must not claim to be a toggle.
    const pressed = buttons.filter((attrs) => attrs.includes('attr.aria-pressed'));

    expect(pressed.length).toBe(toggles.length);
  });
});
