/**
 * Tests for the unified create-task page.
 *
 * Covers:
 * - Default status preselected (project TODO status) once reference data loads
 * - Successful create navigates to `tasks/:taskNumber` of the created task
 * - Validation error shows inline (title required, marked touched)
 * - Cancel navigates back in history
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, ActivatedRoute } from '@angular/router';
import { Location } from '@angular/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { submit } from '@angular/forms/signals';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { Component, input, output, signal, type WritableSignal } from '@angular/core';
import { TaskCreate } from './create-task';
import { MilkdownEditor } from '@app/shared/milkdown-editor/milkdown-editor';
import { TaskClient } from '@services/task-client';
import { LabelClient } from '@services/label-client';
import { ProjectStore } from '@stores/project-store';
import { ProjectRefStore, type SelectOption } from '@stores/project-ref-store';
import { API_BASE_URL } from '@app/api-url.token';
import { DEFAULT_TASK_PRIORITY_LEVEL, type Task } from '@task-board/shared';
import { clickUntil, settle } from '@app/shared/testing/zoneless';

/** Spartan's `HlmFieldError` is a component carrying `data-slot="field-error"`. */
const ERROR_SELECTOR = '[data-slot="field-error"]';

/** Stub keeps the spec independent of the lazy-loaded Milkdown bundle */
@Component({
  selector: 'ui-milkdown-editor',
  standalone: true,
  /* eslint-disable-next-line @angular-eslint/component-max-inline-declarations */
  template: '',
})
class MilkdownEditorStub {
  readonly content = input('');
  readonly contentChange = output<string>();
}

const NOW = '2025-01-01T00:00:00Z';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tk000000-0000-0000-0000-000000000001',
    projectId: 'p1',
    number: 7,
    typeId: 'type1',
    title: 'Created Task',
    description: null,
    statusId: 'st-todo',
    priorityLevel: 1,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: null,
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'Test User' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const refOptions: Record<string, SelectOption[]> = {
  statuses: [
    { id: 'st-todo', name: 'To Do' },
    { id: 'st-done', name: 'Done' },
  ],
  types: [{ id: 'type-task', name: 'Task' }],
  sprints: [{ id: 'sp1', name: 'Sprint 1' }],
  labels: [{ id: 'lb-bug', name: 'bug' }],
  members: [{ id: 'u2', name: 'Alice' }],
};
/** Active project mock — mutable so specs can vary `defaultStatusId` */
let mockProject: Record<string, string | null>;
/**
 * Reference-data mock backed by a signal so a spec can simulate a background
 * refetch (new options array) and observe how the defaults effect reacts.
 */
let refOptionsState: WritableSignal<Record<string, SelectOption[]>>;

