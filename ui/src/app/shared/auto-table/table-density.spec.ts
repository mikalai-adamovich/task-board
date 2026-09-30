/**
 * Tests for the Q9 table-density preference helpers.
 *
 * Covers:
 * - read/write roundtrip against a storage stub (default = comfortable)
 * - `useTableDensity()` initial value from localStorage + toggle persistence
 * - density-aware Auto row-height fallback (`rowHeightForDensity`)
 */
import { describe, expect, it, vi } from 'vitest';
import { TABLE_DENSITY_STORAGE_KEY, readTableDensity, useTableDensity, writeTableDensity } from './table-density';
import { TABLE_ROW_HEIGHT_COMPACT_PX, TABLE_ROW_HEIGHT_PX, rowHeightForDensity } from './auto-page-size';

/** Minimal in-memory Storage stub. */
function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>(Object.entries(initial));

  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe('table-density', () => {
  describe('readTableDensity / writeTableDensity', () => {
    it('should default to comfortable when nothing is persisted', () => {
      expect(readTableDensity(memoryStorage())).toBe('comfortable');
    });

    it('should fall back to comfortable for unknown stored values', () => {
      expect(readTableDensity(memoryStorage({ [TABLE_DENSITY_STORAGE_KEY]: 'cozy' }))).toBe('comfortable');
    });

    it('should roundtrip the compact preference', () => {
      const storage = memoryStorage();

      writeTableDensity('compact', storage);

      expect(storage.getItem(TABLE_DENSITY_STORAGE_KEY)).toBe('compact');
      expect(readTableDensity(storage)).toBe('compact');

      writeTableDensity('comfortable', storage);

      expect(readTableDensity(storage)).toBe('comfortable');
    });
  });

  describe('useTableDensity', () => {
    it('should initialize from localStorage and persist each toggle', () => {
      const setItem = vi.fn();
      const storage = { getItem: () => 'compact', setItem };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.stubGlobal('localStorage', storage as any);

      try {
        const density = useTableDensity();

        expect(density.compact()).toBe(true);

        density.toggle();

        expect(density.compact()).toBe(false);
        expect(setItem).toHaveBeenCalledWith(TABLE_DENSITY_STORAGE_KEY, 'comfortable');

        density.toggle();

        expect(density.compact()).toBe(true);
        expect(setItem).toHaveBeenLastCalledWith(TABLE_DENSITY_STORAGE_KEY, 'compact');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('rowHeightForDensity', () => {
    it('should return the compact constant in compact mode and the default otherwise', () => {
      expect(rowHeightForDensity(true)).toBe(TABLE_ROW_HEIGHT_COMPACT_PX);
      expect(rowHeightForDensity(false)).toBe(TABLE_ROW_HEIGHT_PX);
    });

    it('should keep the compact fallback smaller so Auto mode fits more rows', () => {
      expect(TABLE_ROW_HEIGHT_COMPACT_PX).toBeLessThan(TABLE_ROW_HEIGHT_PX);
    });
  });
});
