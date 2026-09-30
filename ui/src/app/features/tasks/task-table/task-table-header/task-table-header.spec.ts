/**
 * Tests for the TaskTableHeader sub-component:
 *
 * - Renders the search input with the buffered value + shortcut target attribute
 * - Emits the raw input event on keystrokes (parent owns the debounce)
 * - Emits openFilters / toggleDensity / createTask from the toolbar buttons
 * - Hides the New Task control for users who cannot write
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { clickUntil, settle } from '@app/shared/testing/zoneless';
import { TaskTableHeader } from './task-table-header';

describe('TaskTableHeader', () => {
  let fixture: ComponentFixture<TaskTableHeader>;
  let component: TaskTableHeader;

  async function setup(inputs: Record<string, unknown> = {}) {
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

    fixture = TestBed.createComponent(TaskTableHeader);

    Object.entries(inputs).forEach(([key, value]) => {
      fixture.componentRef.setInput(key, value);
    });

    component = fixture.componentInstance;
    await settle(fixture);
  }

  it('should render the search input with the buffered value and shortcut target', async () => {
    await setup({ searchValue: 'hello' });

    const input = fixture.debugElement.query(By.css('input[data-task-table-search]'));

    expect(input).toBeTruthy();
    expect(input.nativeElement.value).toBe('hello');
  });

  it('should emit the raw input event on keystrokes', async () => {
    await setup();

    const emitted: Event[] = [];

    component.searchInput.subscribe((e) => emitted.push(e));

    const input = fixture.debugElement.query(By.css('input[data-task-table-search]'));

    input.triggerEventHandler('input', { target: { value: 'foo' } });

    expect(emitted.length).toBe(1);
  });

  it('should emit openFilters and toggleDensity from the toolbar buttons', async () => {
    await setup();

    let filters = 0;
    let density = 0;

    component.openFilters.subscribe(() => filters++);
    component.toggleDensity.subscribe(() => density++);

    const buttons = fixture.debugElement.queryAll(By.css('button'));

    await clickUntil(
      () => buttons[0]?.nativeElement.click(),
      () => expect(filters).toBe(1),
    );
    await clickUntil(
      () => buttons[1]?.nativeElement.click(),
      () => expect(density).toBe(1),
    );
  });

  it('should hide the New Task control for users who cannot write', async () => {
    await setup({ canCreateTasks: false });

    expect(fixture.debugElement.queryAll(By.css('button')).length).toBe(2);
  });

  it('should emit createTask from the New Task button', async () => {
    await setup({ canCreateTasks: true });

    let created = 0;

    component.createTask.subscribe(() => created++);

    const buttons = fixture.debugElement.queryAll(By.css('button'));

    expect(buttons.length).toBe(3);

    await clickUntil(
      () => buttons[2]?.nativeElement.click(),
      () => expect(created).toBe(1),
    );
  });
});
