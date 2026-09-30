/**
 * The plain-text projection's contract.
 *
 * The property under test is not "this regex strips asterisks". It is: **a string
 * a user can read on screen is a string search can find, and Markdown syntax is
 * not itself findable.** Before this projection, the search regex ran over the
 * Markdown source, so `**bold** text` was findable by `**bold**` and not by
 * `bold text` — the opposite of both halves of that sentence.
 *
 * The second half is the one that is easy to regress silently: adding a rule that
 * leaves a marker behind makes a punctuation-only search succeed, which no user
 * ever notices and no log ever records.
 */
import { describe, it, expect } from 'vitest';
import { toPlainText } from './markdown-plain-text.js';

describe('toPlainText — what a reader sees', () => {
  it('returns plain text unchanged', () => {
    expect(toPlainText('a plain description')).toBe('a plain description');
  });

  it('is total over nullish input (an absent description is not an error)', () => {
    expect(toPlainText(null)).toBe('');
    expect(toPlainText(undefined)).toBe('');
    expect(toPlainText('')).toBe('');
  });

  it('keeps a multi-word phrase that spans a line break', () => {
    // The defect in its simplest form: a line break inside the phrase meant the
    // phrase was not a contiguous string in the source, so a user typing it could
    // not find it.
    expect(toPlainText('bold\ntext here')).toBe('bold text here');
  });

  it('collapses runs of whitespace so a phrase is findable however it was typed', () => {
    expect(toPlainText('  spaced   out \n\n text ')).toBe('spaced out text');
  });
});

describe('toPlainText — inline markup becomes its text', () => {
  const cases: [label: string, markdown: string, expected: string][] = [
    ['bold', 'a **bold** word', 'a bold word'],
    ['italic', 'an *italic* word', 'an italic word'],
    ['bold italic', 'a ***bold italic*** word', 'a bold italic word'],
    ['underscore bold', 'a __bold__ word', 'a bold word'],
    ['underscore italic', 'an _italic_ word', 'an italic word'],
    ['strikethrough', 'a ~~struck~~ word', 'a struck word'],
    ['inline code', 'run `npm test` now', 'run npm test now'],
    ['a link keeps its text, not its URL', 'see [the docs](https://example.com/x)', 'see the docs'],
    ['an image keeps its alt text', '![a diagram](https://example.com/i.png)', 'a diagram'],
    ['a heading loses its hashes', '## Heading', 'Heading'],
    ['a blockquote loses its marker', '> quoted', 'quoted'],
    ['an unordered list loses its bullet', '- first\n- second', 'first second'],
    ['an ordered list loses its number', '1. first\n2. second', 'first second'],
    ['a thematic break disappears', 'above\n\n---\n\nbelow', 'above below'],
  ];

  for (const [label, markdown, expected] of cases) {
    it(`strips ${label}`, () => {
      expect(toPlainText(markdown)).toBe(expected);
    });
  }

  it('leaves a snake_case identifier alone (underscores are not emphasis here)', () => {
    // A naive `_{1,3}` rule turns `task_number` into `tasknumber` and makes a
    // search for the field name miss.
    expect(toPlainText('set the task_number field')).toBe('set the task_number field');
  });

  it('leaves a multiplication sign alone (asterisks with spaces are not emphasis)', () => {
    expect(toPlainText('width is 2 * 3 * 4')).toBe('width is 2 * 3 * 4');
  });

  it('de-escapes a backslash-escaped marker, which is rendered as the marker', () => {
    expect(toPlainText('literal \\*stars\\* here')).toBe('literal *stars* here');
  });
});

describe('toPlainText — block constructs', () => {
  it('keeps the CONTENT of a fenced code block and drops the fences', () => {
    // The code is on screen, so it is findable; the fence is not.
    expect(toPlainText('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before const x = 1; after');
  });

  it('drops a fence language info string, which is not shown', () => {
    expect(toPlainText('```typescript\nlet a;\n```')).toBe('let a;');
  });

  it('keeps text after a closing fence (the fence is not the end of the document)', () => {
    expect(toPlainText('```\ncode\n```\ntrailing prose')).toBe('code trailing prose');
  });

  it('treats an unterminated fence as running to the end rather than losing the text', () => {
    expect(toPlainText('intro\n```\nnever closed')).toBe('intro never closed');
  });

  it('keeps table cell text and drops the pipes and the delimiter row', () => {
    const markdown = ['| Field | Meaning |', '| --- | --- |', '| `id` | the identifier |'].join('\n');

    expect(toPlainText(markdown)).toBe('Field Meaning id the identifier');
  });

  it('strips an HTML tag but keeps the text around it', () => {
    expect(toPlainText('a <strong>bold</strong> word')).toBe('a bold word');
  });
});

describe('toPlainText — the round trip that fixes the defect', () => {
  it('a description with formatting is findable by the phrase a reader sees', () => {
    const description = '**Bold** heading and a [link](https://example.com) below it';
    const projection = toPlainText(description);

    // The phrase as typed on screen.
    expect(projection).toContain('Bold heading');
    expect(projection).toContain('a link below');
  });

  it('Markdown punctuation is NOT part of the projection, so it is not matchable content', () => {
    // The half of the defect nobody notices: before, `**` was itself findable.
    const projection = toPlainText('**bold** and `code` and [x](y)');

    expect(projection).not.toContain('*');
    expect(projection).not.toContain('`');
    expect(projection).not.toContain('](');
  });

  it('the projection is a pure function of its input (the backfill and the write path cannot disagree)', () => {
    const markdown = '## Title\n\nSome **bold** text with a [link](https://example.com).';
    const first = toPlainText(markdown);

    expect(toPlainText(markdown)).toBe(first);
    // Re-deriving from the projection is a fixed point for plain text, which is
    // what makes a re-run of the backfill a no-op rather than a second rewrite.
    expect(toPlainText(first)).toBe(first);
  });
});
