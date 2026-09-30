/**
 * Tests for the TaskTableColumns sub-component:
 *
 * - Renders one checkbox row per column; pinned columns are disabled
 * - Emits `toggleColumn` / `toggleAll` from the chooser checkboxes
 * - Context-menu hide flow: canHideContextColumn + hideColumn output
 * - Chooser instances are mutually exclusive (toolbar vs cursor-anchored)
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { TaskTableColumns } from './task-table-columns';
import type { TaskColumnDef } from '../task-column-def';

const COLUMNS: TaskColumnDef[] = [
  { field: 'number', columnKey: 'key', labelKey: 'taskTable.key', filterType: 'none', getFilterValue: () => '' },
  { field: 'title', columnKey: 'title', labelKey: 'taskTable.titleCol', filterType: 'none', getFilterValue: () => '' },
  { field: 'typeId', columnKey: 'type', labelKey: 'taskTable.type', filterType: 'none', getFilterValue: () => '' },
];

describe('TaskTableColumns', () => {
  let fixture: ComponentFixture<TaskTableColumns>;
  let component: TaskTableColumns;

  async function setup(visible: string[] = ['key', 'title', 'type']) {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { en: {} },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TaskTableColumns);
    fixture.componentRef.setInput('taskColumns', COLUMNS);
    fixture.componentRef.setInput('visibleKeys', new Set(visible));
    fixture.componentRef.setInput('allColumnsSelected', visible.length === COLUMNS.length);
    fixture.componentRef.setInput('someColumnsSelected', visible.length > 0 && visible.length < COLUMNS.length);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  it('should render one checkbox row per column with pinned rows disabled', async () => {
    await setup();
    // The chooser rows live inside the popover portal — rendered only when open
    component.showColumnChooser.set(true);
    await settle(fixture);

    const checkboxes = fixture.debugElement.queryAll(By.css('hlm-checkbox'));

    expect(checkboxes.length).toBe(COLUMNS.length + 1); // + select-all row
  });

  it('should emit toggleColumn with the column key and visibility', async () => {
    await setup(['key', 'title']);
    component.showColumnChooser.set(true);
    await settle(fixture);

    const emitted: { columnKey: string; visible: boolean }[] = [];

    component.toggleColumn.subscribe((v) => emitted.push(v));

    // The type column's checkbox (last column row) — currently hidden → toggling shows it
    const rows = fixture.debugElement.queryAll(By.css('hlm-checkbox'));
    const typeCheckbox = rows[rows.length - 1];

    typeCheckbox?.triggerEventHandler('checkedChange', true);

    expect(emitted).toEqual([{ columnKey: 'type', visible: true }]);
  });

  it('should emit toggleAll from the select-all checkbox', async () => {
    await setup();
    component.showColumnChooser.set(true);
    await settle(fixture);

    const emitted: boolean[] = [];

    component.toggleAll.subscribe((v) => emitted.push(v));

    const selectAll = fixture.debugElement.query(By.css('hlm-checkbox'));

    selectAll.triggerEventHandler('checkedChange', false);

    expect(emitted).toEqual([false]);
  });

  it('should refuse to hide pinned columns via the context menu', async () => {
    await setup();

    component.contextColumn.set(COLUMNS[0] ?? null); // key — pinned

    expect(component.canHideContextColumn()).toBe(false);
  });

  it('should emit hideColumn for a visible non-pinned context column', async () => {
    await setup();

    const emitted: string[] = [];

    component.hideColumn.subscribe((key) => emitted.push(key));

    component.contextColumn.set(COLUMNS[2] ?? null); // type — visible, not pinned

    expect(component.canHideContextColumn()).toBe(true);

    component.hideContextColumn();

    expect(emitted).toEqual(['type']);
  });

  it('should keep chooser instances mutually exclusive', async () => {
    await setup();

    component.showColumnChooser.set(true);
    component.onContextChooserStateChange('open');

    expect(component.showContextColumnChooser()).toBe(true);
    expect(component.showColumnChooser()).toBe(false);

    component.onChooserStateChange('open');

    expect(component.showColumnChooser()).toBe(true);
    expect(component.showContextColumnChooser()).toBe(false);

    component.closeColumnChooser();

    expect(component.showColumnChooser()).toBe(false);
    expect(component.showContextColumnChooser()).toBe(false);
  });

  /**
   * Regression (keyboard nav): the header context menu is opened
   * programmatically (right-click). Its first item must be focused through
   * CDK's FocusKeyManager (`openFocused()` → `focusFirstItem()`), NOT via a
   * raw DOM `.focus()` — the latter leaves the key-manager's active index at
   * -1, so the first ArrowDown re-activated item 0 (no visible move) and
   * ArrowUp wrapped to the last item.
   */
  it('syncs keyboard nav after programmatic open: one ArrowDown moves focus to the second item', async () => {
    await setup();

    component.onHeaderContextMenu(
      new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }),
      COLUMNS[2] as TaskColumnDef, // type — visible, not pinned → 2 enabled items
    );

    const menuItems = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dropdown-menu-item"]'));

    // Wait for openFocused()'s poll to focus the FIRST item
    await waitFor(() => document.activeElement === menuItems()[0]);

    // One ArrowDown must move focus to the SECOND item (key-manager index 0 → 1)
    const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });

    Object.defineProperty(arrowDown, 'keyCode', { get: () => 40 }); // CDK reads event.keyCode
    document.activeElement?.dispatchEvent(arrowDown);

    await waitFor(() => document.activeElement === menuItems()[1]);

    expect(document.activeElement).toBe(menuItems()[1]);
  });
});

/** Poll until `predicate` is true (repo pattern: no fixed timeouts for async UI) */
async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
