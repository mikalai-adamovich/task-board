import { signal } from '@angular/core';

/**
 * Table density preference.
 *
 * Device-local setting (localStorage key `task-board.table-density`) — deliberately
 * NOT part of the server-persisted `PreferencesStore`, which has no generic
 * local-only mechanism; density is a per-device rendering choice like the theme
 * bootstrap (`taskboard_theme`).
 *
 * Compact mode reduces vertical cell padding via the `.table-density-compact`
 * class on the `<table>` element (see `styles.css`). The Auto page-size math
 * reacts through {@link rowHeightForDensity} — components pass the density-aware
 * row height into `computeAutoPageSize` and their spacer-row computation.
 */

export type TableDensity = 'comfortable' | 'compact';

export const TABLE_DENSITY_STORAGE_KEY = 'task-board.table-density';

/** Read the persisted density; anything unknown falls back to comfortable. */
export function readTableDensity(storage: Pick<Storage, 'getItem'> = localStorage): TableDensity {
  return storage.getItem(TABLE_DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
}

/** Persist the density choice. */
export function writeTableDensity(density: TableDensity, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(TABLE_DENSITY_STORAGE_KEY, density);
}

/**
 * Injection-context composable returning the reactive compact flag plus a
 * toggle that persists each change. Shared by the tasks table, the audit log
 * viewer and the member tables.
 */
export function useTableDensity(): { compact: ReturnType<typeof signal<boolean>>; toggle: () => void } {
  const compact = signal(readTableDensity() === 'compact');

  function toggle(): void {
    compact.update((value) => !value);
    writeTableDensity(compact() ? 'compact' : 'comfortable');
  }

  return { compact, toggle };
}
