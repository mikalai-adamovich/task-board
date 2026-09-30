/**
 * Tests for the TaskTableBulkBar sub-component:
 *
 * - Renders the selection count and the three bulk-field selects
 * - Emits field changes (status/assignee/sprint)
 * - Disables Apply while the exactly-one-field contract is violated
 * - Emits `apply` and `clear` from the buttons
 *
 * Zoneless testing pattern (Angular 22): never call `await settle(fixture)` —
 * notify Angular (setInput / events) and `await fixture.whenStable()`. The
 * Transloco lang is preloaded so translated text is available on the first
 * render (see AGENTS.md "Testing notes").
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { TaskTableBulkBar } from './task-table-bulk-bar';

describe('TaskTableBulkBar', () => {
  let fixture: ComponentFixture<TaskTableBulkBar>;
  let component: TaskTableBulkBar;

  async function setup(inputs: Record<string, unknown> = {}) {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: {
            en: {
              'taskTable.bulk.selected': 'Selected: {{count}}',
              'taskTable.bulk.apply': 'Apply',
              'taskTable.bulk.clear': 'Clear',
            },
          },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    // Warm the translation cache synchronously before the first render —
    // the lazy per-pipe load would otherwise render '' on the first pass.

    fixture = TestBed.createComponent(TaskTableBulkBar);
    fixture.componentRef.setInput('selectedCount', 2);

    Object.entries(inputs).forEach(([key, value]) => {
      fixture.componentRef.setInput(key, value);
    });

    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  /** The Apply / Clear buttons — structural selector, independent of translations */
  function actionButtons() {
    return fixture.debugElement.queryAll(By.css('button[hlmBtn]'));
  }

  it('should render the selection count', async () => {
    await setup();

    expect(fixture.nativeElement.textContent).toContain('Selected: 2');
  });

  it('should render the three bulk-field selects', async () => {
    await setup();

    expect(fixture.debugElement.queryAll(By.css('hlm-select')).length).toBe(3);
  });

  it('should emit field changes from the selects', async () => {
    await setup();

    const status: string[] = [];
    const assignee: string[] = [];
    const sprint: string[] = [];

    component.statusChange.subscribe((v) => status.push(v));
    component.assigneeChange.subscribe((v) => assignee.push(v));
    component.sprintChange.subscribe((v) => sprint.push(v));

    const selects = fixture.debugElement.queryAll(By.css('hlm-select'));

    selects[0]?.triggerEventHandler('valueChange', 'st1');
    selects[1]?.triggerEventHandler('valueChange', 'u1');
    selects[2]?.triggerEventHandler('valueChange', 's1');

    expect(status).toEqual(['st1']);
    expect(assignee).toEqual(['u1']);
    expect(sprint).toEqual(['s1']);
  });

  it('should disable Apply when the exactly-one-field contract is violated', async () => {
    await setup({ canApply: false });

    const applyButton = actionButtons()[0];

    expect(applyButton?.nativeElement.disabled).toBe(true);
  });

  it('should disable Apply while a bulk update is in flight', async () => {
    await setup({ canApply: true, applying: true });

    const applyButton = actionButtons()[0];

    expect(applyButton?.nativeElement.disabled).toBe(true);
  });

  it('should enable Apply when exactly one field is chosen and not applying', async () => {
    await setup({ canApply: true, applying: false });

    expect(actionButtons()[0]?.nativeElement.disabled).toBe(false);
  });

  it('should emit apply and clear from the buttons', async () => {
    await setup({ canApply: true });

    let applied = 0;
    let cleared = 0;

    component.apply.subscribe(() => applied++);
    component.clear.subscribe(() => cleared++);

    // Zoneless click race: the (click) listener attachment can be queued as
    // scheduler work that whenStable() does not flush — a native click on a
    // connected button sometimes does not reach the Angular listener. Force a
    // synchronous scheduler flush, then retry the click until the effect is
    // observed (vi.waitFor re-runs the callback on failure).
    await fixture.whenStable();
    TestBed.tick();

    const [applyButton, clearButton] = actionButtons();

    await vi.waitFor(
      () => {
        applyButton?.nativeElement.click();
        expect(applied).toBe(1);
      },
      { timeout: 2000 },
    );

    await vi.waitFor(
      () => {
        clearButton?.nativeElement.click();
        expect(cleared).toBe(1);
      },
      { timeout: 2000 },
    );

    expect(applied).toBe(1);
    expect(cleared).toBe(1);
  });
});
