import { isValidDateFormat } from '@task-board/shared';
import type { DateFormatPreference, TimeFormatPreference } from '@task-board/shared';

/**
 * Date/time display format helpers.
 *
 * Translate the persisted user preferences into Angular DatePipe format
 * strings, which templates consume via `{{ value | date: fmt() }}`.
 * Timezone handling is unchanged — values are rendered in local time.
 */

// `DEFAULT_DATE_FORMAT` / `DEFAULT_TIME_FORMAT` were removed as dead code.
// The fallback literals live inside the `toDatePipeFormat` / `toTimePipeFormat`
// mappers themselves, so these two exported names had no readers — and being
// exported, they looked like the authoritative default while duplicating it.

/**
 * Preference → DatePipe date tokens.
 *
 * User tokens map 1:1 to DatePipe tokens where they differ — `YYYY`→`yyyy`,
 * `YY`→`yy`, `DD`→`dd`, `D`→`d` — while `MM`, `M`, `MMM`, `MMMM` and all
 * separators pass through unchanged. Invalid or empty preferences fall back
 * to the ISO default.
 */
export function toDatePipeDateFormat(pref: DateFormatPreference | null): string {
  if (!pref || !isValidDateFormat(pref)) return 'yyyy-MM-dd';

  return pref.replaceAll('YYYY', 'yyyy').replaceAll('YY', 'yy').replaceAll('DD', 'dd').replaceAll('D', 'd');
}

/** Preference → DatePipe time tokens ('24h' → 'HH:mm', '12h' → 'h:mm a'). */
export function toDatePipeTimeFormat(pref: TimeFormatPreference | null): string {
  return pref === '12h' ? 'h:mm a' : 'HH:mm';
}

/** Combined preference pair → single DatePipe format string for timestamps. */
export function toDatePipeDateTimeFormat(
  datePref: DateFormatPreference | null,
  timePref: TimeFormatPreference | null,
): string {
  return `${toDatePipeDateFormat(datePref)} ${toDatePipeTimeFormat(timePref)}`;
}
