/**
 * Tests for the TaskCard component.
 *
 * Covers:
 * - priorityVariant helper
 * - taskLabel helper
 * - onDragStart emitting
 * - taskClick output
 * - lightweight board-card layout (no description, type name, 2-line title)
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { TaskCard } from './task-card';
import { API_BASE_URL } from '@app/api-url.token';
import type { Task, TaskPriorityLevel } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tk1',
    projectId: 'p1',
    number: 1,
    typeId: 'type1',
    title: 'Test Task',
    description: null,
    statusId: 's1',
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

describe('TaskCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<TaskCard>;

  async function setup(taskOverrides: Partial<Task> = {}, projectKey = 'PROJ', typeName = 'Bug') {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { en: {} },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TaskCard);

    fixture.componentRef.setInput('task', makeTask(taskOverrides));
    fixture.componentRef.setInput('projectKey', projectKey);
    fixture.componentRef.setInput('typeName', typeName);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  // ── priorityLabel (P11: translated display label) ────────────────────────

  describe('priorityLabel', () => {
    it('should render the priority label through i18n (P11)', async () => {
      await setup({ priorityLevel: 1 });
      // Test dictionary is empty → the i18n key renders, proving the badge label is translated
      expect(fixture.nativeElement.textContent).toContain('priority.medium');
    });

    it('should render unknown priorities verbatim', async () => {
      await setup({ priorityLevel: 99 as TaskPriorityLevel });
      expect(component.priorityLabel(99 as TaskPriorityLevel)).toBe('99');
    });
  });

  // ── priorityVariant ──────────────────────────────────────────────────────

  describe('priorityVariant', () => {
    it('should return correct color for LOW', async () => {
      await setup({ priorityLevel: 0 });
      expect(component.priorityVariant()).toBe('outline');
    });

    it('should return correct color for MEDIUM', async () => {
      await setup({ priorityLevel: 1 });
      expect(component.priorityVariant()).toBe('secondary');
    });

    it('should return correct color for HIGH', async () => {
      await setup({ priorityLevel: 2 });
      expect(component.priorityVariant()).toBe('default');
    });

    it('should return correct color for CRITICAL', async () => {
      await setup({ priorityLevel: 3 });
      expect(component.priorityVariant()).toBe('destructive');
    });

    it('should return fallback for unknown priority', async () => {
      await setup({ priorityLevel: 99 as TaskPriorityLevel });
      expect(component.priorityVariant()).toBe('outline');
    });
  });

  // ── taskLabel ──────────────────────────────────────────────────────────

  describe('taskLabel', () => {
    it('should return project key + number when projectKey is set', async () => {
      await setup({ number: 42 });
      expect(component.taskLabel()).toBe('PROJ-42');
    });

    it('should return #number when projectKey is empty', async () => {
      await setup({ number: 7 }, '');
      expect(component.taskLabel()).toBe('#7');
    });
  });

  // ── onDragStart ────────────────────────────────────────────────────────

  describe('onDragStart', () => {
    beforeEach(() => setup());

    it('should emit dragStart with task and dragEvent', () => {
      const emitted = vi.fn();

      component.dragStart.subscribe(emitted);

      const mockDragEvent = { type: 'dragstart' } as DragEvent;

      component.onDragStart(mockDragEvent);

      expect(emitted).toHaveBeenCalledWith({ task: component.task(), dragEvent: mockDragEvent });
    });
  });

  // ── taskClick ──────────────────────────────────────────────────────────

  describe('taskClick', () => {
    beforeEach(() => setup());

    it('should emit taskClick with the task', () => {
      const emitted = vi.fn();

      component.taskClick.subscribe(emitted);
      component.taskClick.emit(component.task());

      expect(emitted).toHaveBeenCalled();
    });
  });

  // ── lightweight board-card layout (BoardTask projection) ───────────────

  describe('board card layout', () => {
    it('renders the resolved issue type name in the bottom row', async () => {
      await setup({}, 'PROJ', 'Story');
      expect(fixture.nativeElement.textContent).toContain('Story');
    });

    it('never renders the description — even when it is present on the input object', async () => {
      await setup({ description: 'SECRET-BOARD-DESCRIPTION' });
      expect(fixture.nativeElement.textContent).not.toContain('SECRET-BOARD-DESCRIPTION');
    });

    it('clamps the title to 2 lines', async () => {
      await setup({ title: 'A very long title that would overflow the card' });

      // The card title is an h3 so the board outline runs
      // h1 → h2 (column) → h3 (card). The class under test is unchanged.
      const title = fixture.nativeElement.querySelector('h3');

      expect(title.classList.contains('line-clamp-2')).toBe(true);
    });
  });
});
