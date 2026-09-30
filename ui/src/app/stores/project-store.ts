import { Service, signal, computed, inject, effect, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { ProjectRole, TenantRole } from '@task-board/shared';
import type { Project, ProjectMember } from '@task-board/shared';

/**
 * Signal-based project context store.
 * Tracks the currently active project, the user's role within it,
 * and related project metadata (members, etc.).
 */
@Service()
export class ProjectStore {
  private readonly projectClient = inject(ProjectClient);
  private readonly authStore = inject(AuthStore);
  /** Watched for session isolation — a null active tenant means logout. */
  private readonly tenantStore = inject(TenantStore);
  readonly activeProject = signal<Project | null>(null);
  readonly members = signal<ProjectMember[]>([]);
  /**
   * Project id the current `members` value was loaded for — null when nothing is
   * loaded (or the context was cleared).
   *
   * The list loads in the BACKGROUND (`loadProjectByKey` does not await it), so an
   * empty `members` array is ambiguous: "not loaded yet" and "loaded, nobody in it"
   * are the same value. Consumers that must not confuse the two (ProjectRefStore
   * caches by key, and `[]` is truthy) need this unambiguous answer.
   */
  readonly loadedMembersFor = signal<string | null>(null);
  readonly loading = signal(false);
  // ─── Tenant-scoped project-list cache (shared by TenantHome + ProjectSwitcher) ──
  /** tenantId → project list (session-scoped; cleared on logout) */
  private readonly projectLists = signal<Record<string, Project[]>>({});
  /** tenantId → whether the list request is in flight */
  private readonly listLoading = signal<Record<string, boolean>>({});
  /** tenantId → in-flight request promise (concurrent-caller dedupe) */
  private readonly listInFlight = new Map<string, Promise<Project[]>>();
  /** projectId → in-flight member request promise (concurrent-caller dedupe) */
  private readonly membersInFlight = new Map<string, Promise<void>>();
  /** Whether a project is currently loaded */
  readonly hasProject = computed(() => this.activeProject() !== null);
  /**
   * Effective project role of the current user, derived reactively.
   *
   * Tenant OWNER/ADMIN bypass project membership (mirrors the server's RBAC
   * bypass formerly applied by projectGuard). For tenant MEMBERs the role
   * resolves from the members list — which loads in the background (see
   * loadProjectByKey), so this computed flips from null to the real role when
   * members arrive. All consumers read it through computeds, so the late
   * resolution is safe.
   */
  readonly projectRole = computed<ProjectRole | null>(() => {
    if (!this.activeProject()) return null;

    const tenantRole = this.authStore.tenantRole();

    if (tenantRole === TenantRole.OWNER || tenantRole === TenantRole.ADMIN) {
      return ProjectRole.PROJECT_ADMIN;
    }

    const userId = this.authStore.currentUser()?.id;

    if (!userId) return null;

    return this.members().find((member) => member.userId === userId)?.role ?? null;
  });

  // `loadProject(projectId)` was removed as dead code — the project context is
  // loaded through the route resolver (which then calls the individual loaders),
  // so this entry point had no caller and duplicated that flow.

  /** Load the project context by key within a tenant. */
  async loadProjectByKey(tenantId: string, key: string): Promise<Project> {
    this.loading.set(true);
    try {
      const project = await firstValueFrom(this.projectClient.getByKey(tenantId, key));

      this.activeProject.set(project);
      // Members are NOT awaited: the navigation decision (projectGuard) never
      // depends on them, so they load in the background and the reactive
      // `projectRole` computed updates when they arrive. This removes one
      // sequential HTTP round-trip from the deep-link critical path.
      void this.loadMembers(project.id);
      return project;
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Load project members in the background (non-critical for navigation).
   * Errors are swallowed — consumers degrade gracefully without members.
   *
   * Concurrent callers share ONE request: a component that "ensures" the member
   * list while the background load is still outstanding must not turn every
   * ensure() into another request.
   */
  loadMembers(projectId: string): Promise<void> {
    const inFlight = this.membersInFlight.get(projectId);

    if (inFlight) return inFlight;

    const request = this.fetchMembers(projectId).finally(() => {
      this.membersInFlight.delete(projectId);
    });

    this.membersInFlight.set(projectId, request);

    return request;
  }

  private async fetchMembers(projectId: string): Promise<void> {
    try {
      const members = await firstValueFrom(this.projectClient.listMembers(projectId));

      // Stale-response guard: the user may have navigated to another project
      // while this request was in flight — never overwrite the new context.
      if (this.activeProject()?.id !== projectId) return;

      this.members.set(members);
      this.loadedMembersFor.set(projectId);
    } catch {
      // Members are non-critical for project context. `loadedMembersFor` is left
      // unset, so a later caller still knows the list was never obtained.
    }
  }

  /** Clear project context (e.g. when switching projects) */
  clearProject(): void {
    this.activeProject.set(null);
    this.members.set([]);
    this.loadedMembersFor.set(null);
  }

  // ─── Project-list cache API ─────────────────────────────────────────────────

  /** Reactive read of the cached list for a tenant (empty while loading/uncached). */
  projectList(tenantId: string): Project[] {
    return this.projectLists()[tenantId] ?? [];
  }

  /** Whether the tenant's project-list request is currently in flight. */
  isProjectListLoading(tenantId: string): boolean {
    return this.listLoading()[tenantId] ?? false;
  }

  /**
   * Ensure the tenant's project list is loaded.
   * Dedupes concurrent callers into ONE HTTP request and caches the result
   * until invalidated. Failures are not cached — a later call retries.
   */
  async ensureProjectList(tenantId: string): Promise<Project[]> {
    if (!tenantId) return [];

    const cached = this.projectLists()[tenantId];

    if (cached) return cached;

    const inFlight = this.listInFlight.get(tenantId);

    if (inFlight) return inFlight;

    this.listLoading.update((map) => ({ ...map, [tenantId]: true }));

    const request = firstValueFrom(this.projectClient.list())
      .then((projects) => {
        // Stale-response guard: logout (session clear) empties the in-flight
        // map while this request is on the wire — a late response must NOT
        // repopulate the cleared cache (session isolation).
        if (!this.listInFlight.has(tenantId)) return projects;

        this.projectLists.update((map) => ({ ...map, [tenantId]: projects }));

        return projects;
      })
      .finally(() => {
        this.listInFlight.delete(tenantId);
        this.listLoading.update((map) => ({ ...map, [tenantId]: false }));
      });

    this.listInFlight.set(tenantId, request);

    return request;
  }

  /** Drop the cached list for one tenant (or all tenants) — the next ensure refetches. */
  invalidateProjectList(tenantId?: string): void {
    if (!tenantId) {
      this.projectLists.set({});
      this.listLoading.set({});

      return;
    }

    const nextLists: Record<string, Project[]> = {};
    const nextLoading: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(this.projectLists())) {
      if (key !== tenantId) nextLists[key] = value;
    }

    for (const [key, value] of Object.entries(this.listLoading())) {
      if (key !== tenantId) nextLoading[key] = value;
    }

    this.projectLists.set(nextLists);
    this.listLoading.set(nextLoading);
  }

  /** Patch a project into its tenant's cached list (create/update/lifecycle mutations). */
  upsertProject(project: Project): void {
    this.projectLists.update((map) => {
      const list = map[project.tenantId];

      if (!list) return map;

      const exists = list.some((p) => p.id === project.id);

      return {
        ...map,
        [project.tenantId]: exists ? list.map((p) => (p.id === project.id ? project : p)) : [...list, project],
      };
    });
  }

  constructor() {
    // F4 session isolation: when the active tenant DISAPPEARS (logout —
    // AuthStore.logout() clears TenantStore), drop ALL tenant-scoped lists so a
    // later login as a different user can never observe stale projects.
    // A null→null "transition" (cold start before bootstrap selects a tenant)
    // is NOT a logout — clearing there would wipe a context that is legitimately
    // being loaded — so the clear only fires on a real non-null → null edge.
    // Tenant switching needs no action: lists are keyed by tenantId, so data
    // is isolated between workspaces by construction.
    let hadActiveTenant = untracked(() => this.tenantStore.activeTenant() !== null);

    effect(() => {
      const active = this.tenantStore.activeTenant();

      if (active) {
        hadActiveTenant = true;

        return;
      }

      if (!hadActiveTenant) return;

      hadActiveTenant = false;
      this.projectLists.set({});
      this.listLoading.set({});
      this.listInFlight.clear();
      this.clearProject();
    });
  }
}
