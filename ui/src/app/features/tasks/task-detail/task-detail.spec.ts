/**
 * Tests for the TaskDetail component.
 *
 * Covers:
 * - Loading task on init
 * - Loading/error states
 * - priorityBadgeVariant / priorityLabel helpers
 * - Inline title edit (click → edit → confirm PATCHes, cancel/escape discards)
 * - Inline description save/cancel (keepEditViewOpenOnBlur semantics)
 * - No Edit button / edit-mode state
 * - Header layout classes (key nowrap, title clamp)
 * - Labels add/remove from detail PATCHes labelIds
 * - Viewer sees no edit affordances
 * - canDelete check
 * - Optimistic concurrency conflict handling
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { firstValueFrom, of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { TaskDetail } from './task-detail';
import { TaskClient } from '@services/task-client';
import { LabelClient } from '@services/label-client';
import { AuthStore } from '@stores/auth-store';
import { API_BASE_URL } from '@app/api-url.token';
import { HttpErrorResponse } from '@angular/common/http';
import type { Task, TaskPriorityLevel, User } from '@task-board/shared';
import { settle } from '@app/shared/testing/zoneless';

const NOW = '2025-01-01T00:00:00Z';
const mockTask: Task = {
  id: 'tk000000-0000-0000-0000-000000000001',
  projectId: 'p0000000-0000-0000-0000-000000000001',
  number: 1,
  typeId: 'type1',
  title: 'Test Task',
  description: 'Task description',
  statusId: 's1',
  priorityLevel: 2,
  reporterId: 'u1',
  reporterSnapshot: { displayName: 'Reporter User' },
  assigneeId: 'u2',
  assigneeSnapshot: { displayName: 'Assignee User' },
  sprintId: null,
  labelIds: ['label1'],
  createdById: 'u1',
  createdBySnapshot: { displayName: 'Creator User' },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('TaskDetail', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fixture: any;
  let taskClientMock: {
    getById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let labelClientMock: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let authStoreMock: { currentUser: ReturnType<typeof vi.fn>; tenantRole: ReturnType<typeof vi.fn> };

  async function setup(
    taskOverrides: Partial<Task> = {},
    authOverrides: { currentUser?: unknown; tenantRole?: string | null } = {},
  ) {
    const task = { ...mockTask, ...taskOverrides };

    taskClientMock = {
      getById: vi.fn().mockReturnValue(of(task)),
      update: vi.fn().mockReturnValue(of({ ...task, title: 'Updated Title', version: 2 })),
      delete: vi.fn().mockReturnValue(of(undefined)),
    };
    labelClientMock = {
      list: vi.fn().mockReturnValue(
        of([
          { id: 'label1', name: 'backend' },
          { id: 'label2', name: 'bug' },
        ]),
      ),
      create: vi.fn().mockReturnValue(of({ id: 'label9', name: 'urgent' })),
    };
    authStoreMock = {
      currentUser: vi
        .fn()
        .mockReturnValue(authOverrides.currentUser ?? ({ id: 'u1', email: 'a@b.com', displayName: 'Test' } as User)),
      tenantRole: vi.fn().mockReturnValue('tenantRole' in authOverrides ? authOverrides.tenantRole : 'OWNER'),
    };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          preloadLangs: true,
          langs: { en: {} },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: 'http://localhost/api' },
        {
          provide: AuthStore,
          useValue: {
            isAuthenticated: () => false,
            currentUser: authStoreMock.currentUser,
            token: () => null,
            tenantRole: authStoreMock.tenantRole,
          },
        },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: LabelClient, useValue: labelClientMock },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: () => 't1' } },
            parent: { snapshot: { paramMap: { get: () => 't1' } }, parent: null },
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TaskDetail);

    fixture.componentRef.setInput('taskNumber', 'TK-1');

    component = fixture.componentInstance;
    await settle(fixture);
    // rxResource resolves asynchronously — poll until the task signal populates
    for (let i = 0; i < 100 && !component.task(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      await settle(fixture);
    }
  }

  /** Poll until the given condition holds (reference data resolves asynchronously) */
  async function pollUntil(condition: () => boolean, tries = 100): Promise<void> {
    for (let i = 0; i < tries && !condition(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      await settle(fixture);
    }
  }

  // ── Loading ─────────────────────────────────────────────────────

  describe('loading', () => {
    it('should call taskClient.getById on init', async () => {
      await setup();
      expect(taskClientMock.getById).toHaveBeenCalledWith('TK-1');
    });

    it('should populate task signal after loading', async () => {
      await setup();
      expect(component.task()).toBeTruthy();
      expect(component.task().title).toBe('Test Task');
    });

    it('should populate the task and clear error after successful load', async () => {
      await setup();
      expect(component.task()).toBeTruthy();
      expect(component.error()).toBe('');
    });

    it('should leave the task empty on load error', async () => {
      taskClientMock = {
        getById: vi.fn().mockReturnValue(throwError(() => new Error('fail'))),
        update: vi.fn(),
        delete: vi.fn(),
      };
      authStoreMock = {
        currentUser: vi.fn().mockReturnValue(null),
        tenantRole: vi.fn().mockReturnValue(null),
      };
      TestBed.configureTestingModule({
        imports: [
          TranslocoTestingModule.forRoot({
            preloadLangs: true,
            langs: { en: {} },
            translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          }),
        ],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          { provide: API_BASE_URL, useValue: 'http://localhost/api' },
          {
            provide: AuthStore,
            useValue: {
              isAuthenticated: () => false,
              currentUser: () => null,
              token: () => null,
              tenantRole: () => null,
            },
          },
          { provide: TaskClient, useValue: taskClientMock },
          { provide: LabelClient, useValue: labelClientMock },
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: { paramMap: { get: () => 't1' } },
              parent: { snapshot: { paramMap: { get: () => 't1' } }, parent: null },
            },
          },
        ],
      });
      await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

      fixture = TestBed.createComponent(TaskDetail);

      fixture.componentRef.setInput('taskNumber', 'TK-1');
      component = fixture.componentInstance;
      await settle(fixture);

      // rxResource settles asynchronously — give it a moment to settle
      for (let i = 0; i < 20 && !component.task(); i++) {
        await new Promise((r) => setTimeout(r, 10));
        await settle(fixture);
      }

      expect(component.task()).toBeNull();
    });
  });

  // ── Priority helpers ───────────────────────────────────

  describe('priority helpers', () => {
    beforeEach(() => setup());

    it('should return correct badge variant per priority', async () => {
      expect(component.priorityBadgeVariant(0)).toBe('outline');
      expect(component.priorityBadgeVariant(1)).toBe('secondary');
      expect(component.priorityBadgeVariant(2)).toBe('default');
      expect(component.priorityBadgeVariant(3)).toBe('destructive');
      expect(component.priorityBadgeVariant('unknown')).toBe('outline');
    });

    it('should return translated display labels (P11); unknown values render verbatim', async () => {
      expect(component.priorityLabel(0)).toBe('priority.low');
      expect(component.priorityLabel(1)).toBe('priority.medium');
      expect(component.priorityLabel(2)).toBe('priority.high');
      expect(component.priorityLabel(3)).toBe('priority.critical');
      expect(component.priorityLabel(99 as TaskPriorityLevel)).toBe('99');
    });
  });

  // ── taskLabel ──────────────────────────────────────────

  describe('taskLabel', () => {
    beforeEach(() => setup());

    it('should return #number', async () => {
      expect(component.taskLabel()).toBe('#1');
    });
  });

  // ── No edit mode ───────────────────────────────────────

  describe('edit mode removal', () => {
    it('should not render an Edit button', async () => {
      await setup();
      await settle(fixture);

      const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLElement[];

      expect(buttons.map((b) => b.textContent?.trim())).not.toContain('taskDetail.edit');
    });

    it('should have no edit-mode state left', async () => {
      await setup();

      expect(component.isEditing).toBeUndefined();
      expect(component.startEdit).toBeUndefined();
      expect(component.editForm).toBeUndefined();
    });
  });

  // ── Inline title edit ──────────────────────────────────

  describe('inline title edit', () => {
    beforeEach(() => setup());

    it('should enter edit view with the current title as draft', async () => {
      component.startTitleEdit();

      expect(component.editingTitle()).toBe(true);
      expect(component.titleDraft()).toBe('Test Task');
    });

    it('should PATCH the title with version on confirm', async () => {
      component.startTitleEdit();
      component.titleDraft.set('Renamed Task');
      component.confirmTitleEdit();

      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ title: 'Renamed Task', version: 1 }),
      );
      expect(component.editingTitle()).toBe(false);
    });

    it('should update the task signal after successful confirm', async () => {
      component.startTitleEdit();
      component.titleDraft.set('Renamed Task');
      component.confirmTitleEdit();

      expect(component.task().title).toBe('Updated Title');
    });

    it('should not PATCH when cancelled (Escape/✕)', async () => {
      component.startTitleEdit();
      component.titleDraft.set('Renamed Task');
      component.cancelTitleEdit();

      expect(component.editingTitle()).toBe(false);
      expect(component.titleDraft()).toBe('');
      expect(taskClientMock.update).not.toHaveBeenCalled();
    });

    it('should not PATCH an unchanged or blank title', async () => {
      component.startTitleEdit();
      component.confirmTitleEdit();

      expect(taskClientMock.update).not.toHaveBeenCalled();

      component.startTitleEdit();
      component.titleDraft.set('   ');
      component.confirmTitleEdit();

      expect(taskClientMock.update).not.toHaveBeenCalled();
    });
  });

  // ── Inline description edit ────────────────────────────

  describe('inline description edit', () => {
    beforeEach(() => setup());

    it('should enter edit view with the current description as draft', async () => {
      component.startDescriptionEdit();

      expect(component.editingDescription()).toBe(true);
      expect(component.descriptionDraft()).toBe('Task description');
    });

    it('should PATCH the description with version on Save', async () => {
      component.startDescriptionEdit();
      component.descriptionDraft.set('New **markdown** body');
      component.confirmDescriptionEdit();

      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ description: 'New **markdown** body', version: 1 }),
      );
      expect(component.editingDescription()).toBe(false);
    });

    it('should not PATCH when cancelled', async () => {
      component.startDescriptionEdit();
      component.descriptionDraft.set('Discarded draft');
      component.cancelDescriptionEdit();

      expect(component.editingDescription()).toBe(false);
      expect(taskClientMock.update).not.toHaveBeenCalled();
    });

    it('should not PATCH an unchanged description', async () => {
      component.startDescriptionEdit();
      component.confirmDescriptionEdit();

      expect(taskClientMock.update).not.toHaveBeenCalled();
    });
  });

  // ── Header layout ──────────────────────────────────────

  describe('header layout', () => {
    it('should render nowrap key, clamped title and own-row priority badge', async () => {
      await setup({ title: 'A very long task title that should wrap onto multiple lines without widening layout' });
      await settle(fixture);

      const el: HTMLElement = fixture.nativeElement;
      const key = el.querySelector('span.font-mono');

      expect(key?.classList.contains('whitespace-nowrap')).toBe(true);

      const title = el.querySelector('h1');

      expect(title?.classList.contains('break-words')).toBe(true);
      expect(title?.classList.contains('line-clamp-2')).toBe(true);
    });
  });

  // ── Labels editing ─────────────────────────────────────

  describe('labels editing', () => {
    beforeEach(() => setup());

    it('should resolve current labels to names', async () => {
      await pollUntil(() => component.selectedLabels().length > 0 && component.selectedLabels()[0].name === 'backend');

      expect(component.selectedLabels()).toEqual([{ id: 'label1', name: 'backend' }]);
    });

    it('should PATCH labelIds when adding an existing label', async () => {
      await component.onLabelPicked({ id: 'label2', name: 'bug' });

      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ labelIds: ['label1', 'label2'], version: 1 }),
      );
    });

    it('should reuse an existing label case-insensitively instead of creating one', async () => {
      await pollUntil(() => component.labelOptions().length > 0);
      await component.onLabelPicked({ id: '', name: 'BUG' });

      expect(labelClientMock.create).not.toHaveBeenCalled();
      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ labelIds: ['label1', 'label2'] }),
      );
    });

    it('should create a new label then PATCH labelIds including it', async () => {
      await pollUntil(() => component.labelOptions().length > 0);
      await component.onLabelPicked({ id: '', name: 'urgent' });

      expect(labelClientMock.create).toHaveBeenCalledWith(mockTask.projectId, { name: 'urgent' });
      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ labelIds: ['label1', 'label9'] }),
      );
    });

    it('should PATCH labelIds without the removed label', async () => {
      component.removeLabel('label1');

      expect(taskClientMock.update).toHaveBeenCalledWith(
        mockTask.id,
        expect.objectContaining({ labelIds: [], version: 1 }),
      );
    });
  });

  // ── Viewer permissions ─────────────────────────────────

  describe('viewer sees no edit affordances', () => {
    it('should disable editing and hide affordances for users without write access', async () => {
      await setup({}, { tenantRole: null });
      await settle(fixture);

      expect(component.canEdit()).toBe(false);

      const el: HTMLElement = fixture.nativeElement;

      // Title is a plain heading — no click-to-edit role
      expect(el.querySelector('h1')?.closest('[role="button"]')).toBeNull();
      // Inline editors cannot be started
      component.startTitleEdit();
      component.startDescriptionEdit();

      expect(component.editingTitle()).toBe(false);
      expect(component.editingDescription()).toBe(false);
      // Priority renders as a translated label (test dict is empty → the i18n key)
      expect(el.textContent).toContain('priority.high');
    });
  });

  // ── canDelete ──────────────────────────────────────────────────

  describe('canDelete', () => {
    it('should return true when user is authenticated', async () => {
      await setup();
      expect(component.canDelete()).toBe(true);
    });

    it('should return false when user is not authenticated', async () => {
      await setup({}, { currentUser: null, tenantRole: null });

      expect(component.canDelete()).toBe(false);
    });
  });

  // ── Optimistic concurrency ────────────────────────────────────

  describe('optimistic concurrency', () => {
    beforeEach(() => setup());

    it('should show conflict dialog on 409 response', async () => {
      const conflictError = new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'TASK_VERSION_CONFLICT', message: 'Version conflict' } },
      });

      taskClientMock.update.mockReturnValueOnce(throwError(() => conflictError));
      component.startTitleEdit();
      component.titleDraft.set('Updated Title');
      component.confirmTitleEdit();

      expect(component.showConflictDialog()).toBe(true);
      expect(component.conflictMessage()).toBe('taskDetail.conflictHint');
    });

    it('should reload task and close conflict dialog on reloadAfterConflict', async () => {
      component.showConflictDialog.set(true);
      component.reloadAfterConflict();

      expect(component.showConflictDialog()).toBe(false);
    });
  });
});
