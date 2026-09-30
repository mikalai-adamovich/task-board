/**
 * Tests for the shared Auto page-size measurement hook.
 *
 * Covers:
 * - availableRowsHeight = wrapper height − header height
 * - measuredRowHeight from the first REAL body row (`tbody tr:not([aria-hidden="true"])`)
 * - pathological (< 24px) row heights are ignored → signal stays 0
 * - re-measurement on ResizeObserver ticks (wrapper AND row-element ticks)
 * - a row-element tick must not be misread as the wrapper height
 */
import { TestBed } from '@angular/core/testing';
import { MIN_MEASURED_ROW_HEIGHT_PX, useAutoRowMeasurement } from './use-auto-row-measurement';

/** Minimal ResizeObserver stub — jsdom has none (same pattern as task-table.spec.ts). */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  readonly disconnect = vi.fn();
  private readonly cb: ResizeObserverCallback;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(target: Element): void {
    this.unobserved.push(target);
  }

  trigger(entry: { target?: Element; height: number }): void {
    this.cb(
      [
        {
          contentRect: { height: entry.height },
          target: entry.target ?? this.observed[0],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

describe('useAutoRowMeasurement', () => {
  let wrapper: HTMLElement;
  let thead: HTMLElement;
  let tbody: HTMLElement;
  let row: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let measurement: any;

  function rectHeight(el: Element, height: number): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
  }

  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    TestBed.configureTestingModule({});

    wrapper = document.createElement('div');
    thead = document.createElement('thead');
    tbody = document.createElement('tbody');
    row = document.createElement('tr');

    tbody.appendChild(row);
    wrapper.append(thead, tbody);
    document.body.appendChild(wrapper);

    rectHeight(wrapper, 800);
    rectHeight(thead, 56);
    rectHeight(row, 44);
  });

  afterEach(() => {
    wrapper.remove();
    vi.unstubAllGlobals();
  });

  function init(): void {
    TestBed.runInInjectionContext(() => {
      measurement = useAutoRowMeasurement();
    });
    measurement.observe(wrapper, 'thead');
  }

  it('should measure available rows height and the real first body row', () => {
    init();

    expect(measurement.availableRowsHeight()).toBe(744); // 800 − 56
    expect(measurement.measuredRowHeight()).toBe(45); // 44px rect + 1px border pitch
  });

  it('should report 0 when no real body row exists', () => {
    row.remove();
    init();

    expect(measurement.availableRowsHeight()).toBe(744);
    expect(measurement.measuredRowHeight()).toBe(0);
  });

  it('should ignore aria-hidden rows (spacer/empty-state rows)', () => {
    row.setAttribute('aria-hidden', 'true');
    init();

    expect(measurement.measuredRowHeight()).toBe(0);
  });

  it(`should ignore pathological row heights below ${MIN_MEASURED_ROW_HEIGHT_PX}px`, () => {
    rectHeight(row, MIN_MEASURED_ROW_HEIGHT_PX - 1);
    init();

    expect(measurement.measuredRowHeight()).toBe(0);
  });

  it('should use the MEDIAN of multiple body rows (an unrepresentative first row must not skew the count)', () => {
    rectHeight(row, 60); // e.g. wrapped title on the first row

    const row2 = document.createElement('tr');
    const row3 = document.createElement('tr');

    rectHeight(row2, 44);
    rectHeight(row3, 44);
    tbody.append(row2, row3);
    init();

    expect(measurement.measuredRowHeight()).toBe(45); // median 44 + 1px border pitch
  });

  it('should prefer the data-row probe height when a probe row is present', () => {
    const probeTable = document.createElement('table');
    const probeBody = document.createElement('tbody');
    const probe = document.createElement('tr');

    probe.setAttribute('data-row-probe', '');
    rectHeight(probe, 41);
    probeBody.appendChild(probe);
    probeTable.appendChild(probeBody);
    wrapper.appendChild(probeTable);
    init();

    // The probe (41 + 1px border pitch) wins over the data-row median (44 + 1)
    expect(measurement.measuredRowHeight()).toBe(42);
  });

  it('should ignore a probe row below the sanity threshold and fall back to the median', () => {
    const probeTable = document.createElement('table');
    const probeBody = document.createElement('tbody');
    const probe = document.createElement('tr');

    probe.setAttribute('data-row-probe', '');
    rectHeight(probe, MIN_MEASURED_ROW_HEIGHT_PX - 1);
    probeBody.appendChild(probe);
    probeTable.appendChild(probeBody);
    wrapper.appendChild(probeTable);
    init();

    expect(measurement.measuredRowHeight()).toBe(45); // data-row median 44 + 1px border pitch
  });

  it('should re-measure on a wrapper tick', () => {
    init();

    const ro = MockResizeObserver.instances[0];

    rectHeight(wrapper, 900);
    rectHeight(row, 40);
    ro?.trigger({ height: 900 });

    expect(measurement.availableRowsHeight()).toBe(844); // 900 − 56
    expect(measurement.measuredRowHeight()).toBe(41); // 40px rect + 1px border pitch
  });

  it('should not misread a row-element tick as the wrapper height', () => {
    init();

    const ro = MockResizeObserver.instances[0];

    // The observer also tracks the row element; its tick carries the ROW's rect
    expect(ro?.observed).toContain(row);

    ro?.trigger({ target: row, height: 44 });

    // Wrapper height is re-read directly — unchanged at 800
    expect(measurement.availableRowsHeight()).toBe(744);
    expect(measurement.measuredRowHeight()).toBe(45); // 44px rect + 1px border pitch
  });
});