describe('TaskCreate (U1 — unified create-task page)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ReturnType<typeof TestBed.createComponent>;
  let taskClientMock: { create: ReturnType<typeof vi.fn> };
  let labelClientMock: { create: ReturnType<typeof vi.fn> };
  let routerMock: { navigate: ReturnType<typeof vi.fn> };
  let locationBack: ReturnType<typeof vi.fn>;

  async function setup(createOk = true) {
    taskClientMock = {
      create: createOk
        ? vi.fn().mockReturnValue(of(makeTask()))
        : vi.fn().mockReturnValue(throwError(() => new Error('boom'))),
    };
    labelClientMock = { create: vi.fn() };
    routerMock = { navigate: vi.fn().mockResolvedValue(true) };
    locationBack = vi.fn();
    mockProject = { id: 'p1', key: 'ABC', defaultStatusId: 'st-todo' };
    refOptionsState = signal(refOptions);

    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: LabelClient, useValue: labelClientMock },
        {
          provide: ProjectStore,
          useValue: { activeProject: () => mockProject, projectRole: () => 'OWNER' },
        },
        {
          provide: ProjectRefStore,
          useValue: {
            ensure: vi.fn(),
            options: (_pid: string, kind: string) => refOptionsState()[kind] ?? [],
            invalidate: vi.fn(),
          },
        },
        { provide: Router, useValue: routerMock },
        { provide: Location, useValue: { back: locationBack } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: () => 'ABC' } },
            parent: { snapshot: { paramMap: { get: () => 'acme' } }, parent: null },
          },
        },
      ],
    }).overrideComponent(TaskCreate, {
      remove: { imports: [MilkdownEditor] },
      add: { imports: [MilkdownEditorStub] },
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TaskCreate);
    component = fixture.componentInstance;
    await settle(fixture);

    // Wait for the default-preselection effects to run against loaded options
    for (let i = 0; i < 50 && !component.model().statusId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await settle(fixture);
    }
  }

  // V4-5 / R3-P1: preselection is ID-based (project.defaultStatusId), never name-based
  // ── The defaults are applied ONCE and never fight the user ────────────────

  it('should NOT re-apply the defaults after the user clears a field (F21)', async () => {
    await setup();

    expect(component.model().statusId).toBe('st-todo');
    expect(component.model().typeId).toBe('type-task');

    // The user clears both selects.
    component.onFieldChange('statusId', '');
    component.onFieldChange('typeId', '');
    await settle(fixture);

    // …and a background refetch delivers the reference data again, in a
    // different order. The one-shot latch keeps the user's (empty) choice.
    refOptionsState.set({
      ...refOptions,
      statuses: [
        { id: 'st-done', name: 'Done' },
        { id: 'st-todo', name: 'To Do' },
      ],
      types: [{ id: 'type-bug', name: 'Bug' }],
    });
    await settle(fixture);

    expect(component.model().statusId).toBe('');
    expect(component.model().typeId).toBe('');
  });

  it('should NOT overwrite a user-picked status when reference data refetches (F21)', async () => {
    await setup();

    component.onFieldChange('statusId', 'st-done');
    refOptionsState.set({ ...refOptions, statuses: [{ id: 'st-todo', name: 'To Do' }] });
    await settle(fixture);

    expect(component.model().statusId).toBe('st-done');
  });

  it('should preselect project.defaultStatusId and the first type by position', async () => {
    await setup();

    expect(component.model().statusId).toBe('st-todo');
    expect(component.model().typeId).toBe('type-task');
    expect(component.model().priorityLevel).toBe(DEFAULT_TASK_PRIORITY_LEVEL);
  });

  // P13b (Fix 4): pending-changes tracking for the canDeactivate guard
  it('should report pending changes only after the user modifies a field or picks a label', async () => {
    await setup();

    expect(component.hasPendingChanges()).toBe(false);

    // Simulate user typing in the title (marks the Signal Form dirty)
    component.model.update((m: { title: string }) => ({ ...m, title: 'Half-typed task' }));
    await settle(fixture);
    component.createForm().markAsDirty();

    expect(component.hasPendingChanges()).toBe(true);

    // Resetting the form (post-create path) clears the pending state
    component.createForm().reset();
    await settle(fixture);

    expect(component.hasPendingChanges()).toBe(false);

    // Picked labels count as pending too
    component.onLabelPicked({ id: 'lb-bug', name: 'bug' });

    expect(component.hasPendingChanges()).toBe(true);
  });

  it('should honor defaultStatusId even when its name is not "To Do"', async () => {
    refOptions.statuses = [{ id: 'st-ip', name: 'In Progress' }];
    mockProject['defaultStatusId'] = 'st-ip';
    await setup();
    refOptions.statuses = [
      { id: 'st-todo', name: 'To Do' },
      { id: 'st-done', name: 'Done' },
    ];
    mockProject['defaultStatusId'] = 'st-todo';

    expect(component.model().statusId).toBe('st-ip');
  });

  it('should fall back to the first status by position when defaultStatusId is absent from the loaded statuses', async () => {
    refOptions.statuses = [
      { id: 'st-open', name: 'Open' },
      { id: 'st-done', name: 'Done' },
    ];
    mockProject['defaultStatusId'] = 'st-gone';
    await setup();
    refOptions.statuses = [
      { id: 'st-todo', name: 'To Do' },
      { id: 'st-done', name: 'Done' },
    ];
    mockProject['defaultStatusId'] = 'st-todo';

    expect(component.model().statusId).toBe('st-open');
  });

  it('should navigate to tasks/:taskNumber after successful creation', async () => {
    await setup();

    component.model.update((m: Record<string, unknown>) => ({ ...m, title: 'Created Task' }));
    submit(component.createForm);
    await fixture.whenStable();

    expect(taskClientMock.create).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ title: 'Created Task', statusId: 'st-todo', typeId: 'type-task' }),
    );
    // The ActivatedRoute mock resolves every param to 'ABC' — including tenantSlug
    expect(routerMock.navigate).toHaveBeenCalledWith(['/w', 'ABC', 'projects', 'ABC', 'tasks', 'ABC-7']);
  });

  it('should show an inline validation error for an empty title without calling the API', async () => {
    await setup();

    submit(component.createForm);
    await settle(fixture);

    expect(component.createForm.title().touched()).toBe(true);
    expect(component.createForm.title().invalid()).toBe(true);
    expect(taskClientMock.create).not.toHaveBeenCalled();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');

    expect(alert).toBeTruthy();
  });

  // ── Field error rendering + a11y wiring ───────────────────────────────────
  //
  // Regression cover: the runtime pass found zero visible
  // validation errors and `aria-describedby: []`. Two independent defects caused
  // it and both are asserted here:
  //   1. the submit button was `[disabled]` while the form was invalid, so an
  //      empty submit could never run `submit()` and never mark fields touched;
  //   2. no control carried `brnFieldControl`, so Spartan's `HlmFieldError` had
  //      no control state to gate on.
  describe('field error display', () => {
    function titleInput(): HTMLInputElement {
      return fixture.nativeElement.querySelector('input#create-title') as HTMLInputElement;
    }

    function submitButton(): HTMLButtonElement {
      return fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    }

    /** Error hosts that Spartan is actually showing (no `hidden` attribute). */
    function visibleErrors(): HTMLElement[] {
      const nodes: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll(ERROR_SELECTOR));

      return nodes.filter((el) => !el.hasAttribute('hidden'));
    }

    it('exposes a reachable, enabled submit button', async () => {
      await setup();

      const button = submitButton();

      expect(button).toBeTruthy();
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    it('renders the error text in the DOM after an empty submit', async () => {
      await setup();

      await clickUntil(
        () => submitButton().click(),
        () => expect(visibleErrors().length).toBe(1),
      );
      await settle(fixture);

      const text = visibleErrors().at(0)?.textContent?.trim();

      expect(text).toBeTruthy();
      expect(taskClientMock.create).not.toHaveBeenCalled();
    });

    it('marks the title control aria-invalid after an empty submit', async () => {
      await setup();

      await clickUntil(
        () => submitButton().click(),
        () => expect(titleInput().getAttribute('aria-invalid')).toBe('true'),
      );
      await settle(fixture);

      expect(titleInput().getAttribute('aria-invalid')).toBe('true');
    });

    it('associates the title control with its error via aria-describedby', async () => {
      await setup();

      await clickUntil(
        () => submitButton().click(),
        () => expect(titleInput().getAttribute('aria-describedby')).toBeTruthy(),
      );
      await settle(fixture);

      const describedBy = titleInput().getAttribute('aria-describedby') as string;
      const error = fixture.nativeElement.querySelector(`#${CSS.escape(describedBy)}`) as HTMLElement;

      expect(error).toBeTruthy();
      expect(error.matches(ERROR_SELECTOR)).toBe(true);
      expect(error.hasAttribute('hidden')).toBe(false);
    });

    it('shows no error once the title is valid', async () => {
      await setup();

      component.model.update((m: Record<string, unknown>) => ({ ...m, title: 'Created Task' }));
      await settle(fixture);

      await clickUntil(
        () => submitButton().click(),
        () => expect(titleInput().getAttribute('aria-invalid')).toBeNull(),
      );
      await settle(fixture);

      expect(visibleErrors()).toHaveLength(0);
      expect(titleInput().getAttribute('aria-invalid')).toBeNull();
    });

    // ── The three required `<hlm-select>`s are real form controls ────────────
    //
    // One row per field the schema marks required, so a fourth required select
    // is a new row rather than a silently-uncovered control, and a differently
    // written fix (a native select, a different element) still passes as long as
    // the control is bound.
    //
    // The binding proof is `data-touched`: Spartan's `BrnSelectTrigger` publishes
    // `data-touched` from the control state it gets from the enclosing
    // `<hlm-select>`'s `BrnFieldControl`, which only exists once `[formField]`
    // has wired the control to the form. Before this change the attribute was absent —
    // the select was not a form control at all.
    const REQUIRED_SELECTS: { field: string; triggerId: string; empty?: () => void }[] = [
      { field: 'statusId', triggerId: 'create-status', empty: () => component.onFieldChange('statusId', '') },
      { field: 'typeId', triggerId: 'create-type', empty: () => component.onFieldChange('typeId', '') },
      // The priority select is seeded with the project default and is never
      // empty in practice, so its row asserts the binding only.
      { field: 'priorityLevel', triggerId: 'create-priority' },
    ];

    /**
     * The control a user actually focuses: `buttonId` puts the id on the
     * `<button brnSelectTrigger>` inside `<hlm-select-trigger>`, so this is the
     * combobox, not the wrapper element.
     */
    function trigger(id: string): HTMLElement {
      const el = fixture.nativeElement.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;

      expect(el?.tagName).toBe('BUTTON');

      return el as HTMLElement;
    }

    for (const row of REQUIRED_SELECTS) {
      it(`binds the ${row.field} select into the form`, async () => {
        await setup();

        expect(trigger(row.triggerId).getAttribute('data-touched')).toBeNull();

        await clickUntil(
          () => submitButton().click(),
          () => expect(trigger(row.triggerId).getAttribute('data-touched')).toBe('true'),
        );
        await settle(fixture);

        expect(trigger(row.triggerId).getAttribute('data-touched')).toBe('true');
      });
    }

    for (const row of REQUIRED_SELECTS.filter((r) => r.empty)) {
      it(`renders and announces the ${row.field} error when the field is omitted`, async () => {
        await setup();
        row.empty?.();
        await settle(fixture);

        await clickUntil(
          () => submitButton().click(),
          () => expect(trigger(row.triggerId).getAttribute('aria-invalid')).toBe('true'),
        );
        await settle(fixture);

        expect(component.createForm[row.field]().touched()).toBe(true);
        expect(trigger(row.triggerId).getAttribute('aria-invalid')).toBe('true');

        const describedBy = trigger(row.triggerId).getAttribute('aria-describedby') as string;

        expect(describedBy).toBeTruthy();

        const error = fixture.nativeElement.querySelector(`#${CSS.escape(describedBy.split(' ')[0] as string)}`);

        expect(error).toBeTruthy();
        expect((error as HTMLElement).matches(ERROR_SELECTOR)).toBe(true);
        expect((error as HTMLElement).hasAttribute('hidden')).toBe(false);
        expect((error as HTMLElement).textContent?.trim()).toBeTruthy();
        expect(taskClientMock.create).not.toHaveBeenCalled();
      });
    }
  });

  it('should surface a server error inline instead of navigating', async () => {
    await setup(false);

    component.model.update((m: Record<string, unknown>) => ({ ...m, title: 'Created Task' }));
    submit(component.createForm);
    await new Promise((r) => setTimeout(r, 20));
    await settle(fixture);

    expect(component.error()).not.toBe('');
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('should resolve labels case-insensitively before creating new ones (BR-019)', async () => {
    await setup();

    component.onLabelPicked({ id: '', name: 'BUG' });
    component.model.update((m: Record<string, unknown>) => ({ ...m, title: 'Created Task' }));
    submit(component.createForm);
    await new Promise((r) => setTimeout(r, 10));

    expect(labelClientMock.create).not.toHaveBeenCalled();
    expect(taskClientMock.create).toHaveBeenCalledWith('p1', expect.objectContaining({ labelIds: ['lb-bug'] }));
  });

  it('should cancel via history back', async () => {
    await setup();

    component.cancel();

    expect(locationBack).toHaveBeenCalled();
  });
});
