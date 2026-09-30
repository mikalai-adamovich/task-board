import { DestroyRef, inject, signal } from '@angular/core';

/**
 * Measured row heights below this threshold are treated as pathological
 * (collapsed/hidden rows mid-render) and ignored — consumers fall back to the
 * density-aware constant instead of blowing up the Auto page-size count.
 */
export const MIN_MEASURED_ROW_HEIGHT_PX = 24;

/**
 * Visual pitch bonus per row: data rows carry a `border-b` whose 1px is NOT
 * included in a row's bounding rect (shared border under
 * `border-collapse: collapse`), but IS part of the space each row occupies.
 */
const ROW_BORDER_PX = 1;

/**
 * Shared ResizeObserver measurement for Auto page-size.
 *
 * Observes a table-wrapper element and exposes the height available for table
 * ROWS (wrapper height minus the optional header element) plus the row height.
 * The row height comes from a dedicated probe row (`data-row-probe` — an
 * invisible, out-of-flow row with the same cell structure as a data row) when
 * the template provides one; otherwise it is the median of the real body rows.
 * Consumers derive their page size from these via `computeAutoPageSize` —
 * passing the measured row height (when available) instead of the fixed
 * fallback constant prevents undercounting when real rows are shorter than
 * `TABLE_ROW_HEIGHT_PX`. Must be called within an injection context; the
 * observer is disconnected on destroy.
 *
 * ```ts
 * const measurement = useAutoRowMeasurement();
 * effect(() => measurement.observe(this.tableWrapRef()?.nativeElement, 'thead'));
 * ```
 */
export function useAutoRowMeasurement(): {
  availableRowsHeight: ReturnType<typeof signal<number>>;
  measuredRowHeight: ReturnType<typeof signal<number>>;
  observe: (el: HTMLElement | null | undefined, headerSelector?: string) => void;
} {
  const destroyRef = inject(DestroyRef);
  const availableRowsHeight = signal(0);
  /** Authoritative row height (0 = no valid measurement yet). */
  const measuredRowHeight = signal(0);
  let observer: ResizeObserver | null = null;
  let observedRow: Element | null = null;
  let observedProbe: Element | null = null;

  function observe(el: HTMLElement | null | undefined, headerSelector?: string): void {
    if (!el || typeof ResizeObserver === 'undefined') return;

    observer?.disconnect();
    observedRow = null;
    observedProbe = null;

    const wrapper = el;

    /** Core measurement. */
    function measureNow(entry?: ResizeObserverEntry): void {
      // Prefer the observed contentRect — but only when it belongs to the wrapper;
      // row-element ticks carry the ROW's rect, which must not be read as the
      // wrapper height.
      const wrapperHeight = Math.round(
        entry && (!entry.target || entry.target === wrapper)
          ? entry.contentRect.height
          : wrapper.getBoundingClientRect().height,
      );
      const head = headerSelector ? wrapper.querySelector(headerSelector) : null;
      const headHeight = head ? Math.round(head.getBoundingClientRect().height) : 0;

      availableRowsHeight.set(Math.max(0, wrapperHeight - headHeight));

      // The dedicated probe rows (`data-row-probe` — invisible, out-of-flow rows
      // with the same cell structure as a data row) take precedence: they are
      // measurable before any data renders and are immune to the transient
      // layout of freshly rendered rows. A pathological probe (0/unrendered)
      // falls through to the real data rows.
      const probeRows = Array.from(wrapper.querySelectorAll<HTMLElement>('tbody tr[data-row-probe]'));
      const probeHeights = probeRows
        .map((row) => Math.round(row.getBoundingClientRect().height))
        .filter((height) => height >= MIN_MEASURED_ROW_HEIGHT_PX);
      // Real body rows (up to the first 25). Spacer rows (aria-hidden) and
      // empty/loading-state message rows (`data-table-empty-row` — much taller
      // than a data row) are excluded: measuring them would shrink the computed
      // Auto page size. A single row can be unrepresentative (wrapped title,
      // first-paint font fallback) — the median is robust to that, a first-row
      // measurement is not. Heights below the sanity threshold are ignored.
      const dataRows = Array.from(
        wrapper.querySelectorAll<HTMLElement>(
          'tbody tr:not([aria-hidden="true"]):not([data-table-empty-row]):not([data-row-probe])',
        ),
      ).slice(0, 25);
      const heights = (
        probeHeights.length > 0 ? probeHeights : dataRows.map((row) => Math.round(row.getBoundingClientRect().height))
      )
        .filter((height) => height >= MIN_MEASURED_ROW_HEIGHT_PX)
        .sort((a, b) => a - b);

      // +1px per row: data rows carry a `border-b` whose visual pitch is NOT
      // included in a row's bounding rect (shared border under
      // `border-collapse: collapse`) — without the compensation the last row
      // overflows the wrapper and a scrollbar appears.
      measuredRowHeight.set(heights.length > 0 ? medianHeight(heights) + ROW_BORDER_PX : 0);

      // Track the elements so a re-render or resize re-triggers a measurement
      // even when the wrapper itself does not change size (`observe()` always
      // delivers an initial callback per spec).
      const probe = probeRows[0] ?? null;

      if (probe !== observedProbe) {
        if (observedProbe) observer?.unobserve(observedProbe);

        observedProbe = probe;

        if (probe) observer?.observe(probe);
      }

      const row = dataRows[0] ?? null;

      if (row !== observedRow) {
        if (observedRow) observer?.unobserve(observedRow);

        observedRow = row;

        if (row) observer?.observe(row);
      }
    }

    measureNow(); // synchronous first measurement — avoids an initial min-rows fetch

    observer = new ResizeObserver((entries) => measureNow(entries[0]));
    observer.observe(el);

    // The first pass ran before this observer existed — attach the tracked
    // elements now: the first data row (re-renders on every fetch) and the
    // probe row (resizes on font/theme/density changes).
    if (observedRow) observer.observe(observedRow);
    if (observedProbe) observer.observe(observedProbe);
  }

  /** Median of the sorted row heights (0 for an empty list; evens average the middle pair). */
  function medianHeight(sortedHeights: number[]): number {
    if (sortedHeights.length === 0) return 0;

    const mid = Math.floor(sortedHeights.length / 2);
    const midHeight = sortedHeights[mid] ?? 0;
    const prevHeight = sortedHeights[mid - 1] ?? 0;

    return sortedHeights.length % 2 === 1 ? midHeight : Math.round((prevHeight + midHeight) / 2);
  }

  destroyRef.onDestroy(() => observer?.disconnect());

  return { availableRowsHeight, measuredRowHeight, observe };
}
