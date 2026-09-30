/**
 * Shared Auto page-size math — used by the tasks table, the audit
 * log viewer and the member tables so all data tables share one implementation.
 */

/** Sentinel persisted in `PreferencesStore.pageSize` meaning "Auto" (measured-height derived). */
export const AUTO_PAGE_SIZE_SENTINEL = 0;
/** Fixed fallback row height — the basis of Auto math and spacer rows until/unless real rows are measured. */
export const TABLE_ROW_HEIGHT_PX = 48;
/** Fallback row height in compact density (reduced vertical cell padding). */
export const TABLE_ROW_HEIGHT_COMPACT_PX = 32;

/**
 * Density-aware fallback row height for the Auto page-size math and
 * spacer rows — compact tables fit more rows per available pixel, so passing the
 * smaller constant makes Auto mode react to a density toggle automatically.
 */
export function rowHeightForDensity(compact: boolean): number {
  return compact ? TABLE_ROW_HEIGHT_COMPACT_PX : TABLE_ROW_HEIGHT_PX;
}
/** Auto page-size clamp bounds. */
export const AUTO_MIN_ROWS = 3;
export const AUTO_MAX_ROWS = 100;

/**
 * Rows that fit the available table-body height: floor(availableHeight / rowHeightPx)
 * clamped to [AUTO_MIN_ROWS..AUTO_MAX_ROWS]. `availableHeight` is MEASURED from the
 * table wrapper via a ResizeObserver (see {@link useAutoRowMeasurement}) — no
 * window/chrome constants. `rowHeightPx` must be the row PITCH (bounding rect +
 * the 1px shared border — {@link useAutoRowMeasurement} adds it); passing a bare
 * rect height underfills slightly, which is safe but leaves a gap.
 */
export function computeAutoPageSize(availableHeight: number, rowHeightPx: number = TABLE_ROW_HEIGHT_PX): number {
  return Math.min(AUTO_MAX_ROWS, Math.max(AUTO_MIN_ROWS, Math.floor(availableHeight / rowHeightPx)));
}
