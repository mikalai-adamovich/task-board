import type { Collection, ObjectId } from 'mongodb';
import type { DateFormatPreference, ThemeMode, TimeFormatPreference } from '@task-board/shared';

// guardrail:no-base-repository 2026-09-29 — settings are keyed by `userId` and
// the document has no `id` at all, so there is nothing for an `id`-keyed base to
// address. See `rules/guardrails.guardrail.test.ts` (P-03).

// ─── MongoDB Document Shape ──────────────────────────────────────────────────

export interface UserSettingsDocument {
  _id?: ObjectId;
  userId: string;
  zoom: number;
  /** Legacy single-theme field kept for backward compatibility with older clients. */
  theme: string;
  /** Theme mode (default 'auto'): 'auto' follows the browser's prefers-color-scheme. */
  themeMode?: ThemeMode;
  /** Theme applied when mode is 'light' (or in 'auto' with a light system scheme). */
  lightTheme?: string | null;
  /** Theme applied when mode is 'dark' (or in 'auto' with a dark system scheme). */
  darkTheme?: string | null;
  language: string;
  pageSize: number;
  /** Preferred date display format (null = not set). */
  dateFormat: DateFormatPreference | null;
  /** Preferred time display format (null = not set). */
  timeFormat: TimeFormatPreference | null;
  updatedAt: Date;
}

// ─── Domain Shape ────────────────────────────────────────────────────────────

export interface UserSettings {
  userId: string;
  zoom: number;
  /** Legacy single-theme field kept for backward compatibility with older clients. */
  theme: string;
  /** Theme mode (default 'auto'): 'auto' follows the browser's prefers-color-scheme. */
  themeMode: ThemeMode;
  /** Theme applied when mode is 'light' (or in 'auto' with a light system scheme). */
  lightTheme: string | null;
  /** Theme applied when mode is 'dark' (or in 'auto' with a dark system scheme). */
  darkTheme: string | null;
  language: string;
  pageSize: number;
  /** Preferred date display format (null = not set). */
  dateFormat: DateFormatPreference | null;
  /** Preferred time display format (null = not set). */
  timeFormat: TimeFormatPreference | null;
  updatedAt: string;
}

/**
 * A PATCH over the settings document. `| undefined` on every field because
 * the route forwards the parsed `UpdateUserGlobalSettingsSchema` body, whose
 * omitted keys are explicit `undefined`s; `upsert` then applies only the fields
 * that are actually present.
 */
export interface UpdateUserSettings {
  zoom?: number | undefined;
  theme?: string | undefined;
  themeMode?: ThemeMode | undefined;
  lightTheme?: string | null | undefined;
  darkTheme?: string | null | undefined;
  language?: string | undefined;
  pageSize?: number | undefined;
  dateFormat?: DateFormatPreference | null | undefined;
  timeFormat?: TimeFormatPreference | null | undefined;
}

const DEFAULTS = {
  zoom: 100,
  theme: 'light',
  themeMode: 'auto' as ThemeMode,
  lightTheme: null,
  darkTheme: null,
  language: 'en',
  pageSize: 20,
  dateFormat: null,
  timeFormat: null,
};

function toDomain(doc: UserSettingsDocument): UserSettings {
  return {
    userId: doc.userId,
    zoom: doc.zoom,
    theme: doc.theme,
    themeMode: doc.themeMode ?? DEFAULTS.themeMode,
    lightTheme: doc.lightTheme ?? DEFAULTS.lightTheme,
    darkTheme: doc.darkTheme ?? DEFAULTS.darkTheme,
    language: doc.language,
    pageSize: doc.pageSize ?? DEFAULTS.pageSize,
    dateFormat: doc.dateFormat ?? DEFAULTS.dateFormat,
    timeFormat: doc.timeFormat ?? DEFAULTS.timeFormat,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function defaultsFor(userId: string): UserSettings {
  return { userId, ...DEFAULTS, updatedAt: new Date().toISOString() };
}

// ─── User Settings Repository ────────────────────────────────────────────────

export class UserSettingsRepository {
  constructor(private readonly collection: Collection<UserSettingsDocument>) {}

  /** Global settings for a user; returns defaults when no document exists yet. */
  async findByUserId(userId: string): Promise<UserSettings> {
    const doc = await this.collection.findOne({ userId });

    return doc ? toDomain(doc) : defaultsFor(userId);
  }

  /**
   * Partially update global settings (upsert).
   * `$setOnInsert` must not contain keys that also appear in `$set` —
   * MongoDB rejects that with "Updating the path … would create a conflict".
   */
  async upsert(userId: string, patch: UpdateUserSettings): Promise<UserSettings> {
    const now = new Date();
    const $set: Record<string, unknown> = { updatedAt: now };
    const $setOnInsert: Record<string, unknown> = { userId };

    for (const key of [
      'zoom',
      'theme',
      'themeMode',
      'lightTheme',
      'darkTheme',
      'language',
      'pageSize',
      'dateFormat',
      'timeFormat',
    ] as const) {
      if (patch[key] !== undefined) {
        $set[key] = patch[key];
      } else {
        $setOnInsert[key] = DEFAULTS[key];
      }
    }

    await this.collection.updateOne({ userId }, { $set, $setOnInsert }, { upsert: true });

    return this.findByUserId(userId);
  }
}
