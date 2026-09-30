/**
 * Markdown → plain text.
 *
 * **The defect this exists to remove.** The rich-text editor always stores
 * Markdown (`ui/src/app/shared/milkdown-editor/milkdown-editor.ts`, "the value is
 * always markdown"), and the task search compiled a case-insensitive regex over
 * the STORED description (`task.repository.ts`). A description typed as
 * `**bold** text` was therefore findable by `bold` and by `**bold**`, but not by
 * the phrase `bold text` as it reads on screen — and the Markdown punctuation was
 * itself matchable content. Search silently under-matched on every formatted
 * description, with no error and no log.
 *
 * **The fix, and where it applies.** The description is stored as Markdown (that
 * is the editor's contract and it is not changed here) and a PLAIN-TEXT
 * PROJECTION is written alongside it on every save. The search regex runs over
 * the projection, so a hit is text somebody can see on screen.
 *
 * **Deliberately dependency-free.** This is a projection, not a renderer: it must
 * be byte-identical on the write path (repository) and in the backfill migration,
 * on every platform the server runs on, without adding a Markdown parser to the
 * bundle. So the rules are the conservative common subset — what Milkdown's
 * toolbar can produce — and anything unrecognised degrades to "its own text",
 * which under-matches rather than over-matches. Over-matching is the defect being
 * fixed; under-matching on an exotic construct is the safe direction.
 *
 * The function is PURE and total: no I/O, no clock, no randomness, so the
 * migration and the write path cannot disagree.
 */

/** Opening/closing fence of a fenced code block (``` or ~~~), any length ≥ 3. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A thematic break (`---`, `***`, `___`) on a line of its own. */
const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A table delimiter row (`| --- | :--: |`), which renders as no text at all. */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/;
/**
 * Placeholder for a backslash-escaped marker, swapped in before any other rule
 * runs and swapped back at the end.
 *
 * It has to be a placeholder rather than a plain de-escape: `\*stars\*` is
 * RENDERED as `*stars*`, and every emphasis rule below would otherwise read those
 * asterisks as markup and strip them — turning escaped literal text into missing
 * text, which is the worst direction for a search index. A private-use code
 * point is used because no Markdown construct can produce one, so a literal
 * character in a description cannot be mistaken for a placeholder.
 */
/**
 * Private-use code point the escaped character is parked AS — not next to.
 *
 * Parking it *beside* itself (`\ue000*`) does not work: the emphasis rules match
 * on the marker, not on the backslash, so a parked `*` is still a `*` and gets
 * consumed — which turned `\*stars\*` into `stars`, losing text rather than
 * merely failing to strip it. So the escaped character is TRANSLATED to a
 * private-use code point for the duration of the strip and translated back at
 * the end. No Markdown construct produces a private-use character, so a literal
 * one in a description cannot be mistaken for a parked marker.
 */
const ESCAPE_BASE = 0xe000;
/** A backslash followed by one of these is a LITERAL character, not markup. */
const ESCAPED_MARKER = /\\([\\`*_{}[\]()#+\-.!>~|])/g;

/** Printable ASCII → private-use code point (and back). */
function park(char: string): string {
  return String.fromCharCode(ESCAPE_BASE + char.charCodeAt(0) - 0x21);
}

/** The inverse of {@link park}, applied to every private-use character present. */
function unpark(text: string): string {
  return text.replace(/[\ue000-\ue0ff]/g, (match) => String.fromCharCode(match.charCodeAt(0) - ESCAPE_BASE + 0x21));
}

/**
 * Strip the inline and line-leading constructs that carry no prose.
 *
 * Order is load-bearing, in three parts:
 *  1. escaped markers are parked as placeholders FIRST, because an escaped marker
 *     is not a marker and every rule below would otherwise consume it;
 *  2. block-level constructs (comments, tags, links, code spans, headings,
 *     quotes, list markers, tables) are removed;
 *  3. emphasis runs longest-marker-first, so `***x***` is not eaten one `*` at a
 *     time; the placeholders are restored last.
 */
function stripInline(line: string): string {
  return (
    line
      // 1. Park escaped markers so no later rule can read them as markup.
      .replace(ESCAPED_MARKER, (_match, char: string) => park(char))
      // 2. HTML comments and tags render as nothing (a code span is handled below).
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
      // `![alt](url)` → `alt`; the image itself is not text, its alt text is.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // `[text](url)` → `text`; the URL is a target, not prose.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // `[text][ref]` / `[ref][]` reference links → `text`.
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // `<https://example.com>` autolinks → the URL, which IS what is shown.
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1')
      // Inline code: the backticks are syntax, the content is shown.
      .replace(/(`+)([^`]+?)\1/g, '$2')
      // ATX heading marker, blockquote marker, ordered/unordered list marker.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
      .replace(/^[ \t]{0,3}>[ \t]?/, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, '')
      // Emphasis, longest marker first. A marker must be followed by a
      // non-space (Markdown's own left/right-flanking rule, approximated) so
      // `2 * 3 * 4` keeps its asterisks, and `_` additionally refuses to match
      // inside a word so `snake_case_name` survives intact.
      .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '$1')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '$1')
      .replace(/\*(?=\S)([\s\S]+?)(?<=\S)\*(?!\*)/g, '$1')
      .replace(/(?<![\w_])___(?=\S)([\s\S]+?)(?<=\S)___(?![\w_])/g, '$1')
      .replace(/(?<![\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([\s\S]+?)(?<=\S)_(?![\w_])/g, '$1')
      // Strikethrough `~~x~~` → `x`.
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '$1')
      // Table cells: the pipes are layout, the cell text is prose.
      .replace(/\|/g, ' ')
      // 3. Restore the escaped characters as themselves.
      .replace(/[\ue000-\ue0ff]/g, (match) => unpark(match))
      .trim()
  );
}

/**
 * Project a Markdown string to the prose a reader sees.
 *
 * Code-block CONTENT is kept (it is rendered on screen) and only the fences are
 * dropped. Everything collapses to single spaces, so the projection is
 * whitespace-normalised: a search for `bold text` matches across a line break,
 * which is what a reader would expect and what the raw source never gave.
 *
 * @returns the plain text; `''` for nullish, empty or wholly-markup input.
 */
export function toPlainText(markdown: string | null | undefined): string {
  if (markdown === null || markdown === undefined) {
    return '';
  }

  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE_LINE.exec(line);

    if (fence === null && fenceMatch) {
      // Opening fence: the language info string is not shown.
      fence = (fenceMatch[1] ?? '').charAt(0);
      continue;
    }

    if (fence !== null) {
      if (fenceMatch && (fenceMatch[1] ?? '').charAt(0) === fence) {
        fence = null; // closing fence
        continue;
      }
      // Inside a code block the content is shown verbatim.
      kept.push(line);
      continue;
    }

    if (THEMATIC_BREAK.test(line) || TABLE_DELIMITER.test(line)) {
      continue;
    }

    kept.push(stripInline(line));
  }

  return kept.join(' ').replace(/\s+/g, ' ').trim();
}
