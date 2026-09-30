/**
 * Tests for ProjectStore — background members loading and reactive project role.
 *
 * Covers the deep-link critical-path optimization: `loadProjectByKey` resolves
 * as soon as the project itself is fetched; members load in the background and
 * the `projectRole` computed updates reactively (OWNER/ADMIN bypass, MEMBER
 * from membership, stale-response guard against cross-project races).
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ProjectStore } from './project-store';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { API_BASE_URL } from '@app/api-url.token';
import type { Project, ProjectMember, User } from '@task-board/shared';

const BASE = 'http://localhost/api';

function makeProject(id: string): Project {
  return { id, name: `Project ${id}`, key: id.toUpperCase() } as unknown as Project;
}

function member(id: string, projectId: string, userId: string, role: string): ProjectMember {
  return { id, projectId, userId, role } as unknown as ProjectMember;
}

describe('ProjectStore — background members + reactive projectRole', () => {
  let store: ProjectStore;
  let authStore: AuthStore;
  let httpMock: HttpTestingController;

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: BASE },
      ],
    });

    store = TestBed.inject(ProjectStore);
    authStore = TestBed.inject(AuthStore);
    httpMock = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    httpMock.verify();
  });

  it('resolves loadProjectByKey without waiting for members (members request fired in background)', async () => {
    setup();

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });

    const project = await promise;

    expect(project.id).toBe('p1');
    expect(store.activeProject()?.id).toBe('p1');
    expect(store.loading()).toBe(false);

    // The members request was already issued but did NOT block the promise —
    // it is only flushed after the loadProjectByKey promise has resolved.
    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({ data: [] });
  });

  it('derives PROJECT_ADMIN for a tenant OWNER immediately, without members', async () => {
    setup();
    authStore.setTenantRole('OWNER');

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });
    await promise;

    expect(store.projectRole()).toBe('PROJECT_ADMIN');

    // The role is derived without members — flush the background request.
    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({ data: [] });
  });

  it('derives PROJECT_ADMIN for a tenant ADMIN immediately, without members', async () => {
    setup();
    authStore.setTenantRole('ADMIN');

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });
    await promise;

    expect(store.projectRole()).toBe('PROJECT_ADMIN');

    // The role is derived without members — flush the background request.
    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({ data: [] });
  });

  it('derives the membership role for a tenant MEMBER once members arrive', async () => {
    setup();
    authStore.setTenantRole('MEMBER');
    authStore.currentUser.set({ id: 'u1' } as User);

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });
    await promise;

    // Members have not arrived yet — the role is not resolved.
    expect(store.projectRole()).toBeNull();

    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({
      data: [member('m1', 'p1', 'u-other', 'VIEWER'), member('m2', 'p1', 'u1', 'EDITOR')],
    });

    await vi.waitFor(() => expect(store.projectRole()).toBe('EDITOR'));
  });

  it('leaves the role null for a tenant MEMBER without project membership', async () => {
    setup();
    authStore.setTenantRole('MEMBER');
    authStore.currentUser.set({ id: 'u1' } as User);

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });
    await promise;

    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({
      data: [member('m1', 'p1', 'u-other', 'VIEWER')],
    });

    await vi.waitFor(() => expect(store.members().length).toBe(1));
    expect(store.projectRole()).toBeNull();
  });

  it('discards a stale members response after navigating to another project', async () => {
    setup();
    authStore.setTenantRole('MEMBER');
    authStore.currentUser.set({ id: 'u1' } as User);

    // Load project A (its members request goes in flight)…
    const first = store.loadProjectByKey('t1', 'KEYA');

    httpMock.expectOne(`${BASE}/projects/by-key/KEYA`).flush({ data: makeProject('pA') });
    await first;

    // …then navigate to project B before A's members response arrives.
    const second = store.loadProjectByKey('t1', 'KEYB');

    httpMock.expectOne(`${BASE}/projects/by-key/KEYB`).flush({ data: makeProject('pB') });
    await second;

    // A's members response arrives late — it must be discarded, not merged
    // into project B's context.
    httpMock.expectOne(`${BASE}/projects/pA/members`).flush({
      data: [member('mA', 'pA', 'u1', 'VIEWER')],
    });

    // B's members response applies.
    httpMock.expectOne(`${BASE}/projects/pB/members`).flush({
      data: [member('mB', 'pB', 'u1', 'EDITOR')],
    });

    await vi.waitFor(() => expect(store.members().some((m) => m.id === 'mB')).toBe(true));
    expect(store.members().some((m) => m.id === 'mA')).toBe(false);
    expect(store.projectRole()).toBe('EDITOR');
  });

  it('does not fail loadProjectByKey when the background members request errors', async () => {
    setup();
    authStore.setTenantRole('MEMBER');
    authStore.currentUser.set({ id: 'u1' } as User);

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });

    const project = await promise;

    expect(project.id).toBe('p1');

    httpMock.expectOne(`${BASE}/projects/p1/members`).flush('boom', { status: 500, statusText: 'Server Error' });

    // Members are non-critical: the project context stays intact, members stay empty.
    expect(store.activeProject()?.id).toBe('p1');
    expect(store.members()).toEqual([]);
  });

  it('clears members and resets the role with clearProject', async () => {
    setup();
    authStore.setTenantRole('OWNER');

    const promise = store.loadProjectByKey('t1', 'KEY');

    httpMock.expectOne(`${BASE}/projects/by-key/KEY`).flush({ data: makeProject('p1') });
    await promise;

    httpMock.expectOne(`${BASE}/projects/p1/members`).flush({
      data: [member('m1', 'p1', 'u1', 'EDITOR')],
    });

    await vi.waitFor(() => expect(store.members().length).toBe(1));
    expect(store.projectRole()).toBe('PROJECT_ADMIN');

    store.clearProject();

    expect(store.activeProject()).toBeNull();
    expect(store.members()).toEqual([]);
    expect(store.projectRole()).toBeNull();
  });

  // ── Shared tenant-scoped project-list cache ─────────────────────────────────

  function tenantProject(tenantId: string, id: string): Project {
    return { ...makeProject(id), tenantId } as unknown as Project;
  }

  describe('F4: project-list cache', () => {
    it('dedupes concurrent ensureProjectList calls into ONE HTTP request', async () => {
      setup();

      const first = store.ensureProjectList('t1');
      const second = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('t1', 'p1')] });

      const [a, b] = await Promise.all([first, second]);

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(store.projectList('t1')).toHaveLength(1);
    });

    it('serves repeated reads from the cache without another HTTP request', async () => {
      setup();

      const first = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('t1', 'p1')] });
      await first;

      const second = await store.ensureProjectList('t1');

      expect(second).toHaveLength(1);
      httpMock.expectNone(`${BASE}/projects`);
    });

    it('keeps tenants isolated (tenant A ≠ tenant B)', async () => {
      setup();

      const a = store.ensureProjectList('tA');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('tA', 'pA')] });
      await a;

      const b = store.ensureProjectList('tB');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('tB', 'pB')] });
      await b;

      expect(store.projectList('tA').map((p) => p.id)).toEqual(['pA']);
      expect(store.projectList('tB').map((p) => p.id)).toEqual(['pB']);
    });

    it('does not cache failures — a later ensure retries the request', async () => {
      setup();

      const failing = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush('boom', { status: 500, statusText: 'Server Error' });

      await expect(failing).rejects.toBeTruthy();
      expect(store.projectList('t1')).toEqual([]);

      const retried = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('t1', 'p1')] });
      await retried;

      expect(store.projectList('t1')).toHaveLength(1);
    });

    it('upserts mutations into the cached list (create appends, update replaces)', async () => {
      setup();

      const first = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('t1', 'p1')] });
      await first;

      // Create: a project with an unknown id is appended.
      store.upsertProject(tenantProject('t1', 'p2'));
      expect(store.projectList('t1').map((p) => p.id)).toEqual(['p1', 'p2']);

      // Update: the same id replaces the entry instead of duplicating it.
      store.upsertProject({ ...tenantProject('t1', 'p1'), name: 'Renamed' } as unknown as Project);

      const list = store.projectList('t1');

      expect(list).toHaveLength(2);
      expect(list.find((p) => p.id === 'p1')?.name).toBe('Renamed');
    });

    it('invalidates one tenant without touching the others', async () => {
      setup();

      const a = store.ensureProjectList('tA');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('tA', 'pA')] });
      await a;

      const b = store.ensureProjectList('tB');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('tB', 'pB')] });
      await b;

      store.invalidateProjectList('tA');

      expect(store.projectList('tA')).toEqual([]);
      expect(store.projectList('tB')).toHaveLength(1);

      // The next ensure for tA refetches; tB stays cached.
      const refetch = store.ensureProjectList('tA');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('tA', 'pA2')] });
      await refetch;

      httpMock.expectNone(`${BASE}/projects`);
      expect(store.projectList('tA').map((p) => p.id)).toEqual(['pA2']);
    });

    it('clears ALL cached lists and the active project on logout (active tenant → null)', async () => {
      setup();
      TestBed.inject(TenantStore).setActiveTenant({ id: 't1', slug: 'acme', name: 'Acme' } as never);
      // Flush the session-isolation effect so the tenant was "seen" as active.
      TestBed.tick();

      const first = store.ensureProjectList('t1');

      httpMock.expectOne(`${BASE}/projects`).flush({ data: [tenantProject('t1', 'p1')] });
      await first;
      expect(store.projectList('t1')).toHaveLength(1);

      // Simulate logout: AuthStore.logout() calls TenantStore.clear(), which
      // nulls the active tenant — the store must drop every cached list.
      TestBed.inject(TenantStore).activeTenant.set(null);
      TestBed.tick();

      expect(store.projectList('t1')).toEqual([]);
      expect(store.activeProject()).toBeNull();
    });
  });
});
