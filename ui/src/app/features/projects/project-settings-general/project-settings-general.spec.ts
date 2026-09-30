/**
 * Tests for the ProjectSettingsGeneral page.
 *
 * Covers:
 * - Form seeded from the project context store
 * - Saving name/description via ProjectClient.update
 * - Store sync after save
 * - isAdmin gating
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom, of, throwError } from 'rxjs';
import { submit } from '@angular/forms/signals';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { ProjectSettingsGeneral } from './project-settings-general';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Project } from '@task-board/shared';
import { settle } from '@app/shared/testing/zoneless';

const NOW = '2025-01-01T00:00:00Z';
const mockProject: Project = {
  id: 'p0000000-0000-0000-0000-000000000001',
  tenantId: 't0000000-0000-0000-0000-000000000001',
  key: 'TP',
  name: 'Test Project',
  description: 'A project for testing',
  status: 'ACTIVE',
  defaultStatusId: 's1',
  archiveReason: null,
  deletionScheduledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let component: any;
let fixture: ReturnType<typeof TestBed.createComponent<ProjectSettingsGeneral>>;
let projectClientMock: Record<string, ReturnType<typeof vi.fn>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeProjectMock: any;

async function setup(options: { tenantRole?: string; projectRole?: string } = {}) {
  const state: { project: Project | null } = { project: mockProject };

  activeProjectMock = Object.assign(() => state.project, {
    set: (p: Project | null) => {
      state.project = p;
    },
    update: (fn: (p: Project | null) => Project | null) => {
      state.project = fn(state.project);
    },
  });
  projectClientMock = {
    update: vi
      .fn()
      .mockImplementation((_id: string, data: { name: string; description: string }) =>
        of({ ...mockProject, ...data }),
      ),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [
      TranslocoTestingModule.forRoot({
        preloadLangs: true,
        langs: { en: { common: { charCount: '{{count}}/{{max}}' } } },
        translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
      }),
    ],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      { provide: ProjectClient, useValue: projectClientMock },
      { provide: AuthStore, useValue: { tenantRole: vi.fn().mockReturnValue(options.tenantRole ?? 'OWNER') } },
      {
        provide: ProjectStore,
        useValue: {
          activeProject: activeProjectMock,
          projectRole: vi.fn().mockReturnValue(options.projectRole ?? null),
          // The save handler patches the shared tenant project-list cache
          upsertProject: vi.fn(),
        },
      },
    ],
  });
  await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

  fixture = TestBed.createComponent(ProjectSettingsGeneral);

  fixture.componentRef.setInput('projectKey', mockProject.key);
  component = fixture.componentInstance;
  await settle(fixture);
}

describe('ProjectSettingsGeneral', () => {
  it('should seed the form from the project context', async () => {
    await setup();

    expect(component.model().name).toBe('Test Project');
    expect(component.model().description).toBe('A project for testing');
  });

  it('should save name and description via ProjectClient.update', async () => {
    await setup();
    component.model.update((m: { name: string; description: string }) => ({
      ...m,
      name: 'Renamed Project',
      description: 'New description',
    }));
    submit(component.generalForm);
    await Promise.resolve();

    expect(projectClientMock.update).toHaveBeenCalledWith(mockProject.id, {
      name: 'Renamed Project',
      description: 'New description',
    });
  });

  it('should sync the project store after a successful save', async () => {
    await setup();
    component.model.update((m: { name: string; description: string }) => ({ ...m, name: 'Renamed Project' }));
    submit(component.generalForm);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(activeProjectMock().name).toBe('Renamed Project');
  });

  it('should surface an error message when the update fails', async () => {
    await setup();
    projectClientMock.update?.mockReturnValueOnce(throwError(() => new Error('boom')));
    component.model.update((m: { name: string; description: string }) => ({ ...m, name: 'Nope' }));
    submit(component.generalForm);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(component.error()).toBeTruthy();
  });

  // ── Round 5 P2: description 120-char limit + counter ──────────────────

  it('should mark the description invalid over 120 characters (Round 5 P2)', async () => {
    await setup();
    component.model.update((m: { description: string }) => ({ ...m, description: 'a'.repeat(121) }));

    expect(component.generalForm.description().invalid()).toBe(true);
    expect(component.generalForm().invalid()).toBe(true);
  });

  it('should accept a description of exactly 120 characters (Round 5 P2)', async () => {
    await setup();
    component.model.update((m: { description: string }) => ({ ...m, description: 'a'.repeat(120) }));

    expect(component.generalForm.description().valid()).toBe(true);
  });

  it('should render the character counter under the description field (Round 5 P2)', async () => {
    await setup();
    await settle(fixture);

    const counter = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="desc-char-count"]');

    // Seeded description is 'A project for testing' (21 chars)
    expect(counter?.textContent?.trim()).toBe('21/120');
  });

  describe('isAdmin', () => {
    it('should be true for tenant OWNER', async () => {
      await setup({ tenantRole: 'OWNER' });

      expect(component.isAdmin()).toBe(true);
    });

    it('should be false for EDITOR without tenant role', async () => {
      await setup({ tenantRole: 'MEMBER', projectRole: 'EDITOR' });

      expect(component.isAdmin()).toBe(false);
    });
  });
});
