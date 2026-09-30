import { describe, it, expect } from 'vitest';
import { isValidDateFormat } from '@task-board/shared';
import { UpdateUserGlobalSettingsSchema } from './user-preferences.js';

describe('UpdateUserGlobalSettingsSchema', () => {
  it('accepts a dateFormat update', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'DD/MM/YYYY' });

    expect(result).toEqual({ dateFormat: 'DD/MM/YYYY' });
  });

  it('accepts a timeFormat update', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ timeFormat: '12h' });

    expect(result).toEqual({ timeFormat: '12h' });
  });

  it('accepts explicit null to reset date/time format', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ dateFormat: null, timeFormat: null });

    expect(result).toEqual({ dateFormat: null, timeFormat: null });
  });

  it('accepts the Auto page-size sentinel 0 (V7-2)', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ pageSize: 0 });

    expect(result.pageSize).toBe(0);
  });

  it('rejects a non-zero pageSize below the minimum of 5 (V7-2)', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ pageSize: 3 })).toThrow();
  });

  it('rejects a pageSize above the maximum of 100', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ pageSize: 101 })).toThrow();
  });

  it('accepts combined updates', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({
      pageSize: 50,
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
    });

    expect(result.dateFormat).toBe('YYYY-MM-DD');
    expect(result.timeFormat).toBe('24h');
  });

  it('rejects an unknown dateFormat value', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'dd.mm.yyyy' })).toThrow();
  });

  // ── Free-form date format ─────────────────────────────────────────────────

  it('accepts a custom whitelisted dateFormat (P12)', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'DD MMM YY' });

    expect(result.dateFormat).toBe('DD MMM YY');
  });

  it('accepts another custom token mix with separators (P12)', () => {
    const result = UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'MMMM D, YYYY' });

    expect(result.dateFormat).toBe('MMMM D, YYYY');
  });

  it('rejects a dateFormat with non-whitelisted tokens (P12)', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'QQ YYYY' })).toThrow();
  });

  it('rejects a dateFormat with injection payloads (P12)', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'YYYY; DROP' })).toThrow();
  });

  it('rejects a dateFormat exceeding the max length (P12)', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ dateFormat: 'YYYY '.repeat(9) })).toThrow();
  });

  it('rejects an empty dateFormat string (P12)', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ dateFormat: '' })).toThrow();
  });

  it('rejects an unknown timeFormat value', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({ timeFormat: 'am/pm' })).toThrow();
  });

  it('rejects an empty patch', () => {
    expect(() => UpdateUserGlobalSettingsSchema.parse({})).toThrow('At least one preference field must be provided');
  });
});

describe('isValidDateFormat (shared, P12)', () => {
  it('accepts the legacy presets', () => {
    expect(isValidDateFormat('DD/MM/YYYY')).toBe(true);
    expect(isValidDateFormat('MM/DD/YYYY')).toBe(true);
    expect(isValidDateFormat('YYYY-MM-DD')).toBe(true);
  });

  it('accepts every whitelisted token and separator', () => {
    expect(isValidDateFormat('DD MMM YY')).toBe(true);
    expect(isValidDateFormat('MMMM D, YYYY')).toBe(true);
    expect(isValidDateFormat('D.M.YYYY')).toBe(true);
    expect(isValidDateFormat('M/D/YY')).toBe(true);
    expect(isValidDateFormat('YYYY MM DD')).toBe(true);
  });

  it('accepts repeated separators', () => {
    expect(isValidDateFormat('YYYY - MM - DD')).toBe(true);
    expect(isValidDateFormat('DD  MM  YYYY')).toBe(true);
  });

  it('rejects unknown tokens', () => {
    expect(isValidDateFormat('QQ YYYY')).toBe(false);
    expect(isValidDateFormat('HH:mm')).toBe(false);
    expect(isValidDateFormat('EEEE')).toBe(false);
  });

  it('rejects lowercase tokens', () => {
    expect(isValidDateFormat('dd.mm.yyyy')).toBe(false);
  });

  it('rejects injection payloads and stray punctuation', () => {
    expect(isValidDateFormat('YYYY; DROP')).toBe(false);
    expect(isValidDateFormat('YYYY!')).toBe(false);
  });

  it('rejects empty and oversized strings', () => {
    expect(isValidDateFormat('')).toBe(false);
    expect(isValidDateFormat('YYYY '.repeat(9))).toBe(false);
  });
});
