/**
 * Tests for the ProjectRefStore.
 *
 * Covers:
 * - ensure(): fetches reference data per `${projectId}:${kind}`, caches it,
 *   dedupes concurrent and repeated calls
 * - invalidate(): drops one cached kind so the next ensure() refetches
 * - options()/nameMap()/nameOf(): reactive reads with id⇄name resolution
 * - error handling: a failed fetch stays uncached so a later ensure() retries
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ProjectRefStore } from './project-ref-store';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { ProjectStore } from './project-store';
import { StatusClient } from '@services/status-client';
import { TaskTypeClient } from '@services/task-type-client';
import { SprintClient } from '@services/sprint-client';
import { LabelClient } from '@services/label-client';
import { ProjectClient } from '@services/project-client';
import type { Project, ProjectMember } from '@task-board/shared';

describe('ProjectRefStore', () => {
  let statusList: ReturnType<typeof vi.fn>;
  let taskTypeList: ReturnType<typeof vi.fn>;
  let sprintList: ReturnType<typeof vi.fn>;
  let labelList: ReturnType<typeof vi.fn>;
  let listMembers: ReturnType<typeof vi.fn>;

  function createModule() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: StatusClient, useValue: { list: (statusList = vi.fn().mockReturnValue(of([]))) } },
        { provide: TaskTypeClient, useValue: { list: (taskTypeList = vi.fn().mockReturnValue(of([]))) } },
        { provide: SprintClient, useValue: { list: (sprintList = vi.fn().mockReturnValue(of([]))) } },
        { provide: LabelClient, useValue: { list: (labelList = vi.fn().mockReturnValue(of([]))) } },
        { provide: ProjectClient, useValue: { listMembers: (listMembers = vi.fn().mockReturnValue(of([]))) } },
        // ProjectStore now derives the project role from the AuthStore state —
        // mock it so no HTTP providers are needed in this spec.
        { provide: AuthStore, useValue: { tenantRole: () => null, currentUser: () => null } },
        // ProjectStore watches TenantStore for session isolation — a stub
        // (never-logged-in state) keeps the DI chain free of HTTP providers.
        { provide: TenantStore, useValue: { activeTenant: signal(null) } },
      ],
    });
  }

  function createStore(): ProjectRefStore {
    return TestBed.inject(ProjectRefStore);
  }

  /** Flush the promise chain inside ensure(). */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    createModule();
  });

  // ── options / nameMap / nameOf (reactive reads) ─────────────────────────

  describe('options', () => {
    it('returns an empty list before ensure() is called', () => {
      const store = createStore();

      expect(store.options('p1', 'statuses')).toEqual([]);
    });

    it('returns the cached options after ensure() resolves', async () => {
      statusList.mockReturnValue(
        of([
          { id: 's1', name: 'TODO' },
          { id: 's2', name: 'DONE' },
        ]),
      );

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      expect(store.options('p1', 'statuses')).toEqual([
        { id: 's1', name: 'TODO' },
        { id: 's2', name: 'DONE' },
      ]);
    });
  });

  describe('nameMap / nameOf', () => {
    it('maps ids to names', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      expect(store.nameMap('p1', 'statuses')).toEqual({ s1: 'TODO' });
      expect(store.nameOf('p1', 'statuses', 's1')).toBe('TODO');
    });

    it('falls back to the raw id for unknown ids', () => {
      const store = createStore();

      expect(store.nameOf('p1', 'statuses', 'unknown-id')).toBe('unknown-id');
    });

    // ── Memoised, stable identity (defeats computed() equality) ──────────────

    it('returns the SAME nameMap/options object for repeated reads (F21)', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      // Before the fix each call rebuilt the map and returned a fresh object, so
      // every computed()/@for relying on it saw a new reference on every read.
      expect(store.nameMap('p1', 'statuses')).toBe(store.nameMap('p1', 'statuses'));
      expect(store.options('p1', 'statuses')).toBe(store.options('p1', 'statuses'));
      expect(store.nameOf('p1', 'statuses', 's1')).toBe('TODO');
    });

    it('returns a stable EMPTY list for an uncached kind (F21)', () => {
      const store = createStore();

      expect(store.entities('p1', 'labels')).toBe(store.entities('p1', 'labels'));
      expect(store.nameMap('p1', 'labels')).toBe(store.nameMap('p1', 'labels'));
    });

    it('derives a new reference only when the cached DTOs change (F21)', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      const first = store.nameMap('p1', 'statuses');

      store.invalidate('p1', 'statuses');
      expect(store.nameMap('p1', 'statuses')).not.toBe(first);
      expect(store.nameMap('p1', 'statuses')).toEqual({});

      statusList.mockReturnValue(of([{ id: 's1', name: 'Backlog' }]));
      store.ensure('p1', ['statuses']);
      await flush();

      const third = store.nameMap('p1', 'statuses');

      expect(third).not.toBe(first);
      expect(third).toEqual({ s1: 'Backlog' });
      expect(store.nameMap('p1', 'statuses')).toBe(third);
    });

    it('patches the memoised views in place on upsertEntity (F21)', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      store.upsertEntity('p1', 'statuses', { id: 's2', name: 'Done' });

      expect(store.nameOf('p1', 'statuses', 's2')).toBe('Done');
      expect(store.nameOf('p1', 'statuses', 's1')).toBe('TODO');
    });
  });

  // ── ensure() ─────────────────────────────────────────────────────────────

  describe('ensure', () => {
    it('fetches each requested kind from the right client', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));
      taskTypeList.mockReturnValue(of([{ id: 't1', name: 'Bug', key: 'BUG' }]));
      sprintList.mockReturnValue(of([{ id: 'sp1', name: 'Sprint 1' }]));
      labelList.mockReturnValue(of([{ id: 'l1', name: 'bug' }]));
      listMembers.mockReturnValue(of([{ userId: 'u1', displayName: 'Alice' }]));

      const store = createStore();

      store.ensure('p1', ['statuses', 'types', 'sprints', 'labels', 'members']);
      await flush();

      expect(statusList).toHaveBeenCalledWith('p1');
      expect(taskTypeList).toHaveBeenCalledWith('p1');
      expect(sprintList).toHaveBeenCalledWith('p1');
      expect(labelList).toHaveBeenCalledWith('p1');
      expect(listMembers).toHaveBeenCalledWith('p1');

      expect(store.options('p1', 'types')).toEqual([{ id: 't1', name: 'Bug', key: 'BUG' }]);
      expect(store.options('p1', 'members')).toEqual([{ id: 'u1', name: 'Alice' }]);
    });

    it('falls back to userId when a member has no displayName', async () => {
      listMembers.mockReturnValue(of([{ userId: 'u1', displayName: null }]));

      const store = createStore();

      store.ensure('p1', ['members']);
      await flush();

      expect(store.options('p1', 'members')).toEqual([{ id: 'u1', name: 'u1' }]);
    });

    it('M-12: derives members from the ProjectStore cache for the active project', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);
      projectStore.loadedMembersFor.set('p-active');

      const store = createStore();

      store.ensure('p-active', ['members']);
      await flush();

      expect(store.options('p-active', 'members')).toEqual([{ id: 'u1', name: 'Alice' }]);
      expect(listMembers).not.toHaveBeenCalled();
    });

    // ── The members branch OBSERVES the store, it does not snapshot it ──
    //
    // `loadProjectByKey` does NOT await the member list, so an `ensure()` that
    // runs before it lands sees `[]`. The defect was that this `[]` was cached
    // like a fetched result — and `[]` is truthy, so every later ensure()
    // short-circuited and the assignee filter stayed empty for the session.
    it('D-38: members that arrive AFTER the first ensure() still reach the consumers', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);

      const store = createStore();

      // The guard resolves the project and the components ensure() immediately —
      // the background member request has not come back yet.
      store.ensure('p-active', ['members']);
      await flush();

      expect(store.options('p-active', 'members')).toEqual([]);

      // …and now it does.
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);

      expect(store.options('p-active', 'members')).toEqual([{ id: 'u1', name: 'Alice' }]);
      expect(store.nameOf('p-active', 'members', 'u1')).toBe('Alice');

      // A later ensure() must not pin the earlier empty snapshot either.
      store.ensure('p-active', ['members']);
      await flush();

      expect(store.options('p-active', 'members')).toEqual([{ id: 'u1', name: 'Alice' }]);
    });

    it('D-38: a membership change after the first read is observed, not frozen', () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);

      const store = createStore();

      expect(store.options('p-active', 'members')).toEqual([{ id: 'u1', name: 'Alice' }]);

      projectStore.members.set([
        { userId: 'u1', displayName: 'Alice' } as ProjectMember,
        { userId: 'u2', displayName: 'Bob' } as ProjectMember,
      ]);

      expect(store.options('p-active', 'members')).toEqual([
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
      ]);
    });

    it('D-38: asks the store for the list exactly once while it is still unloaded', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);
      listMembers.mockReturnValue(of([{ userId: 'u1', displayName: 'Alice' }]));

      const store = createStore();

      store.ensure('p-active', ['members']);
      store.ensure('p-active', ['members']);
      await flush();

      // Repeated ensure() while the load is outstanding must not turn into one
      // request per call (the empty list is a legitimate answer, so length is
      // not a usable "already loaded" test).
      expect(listMembers).toHaveBeenCalledTimes(1);
    });

    it('D-38: invalidate() asks the store for a fresh list', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);
      projectStore.loadedMembersFor.set('p-active');
      listMembers.mockReturnValue(of([{ userId: 'u1', displayName: 'Alice' }, { userId: 'u2' }]));

      const store = createStore();

      store.invalidate('p-active', 'members');
      await flush();

      expect(listMembers).toHaveBeenCalledWith('p-active');
      expect(store.options('p-active', 'members')).toEqual([
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'u2' },
      ]);
    });

    it('D-38: a store-backed project never caches members, so a project switch re-reads', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-a' } as Project);
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);
      listMembers.mockReturnValue(of([{ userId: 'u9', displayName: 'Zoe' }]));

      const store = createStore();

      store.ensure('p-a', ['members']);
      await flush();

      // The user navigates to another project: the ref-store must not keep
      // serving p-a's list, and must not serve it FOR p-b either.
      projectStore.activeProject.set({ id: 'p-b' } as Project);

      store.ensure('p-b', ['members']);
      await flush();

      expect(store.options('p-b', 'members')).toEqual([{ id: 'u9', name: 'Zoe' }]);
      // p-a is no longer the store's project, so its list is not served from the
      // store any more — and it is NOT served p-a's stale snapshot either.
      expect(store.options('p-a', 'members')).toEqual([]);
    });

    it('M-12: still fetches members via the client for a non-active project', async () => {
      const projectStore = TestBed.inject(ProjectStore);

      projectStore.activeProject.set({ id: 'p-active' } as Project);
      projectStore.members.set([{ userId: 'u1', displayName: 'Alice' } as ProjectMember]);
      listMembers.mockReturnValue(of([{ userId: 'u9', displayName: 'Zoe' }]));

      const store = createStore();

      store.ensure('p-other', ['members']);
      await flush();

      expect(listMembers).toHaveBeenCalledWith('p-other');
      expect(store.options('p-other', 'members')).toEqual([{ id: 'u9', name: 'Zoe' }]);
    });

    it('does not refetch already-cached kinds', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      store.ensure('p1', ['statuses']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent ensure() calls for the same kind', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      store.ensure('p1', ['statuses']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(1);
    });

    it('caches per project — different projects fetch separately', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      store.ensure('p2', ['statuses']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(2);
      expect(store.options('p1', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
      expect(store.options('p2', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
    });

    it('is a no-op for an empty projectId', () => {
      const store = createStore();

      store.ensure('', ['statuses']);

      expect(statusList).not.toHaveBeenCalled();
    });

    it('leaves the kind uncached on fetch errors so a later ensure() retries', async () => {
      statusList.mockReturnValue(throwError(() => new Error('boom')));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      expect(store.options('p1', 'statuses')).toEqual([]);

      // Retry succeeds
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));
      store.ensure('p1', ['statuses']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(2);
      expect(store.options('p1', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
    });
  });

  // ── invalidate() ─────────────────────────────────────────────────────────

  describe('invalidate', () => {
    it('drops the cache for one kind so the next ensure() refetches', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      store.invalidate('p1', 'statuses');
      expect(store.options('p1', 'statuses')).toEqual([]);

      store.ensure('p1', ['statuses']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(2);
      expect(store.options('p1', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
    });

    it('only drops the targeted kind and project', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));
      labelList.mockReturnValue(of([{ id: 'l1', name: 'bug' }]));

      const store = createStore();

      store.ensure('p1', ['statuses', 'labels']);
      store.ensure('p2', ['statuses']);
      await flush();

      store.invalidate('p1', 'statuses');

      expect(store.options('p1', 'statuses')).toEqual([]);
      expect(store.options('p1', 'labels')).toEqual([{ id: 'l1', name: 'bug' }]);
      expect(store.options('p2', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
    });

    it('is safe to call for a kind that was never loaded', () => {
      const store = createStore();

      expect(() => store.invalidate('p1', 'sprints')).not.toThrow();
      expect(store.options('p1', 'sprints')).toEqual([]);
    });
  });

  // ── Full-DTO entity cache ─────────────────────────────────────────────────

  describe('F2: full-DTO entity cache', () => {
    it('exposes full DTOs via statusEntities()/sprintEntities() and derives options from them', async () => {
      sprintList.mockReturnValue(of([{ id: 'sp1', name: 'Sprint 1', status: 'ACTIVE' }]));

      const store = createStore();

      store.ensure('p1', ['sprints']);
      await flush();

      expect(store.sprintEntities('p1')).toEqual([{ id: 'sp1', name: 'Sprint 1', status: 'ACTIVE' }]);
      expect(store.options('p1', 'sprints')).toEqual([{ id: 'sp1', name: 'Sprint 1' }]);
    });

    it('Overview → Board → Tasks: repeated ensure() across pages hits the cache (0 new requests)', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));
      sprintList.mockReturnValue(of([{ id: 'sp1', name: 'Sprint 1', status: 'FUTURE' }]));

      const store = createStore();

      // "Overview" page
      store.ensure('p1', ['sprints', 'statuses']);
      await flush();
      expect(statusList).toHaveBeenCalledTimes(1);
      expect(sprintList).toHaveBeenCalledTimes(1);

      // "Board" page — same kinds, same project
      store.ensure('p1', ['statuses', 'sprints', 'members']);
      // "Tasks" page — full reference set; statuses/sprints already cached
      store.ensure('p1', ['statuses', 'types', 'sprints', 'labels', 'members']);
      await flush();

      expect(statusList).toHaveBeenCalledTimes(1);
      expect(sprintList).toHaveBeenCalledTimes(1);
    });

    it('upsertEntity appends a new sprint and replaces an updated one', async () => {
      sprintList.mockReturnValue(of([{ id: 'sp1', name: 'Sprint 1', status: 'FUTURE' }]));

      const store = createStore();

      store.ensure('p1', ['sprints']);
      await flush();

      // Create: appended
      store.upsertEntity('p1', 'sprints', { id: 'sp2', name: 'Sprint 2', status: 'FUTURE' });
      expect(store.sprintEntities('p1').map((s) => s.id)).toEqual(['sp1', 'sp2']);

      // Update: replaced in place (no duplicate)
      store.upsertEntity('p1', 'sprints', { id: 'sp1', name: 'Renamed', status: 'FUTURE' });

      const list = store.sprintEntities('p1');

      expect(list).toHaveLength(2);
      expect(list.find((s) => s.id === 'sp1')?.name).toBe('Renamed');
    });

    it('upsertEntity is a no-op for a kind that is not cached yet', () => {
      const store = createStore();

      expect(() => store.upsertEntity('p1', 'sprints', { id: 'sp9', name: 'X' })).not.toThrow();
      expect(store.sprintEntities('p1')).toEqual([]);
    });

    it('tracks the in-flight state per kind', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      // Loading flag is set SYNCHRONOUSLY when the fetch starts...
      expect(store.isLoading('p1', 'statuses')).toBe(true);

      await flush();

      // ...and cleared once the response is cached.
      expect(store.isLoading('p1', 'statuses')).toBe(false);
      expect(store.statusEntities('p1')).toEqual([{ id: 's1', name: 'TODO' }]);
    });
  });

  // ── The memoised derived views are bounded and dropped on invalidate ──
  describe('derived-view cache', () => {
    /**
     * White-box read of the derived cache. The property under test ("this cache
     * does not grow without bound") is about the size of a private map, so it
     * cannot be observed through the public API; the alternative — asserting a
     * number of projects — would pin the limit instead of the property.
     */
    function derivedViewCount(store: ProjectRefStore): number {
      const cache = (store as unknown as { derivedCache: Map<string, unknown> }).derivedCache;

      return cache.size;
    }

    it('does not grow without bound as more projects are visited', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      // Visit far more distinct projects than any bound could plausibly allow.
      for (let i = 0; i < 500; i++) {
        store.ensure(`p${i}`, ['statuses']);
      }

      await flush();

      // A view is memoised on the first READ, so the session has to read them.
      for (let i = 0; i < 500; i++) {
        store.options(`p${i}`, 'statuses');
      }

      expect(derivedViewCount(store)).toBeLessThan(500);
      // …and the data is still correct for a project whose view was evicted.
      expect(store.options('p0', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
    });

    it('invalidate() drops the derived view of the kind it dropped', async () => {
      statusList.mockReturnValue(of([{ id: 's1', name: 'TODO' }]));

      const store = createStore();

      store.ensure('p1', ['statuses']);
      await flush();

      // A view is memoised on the first READ, not on the fetch.
      expect(store.options('p1', 'statuses')).toEqual([{ id: 's1', name: 'TODO' }]);
      expect(derivedViewCount(store)).toBe(1);

      store.invalidate('p1', 'statuses');

      expect(derivedViewCount(store)).toBe(0);
    });
  });
});
