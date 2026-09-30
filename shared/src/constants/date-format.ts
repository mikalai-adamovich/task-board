/**
 * Date/time display format preferences (R3-P8, P12/DEC-056).
 *
 * Single source of truth for the user's preferred date and time rendering,
 * shared by the server (Zod validation of the persisted global preference)
 * and the UI (settings selects, date formatting helpers).
 *
 * `dateFormat` is a free-form string built from a whitelisted token set
 * (`YYYY YY MM M DD D MMM MMMM` + separators `space / - . ,`). The presets in
 * `DATE_FORMAT_PREFERENCES` remain as quick-pick options in the settings UI.
 *
 * Values are stored as-is on the global user-preferences document; null means
 * "not set" and callers fall back to their default rendering.
 */
export const DATE_FORMAT_PREFERENCES = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;

/** A date format is any whitelisted-token string — presets are just well-known members. */
export type DateFormatPreference = string;

/** Allowed date-format tokens, longest first so greedy matching is correct. */
const DATE_FORMAT_TOKENS = ['YYYY', 'MMMM', 'MMM', 'YY', 'MM', 'DD', 'M', 'D'] as const;
/** Allowed separators between tokens. */
const DATE_FORMAT_SEPARATOR = /[\s/\-.,]/;

/** Upper bound for a user-supplied format string. */
export const DATE_FORMAT_MAX_LENGTH = 32;

/**
 * Validate a free-form date format against the token whitelist.
 * Accepts any mix of `YYYY YY MM M DD D MMM MMMM` separated by spaces, `/ - . ,`
 * (separators may repeat). Rejects unknown tokens (e.g. `QQ`), lowercase
 * tokens, other punctuation and strings longer than {@link DATE_FORMAT_MAX_LENGTH}.
 */
export function isValidDateFormat(format: string): boolean {
  if (!format || format.length > DATE_FORMAT_MAX_LENGTH) return false;

  let i = 0;

  while (i < format.length) {
    const token = DATE_FORMAT_TOKENS.find((t) => format.startsWith(t, i));

    if (token) {
      i += token.length;
      continue;
    }

    const char = format[i];

    if (char !== undefined && DATE_FORMAT_SEPARATOR.test(char)) {
      i += 1;
      continue;
    }

    return false;
  }

  return true;
}

export const TIME_FORMAT_PREFERENCES = ['24h', '12h'] as const;

export type TimeFormatPreference = (typeof TIME_FORMAT_PREFERENCES)[number];
