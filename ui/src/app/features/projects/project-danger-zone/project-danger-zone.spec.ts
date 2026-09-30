/**
 * Tests for the ProjectDangerZone page.
 *
 * Covers:
 * - Archive / restore / cancel-deletion lifecycle actions
 * - Typed confirmation gate for deletion
 * - Delete confirmation flow and error handling
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom, of, throwError } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { ProjectDangerZone } from './project-danger-zone';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { TenantStore } from '@stores/tenant-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Project } from '@task-board/shared';
import { settle } from '@app/shared/testing/zoneless';

const NOW = '2025-01-01T00:00:00Z';

function makeProject(status: Project['status'] = 'ACTIVE'): Project {
  return {
    id: 'p0000000-0000-0000-0000-000000000001',
    tenantId: 't0000000-0000-0000-0000-000000000001',
    key: 'TP',
    name: 'Test Project',
    description: null,
    status,
    defaultStatusId: 's1',
    archiveReason: null,
    deletionScheduledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let component: any;
let projectClientMock: Record<string, ReturnType<typeof vi.fn>>;

async function setup(projectStatus: Project['status'] = 'ACTIVE') {
  const project = makeProject(projectStatus);

  projectClientMock = {
    archive: vi.fn().mockReturnValue(of({ success: true })),
    restore: vi.fn().mockReturnValue(of({ success: true })),
    delete: vi.fn().mockReturnValue(of({ success: true })),
    cancelDeletion: vi.fn().mockReturnValue(of({ success: true })),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: 'http://localhost/api' },
      { provide: ProjectClient, useValue: projectClientMock },
      { provide: AuthStore, useValue: { tenantRole: vi.fn().mockReturnValue('OWNER') } },
      {
        provide: ProjectStore,
        useValue: {
          activeProject: Object.assign(() => project, { set: vi.fn(), update: vi.fn() }),
          projectRole: vi.fn().mockReturnValue(null),
          // Lifecycle mutations patch the shared tenant project-list cache
          upsertProject: vi.fn(),
        },
      },
      { provide: TenantStore, useValue: { activeTenant: vi.fn().mockReturnValue({ slug: 'ws' }) } },
    ],
  });
  await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

  const fixture = TestBed.createComponent(ProjectDangerZone);

  fixture.componentRef.setInput('projectKey', 'TP');
  component = fixture.componentInstance;
  await settle(fixture);
}

describe('ProjectDangerZone', () => {
  it('should archive an active project', async () => {
    await setup();

    component.archiveProject();

    expect(projectClientMock.archive).toHaveBeenCalledWith(makeProject().id);
    expect(component.project()?.status).toBe('ARCHIVED');
  });

  it('should restore an archived project', async () => {
    await setup('ARCHIVED');

    component.restoreProject();

    expect(projectClientMock.restore).toHaveBeenCalledWith(makeProject().id);
    expect(component.project()?.status).toBe('ACTIVE');
    expect(component.project()?.deletionScheduledAt).toBeNull();
  });

  it('should cancel a pending deletion', async () => {
    await setup('DELETION_PENDING');

    component.cancelDeletion();

    expect(projectClientMock.cancelDeletion).toHaveBeenCalledWith(makeProject().id);
    expect(component.project()?.status).toBe('ACTIVE');
  });

  describe('typed confirmation (delete)', () => {
    it('should block confirmation until the typed text matches the key', async () => {
      await setup();

      component.requestDeleteProject();

      expect(component.showDeleteConfirm()).toBe(true);
      expect(component.canConfirmDelete()).toBe(false);

      component.deleteConfirmText.set('WRONG');

      expect(component.canConfirmDelete()).toBe(false);
    });

    it('should allow confirmation when the typed text matches the key', async () => {
      await setup();

      component.requestDeleteProject();
      component.deleteConfirmText.set('TP');

      expect(component.canConfirmDelete()).toBe(true);
    });

    it('should not call delete when confirmation does not match', async () => {
      await setup();

      component.deleteConfirmText.set('WRONG');
      component.confirmDeleteProject();

      expect(projectClientMock.delete).not.toHaveBeenCalled();
    });

    it('should close the dialog after a successful delete request', async () => {
      await setup();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      component.requestDeleteProject();
      component.deleteConfirmText.set('TP');
      component.confirmDeleteProject();
      await Promise.resolve();

      expect(projectClientMock.delete).toHaveBeenCalledWith(makeProject().id);
      expect(component.showDeleteConfirm()).toBe(false);
      expect(component.deleteConfirmText()).toBe('');
    });

    it('should sync DELETION_PENDING into ProjectStore before navigating back (F1: overview has no refetch)', async () => {
      await setup();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      component.requestDeleteProject();
      component.deleteConfirmText.set('TP');
      component.confirmDeleteProject();
      await Promise.resolve();

      const store = TestBed.inject(ProjectStore) as unknown as {
        activeProject: { set: ReturnType<typeof vi.fn> };
      };

      // The overview reads ProjectStore.activeProject() without re-fetching,
      // so the read-only banner would stay stale unless the store is updated here.
      expect(store.activeProject.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'DELETION_PENDING' }));
    });

    it('should surface an error when delete fails', async () => {
      await setup();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      projectClientMock.delete?.mockReturnValueOnce(throwError(() => new Error('boom')));

      component.requestDeleteProject();
      component.deleteConfirmText.set('TP');
      component.confirmDeleteProject();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(component.error()).toBeTruthy();
      expect(component.showDeleteConfirm()).toBe(false);
    });
  });
});
