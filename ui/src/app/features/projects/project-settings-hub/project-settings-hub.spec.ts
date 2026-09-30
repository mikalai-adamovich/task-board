import { firstValueFrom } from 'rxjs';
/**
 * Tests for the ProjectSettingsHub.
 *
 * Covers:
 * - Admin sees all settings links (General/Types/Statuses/Labels/Boards/Danger Zone)
 * - Non-admins see only the Members link
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { ProjectSettingsHub } from './project-settings-hub';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { settle } from '@app/shared/testing/zoneless';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let component: any;

async function setup(options: { tenantRole?: string; projectRole?: string } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
    providers: [
      provideRouter([]),
      { provide: AuthStore, useValue: { tenantRole: vi.fn().mockReturnValue(options.tenantRole ?? 'OWNER') } },
      {
        provide: ProjectStore,
        useValue: { projectRole: vi.fn().mockReturnValue(options.projectRole ?? null) },
      },
    ],
  });
  await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

  const fixture = TestBed.createComponent(ProjectSettingsHub);

  fixture.componentRef.setInput('projectKey', 'TP');
  component = fixture.componentInstance;
  await settle(fixture);
}

describe('ProjectSettingsHub', () => {
  it('should list all admin sections for a tenant owner', async () => {
    await setup();

    const segments = component.adminLinks().map((l: { segment: string }) => l.segment);

    expect(segments).toEqual(['general', 'task-types', 'statuses', 'labels', 'board', 'danger-zone']);
    expect(component.isAdmin()).toBe(true);
  });

  it('should list all admin sections for a PROJECT_ADMIN', async () => {
    await setup({ tenantRole: 'MEMBER', projectRole: 'PROJECT_ADMIN' });

    expect(component.isAdmin()).toBe(true);
  });

  it('should hide admin sections for an EDITOR', async () => {
    await setup({ tenantRole: 'MEMBER', projectRole: 'EDITOR' });

    expect(component.isAdmin()).toBe(false);
  });

  it('should mark the danger zone link as destructive', async () => {
    await setup();

    const danger = component.adminLinks().find((l: { segment: string }) => l.segment === 'danger-zone');

    expect(danger.destructive).toBe(true);
  });
});
