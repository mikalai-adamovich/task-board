/**
 * Source-asserted guardrails for the rich-text editor (items 24 and 28).
 *
 * Both rules are about attributes the TEST ENVIRONMENT NEVER RENDERS: the
 * toolbar sits behind `!fallbackMode()`, and unit tests always fall back (the
 * Milkdown editor cannot mount without a real DOM editor). A rendered-instance
 * test would therefore assert nothing. This spec reads the sources instead —
 * the same approach `icon-button-names.spec.ts` takes, and strictly stronger
 * than spot-checking one instance.
 *
 *  1. The toolbar must NOT declare `role="toolbar"`. That role promises a
 *     composite widget (one tab stop, arrow keys between controls). The
 *     container has no key handler and no roving tabindex, so assistive
 *     technology was told one thing and given fourteen ordinary buttons.
 *     Implementing the composite widget is a feature, not a fix, so the role is
 *     removed instead.
 *  2. The editing surface's accessible name comes from its own
 *     translation key, present and non-empty in ALL 11 locale files. It used to
 *     borrow `milkdownEditor.wysiwyg`, the string "WYSIWYG", which labels the
 *     button that switches TO the rich-text view — so a screen reader announced
 *     the field by a mode name.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EDITOR_DIR = join(__dirname);
const APP = join(EDITOR_DIR, '..', '..');
const LOCALES = join(APP, '..', '..', 'public', 'assets', 'i18n');
const TEMPLATE = readFileSync(join(EDITOR_DIR, 'milkdown-editor.html'), 'utf8');
const COMPONENT = readFileSync(join(EDITOR_DIR, 'milkdown-editor.ts'), 'utf8');
/** Locale files as shipped, so the count is derived rather than declared. */
const LOCALE_FILES = readdirSync(LOCALES).filter((name) => name.endsWith('.json'));

function locale(name: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(LOCALES, name), 'utf8')) as Record<string, Record<string, string>>;
}

describe('rich-text editor accessibility (N-8 / N-10)', () => {
  describe('toolbar role (N-8)', () => {
    it('does not declare role="toolbar" anywhere in the template', () => {
      // The role is only meaningful on the container; a comment may NAME it to
      // explain the absence, which is why the source is stripped of comments
      // before the assertion.
      const withoutComments = TEMPLATE.replace(/<!--[\s\S]*?-->/g, '');

      expect(withoutComments).not.toMatch(/role="toolbar"/);
    });

    it('keeps the container labelled, so removing the role loses no name', () => {
      expect(TEMPLATE).toContain("'milkdownEditor.toolbar' | transloco");
    });

    it('documents why the role is absent', () => {
      // Without this, the next person adds the role back because the toolbar
      // "obviously is one".
      expect(TEMPLATE).toMatch(/role="toolbar"/);
      expect(TEMPLATE).toMatch(/roving tabindex/);
    });
  });

  describe('editing-surface accessible name (item 28)', () => {
    it('derives a non-empty locale set (anti-vacuity)', () => {
      expect(LOCALE_FILES).toHaveLength(11);
    });

    it('reads its name from its own key, not from the mode-toggle key', () => {
      expect(COMPONENT).toContain("selectTranslate('milkdownEditor.editor')");
      expect(COMPONENT).not.toContain("selectTranslate('milkdownEditor.wysiwyg')");
    });

    it('defines the key in every locale file, and it is never the borrowed string', () => {
      const missing = LOCALE_FILES.filter((name) => {
        const value = locale(name).milkdownEditor?.editor;

        return typeof value !== 'string' || value.trim() === '';
      });

      expect(missing.join('\n')).toBe('');
    });

    it('gives the editor a name that describes the field, not the mode it is in', () => {
      // Every locale inherited the same borrowed "WYSIWYG" string; a key that
      // still carries it has not been translated.
      const stillBorrowed = LOCALE_FILES.filter((name) => {
        const section = locale(name).milkdownEditor ?? {};

        return (section.editor ?? '').trim() === (section.wysiwyg ?? '').trim();
      });

      expect(stillBorrowed.join('\n')).toBe('');
    });

    it('leaves the mode-toggle key in place — it still labels the toggle button', () => {
      const missingToggle = LOCALE_FILES.filter((name) => {
        const value = locale(name).milkdownEditor?.wysiwyg;

        return typeof value !== 'string' || value.trim() === '';
      });

      expect(missingToggle.join('\n')).toBe('');
    });
  });
});
