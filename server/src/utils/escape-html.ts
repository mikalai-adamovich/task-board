/**
 * Escape a value for safe interpolation into HTML text content and
 * double-quoted attribute values (email templates).
 *
 * Escapes `&`, `<`, `>`, `"` and `'` — the minimal set that prevents both
 * markup injection and attribute breakout.
 */

// Entities are split across concatenations so this source file never contains a raw HTML entity.
const AMP_ENTITY = '&' + 'amp;';
const LT_ENTITY = '&' + 'lt;';
const GT_ENTITY = '&' + 'gt;';
const QUOT_ENTITY = '&' + 'quot;';
const APOS_ENTITY = '&' + '#39;';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, AMP_ENTITY)
    .replace(/</g, LT_ENTITY)
    .replace(/>/g, GT_ENTITY)
    .replace(/"/g, QUOT_ENTITY)
    .replace(/'/g, APOS_ENTITY);
}
