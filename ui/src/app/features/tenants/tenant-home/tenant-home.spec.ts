/**
 * Tests for the unified TenantHome component.
 *
 * Covers:
 * - Projects grid rendering with slug-based links
 * - "My Tasks" widget scoped to the active tenant's projects (KEY-NUMBER links)
 * - Pending-invitations summary for OWNER/ADMIN only
 */
import { signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { settle } from '@app/shared/testing/zoneless';
import { TenantHome } from './tenant-home';
import { ProjectClient } from '@services/project-client';
import { TaskClient } from '@services/task-client';
import { TenantClient } from '@services/tenant-client';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import type { Project, Task, TenantMember } from '@task-board/shared';

const NOW = '2025-01-01T00:00:00Z';
const mockTenant = {
  id: 't1',
  name: 'Acme',
  slug: 'acme',
  description: null,
  status: 'ACTIVE',
  deletionScheduledAt: null,
  role: 'OWNER',
  createdAt: NOW,
  updatedAt: NOW,
};
const mockProjects: Project[] = [
  {
    id: 'p1',
    tenantId: 't1',
    key: 'ABC',
    name: 'Alpha',
    description: null,
    status: 'ACTIVE',
    deletionScheduledAt: null,
    defaultStatusId: 's1',
    archiveReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
];
const mockTasks: Task[] = [
  {
    id: 'tk1',
    projectId: 'p1',
    number: 7,
    typeId: 'type1',
    title: 'First task',
    description: null,
    statusId: 's1',
    priorityLevel: 2,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: 'u1',
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'U' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'tk2',
    projectId: 'other-tenant-project',
    number: 3,
    typeId: 'type1',
    title: 'Foreign task',
    description: null,
    statusId: 's1',
    priorityLevel: 0,
    reporterId: null,
    reporterSnapshot: null,
    assigneeId: 'u1',
    assigneeSnapshot: null,
    sprintId: null,
    labelIds: [],
    createdById: 'u1',
    createdBySnapshot: { displayName: 'U' },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
];
const mockPendingInvite: TenantMember = {
  id: 'm1',
  tenantId: 't1',
  userId: 'u9',
  role: 'MEMBER',
  status: 'ACCESS_REVOKED',
  expiresAt: null,
  invitation: { status: 'PENDING', tokenHash: 'h', invitedBy: 'u1', invitedOn: NOW },
  displayName: null,
  email: 'new@example.com',
  createdAt: NOW,
  updatedAt: NOW,
};

describe('TenantHome', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<TenantHome>;
  let projectClientMock: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  let taskClientMock: { getMyTasks: ReturnType<typeof vi.fn> };
  let tenantClientMock: { listMembers: ReturnType<typeof vi.fn> };
  // Real signal so tests can simulate switching the active workspace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantStoreMock: { activeTenant: WritableSignal<any> };
  let authStoreMock: { currentUser: ReturnType<typeof vi.fn>; tenantRole: ReturnType<typeof vi.fn> };

  async function setup(opts: { role?: string; myTasks?: Task[] } = {}) {
    const role = opts.role ?? 'OWNER';

    projectClientMock = {
      list: vi.fn().mockReturnValue(of(mockProjects)),
      create: vi.fn(),
    };
    taskClientMock = {
      getMyTasks: vi.fn().mockReturnValue(of(opts.myTasks ?? mockTasks)),
    };
    tenantClientMock = {
      listMembers: vi.fn().mockReturnValue(of([mockPendingInvite])),
    };
    tenantStoreMock = {
      activeTenant: signal(mockTenant),
    };
    authStoreMock = {
      currentUser: vi.fn().mockReturnValue({ id: 'u1' }),
      tenantRole: vi.fn().mockReturnValue(role),
    };

    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { en: { common: { charCount: '{{count}}/{{max}}' } } },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
          preloadLangs: true,
        }),
        TenantHome,
      ],
      providers: [
        provideRouter([]),
        { provide: ProjectClient, useValue: projectClientMock },
        { provide: TaskClient, useValue: taskClientMock },
        { provide: TenantClient, useValue: tenantClientMock },
        { provide: TenantStore, useValue: tenantStoreMock },
        { provide: AuthStore, useValue: authStoreMock },
      ],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(TenantHome);

    component = fixture.componentInstance;
    await settle(fixture);
  }

  it('should load the tenant projects', async () => {
    await setup();

    await new Promise((r) => setTimeout(r, 0));

    expect(projectClientMock.list).toHaveBeenCalled();
    expect(component.projects()).toEqual(mockProjects);
  });

  it('should scope My Tasks to this tenant and resolve KEY-NUMBER segments', async () => {
    await setup();

    // Wait for both resources to emit
    for (let i = 0; i < 20 && component.myTaskItems().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const items = component.myTaskItems();

    expect(items).toHaveLength(1);
    expect(items[0].projectKey).toBe('ABC');
    expect(items[0].task.id).toBe('tk1');
  });

  it('should expose pending invitations for admins', async () => {
    await setup({ role: 'ADMIN' });

    for (let i = 0; i < 20 && component.pendingInvites().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(tenantClientMock.listMembers).toHaveBeenCalledWith('t1');
    expect(component.pendingInvites()).toHaveLength(1);
  });

  it('should not fetch members for plain members', async () => {
    await setup({ role: 'MEMBER' });

    await new Promise((r) => setTimeout(r, 0));

    expect(tenantClientMock.listMembers).not.toHaveBeenCalled();
  });

  // ── The pending-invitation summary is an rxResource, not an effect ─────────

  it('should request the member list exactly ONCE per tenant (resource, no duplicate effect run)', async () => {
    await setup({ role: 'OWNER' });

    for (let i = 0; i < 20 && component.pendingInvites().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(fixture);

    expect(tenantClientMock.listMembers).toHaveBeenCalledTimes(1);
    expect(tenantClientMock.listMembers).toHaveBeenCalledWith('t1');
    expect(component.pendingInvites()).toHaveLength(1);
    expect(component.loadingInvites()).toBe(false);
  });

  it('should NOT request members while the active tenant is unresolved (F21)', async () => {
    await setup({ role: 'OWNER' });
    tenantClientMock.listMembers.mockClear();
    tenantStoreMock.activeTenant.set(null);

    await settle(fixture);
    await new Promise((r) => setTimeout(r, 10));
    await settle(fixture);

    expect(tenantClientMock.listMembers).not.toHaveBeenCalled();
    expect(component.pendingInvites()).toEqual([]);
  });

  it('should re-request the member list when the active tenant switches (F21)', async () => {
    await setup({ role: 'OWNER' });

    for (let i = 0; i < 20 && component.pendingInvites().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    tenantStoreMock.activeTenant.set({ ...mockTenant, id: 't2', slug: 'globex', name: 'Globex' });

    for (let i = 0; i < 20 && tenantClientMock.listMembers.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(fixture);

    expect(tenantClientMock.listMembers).toHaveBeenCalledTimes(2);
    expect(tenantClientMock.listMembers).toHaveBeenLastCalledWith('t2');
  });

  // ── Resources must re-run when the active workspace changes ────────────────

  it('should re-fetch projects and my tasks when the active tenant switches (Round 5 F-01)', async () => {
    await setup();

    await new Promise((r) => setTimeout(r, 0));

    expect(projectClientMock.list).toHaveBeenCalledTimes(1);
    expect(taskClientMock.getMyTasks).toHaveBeenCalledTimes(1);
    expect(component.projects()).toEqual(mockProjects);

    const tenantB = { ...mockTenant, id: 't2', slug: 'globex', name: 'Globex' };
    const projectsB: Project[] = [{ ...(mockProjects[0] as Project), id: 'p2', tenantId: 't2', name: 'Beta' }];

    projectClientMock.list.mockReturnValue(of(projectsB));
    taskClientMock.getMyTasks.mockReturnValue(of([]));
    tenantStoreMock.activeTenant.set(tenantB);

    for (let i = 0; i < 20 && component.projects() !== projectsB; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(fixture);

    expect(projectClientMock.list).toHaveBeenCalledTimes(2);
    expect(taskClientMock.getMyTasks).toHaveBeenCalledTimes(2);
    expect(component.projects()).toEqual(projectsB);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Beta');
  });

  it('should render the standard empty state (icon + title + hint) when My Tasks is empty (DR-8)', async () => {
    await setup({ myTasks: [] });

    for (let i = 0; i < 20 && component.myTaskItems().length !== 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(fixture);

    const el: HTMLElement = fixture.nativeElement;
    const empty = el.querySelector('hlm-empty');

    expect(empty).not.toBeNull();
    expect(empty?.querySelector('hlm-empty-media')).not.toBeNull();
    expect(el.textContent).toContain('tenantHome.noTasks');
    expect(el.textContent).toContain('tenantHome.noTasksHint');
  });

  // ── V2-10: role-gated Create-project CTA ──────────────────────

  it('should allow project creation for OWNER (V2-10)', async () => {
    await setup({ role: 'OWNER' });

    expect(component.canCreate()).toBe(true);
  });

  it('should allow project creation for ADMIN (V2-10)', async () => {
    await setup({ role: 'ADMIN' });

    expect(component.canCreate()).toBe(true);
  });

  it('should hide the Create-project CTA from plain MEMBERs (V2-10)', async () => {
    await setup({ role: 'MEMBER' });

    expect(component.canCreate()).toBe(false);
  });

  // ── Round 5 P2: project description 120-char limit ────────────

  it('should mark the create-project description invalid over 120 characters (Round 5 P2)', async () => {
    await setup({ role: 'OWNER' });

    component.model.update((m: { description: string }) => ({ ...m, description: 'a'.repeat(121) }));

    expect(component.newProjectForm.description().invalid()).toBe(true);
    expect(component.newProjectForm().invalid()).toBe(true);
  });

  it('should accept a create-project description of exactly 120 characters (Round 5 P2)', async () => {
    await setup({ role: 'OWNER' });

    component.model.update((m: { name: string; key: string; description: string }) => ({
      ...m,
      name: 'Alpha',
      key: 'ABC',
      description: 'a'.repeat(120),
    }));

    expect(component.newProjectForm.description().valid()).toBe(true);
  });
});
