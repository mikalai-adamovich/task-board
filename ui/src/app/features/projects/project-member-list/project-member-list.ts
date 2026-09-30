import { Component, computed, inject, input, signal, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucideRows3, lucideUserPlus } from '@ng-icons/lucide';
import { finalize, tap } from 'rxjs';
import { form, FormRoot, FormField, schema, required } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { PreferencesStore } from '@stores/preferences-store';
import { canManageProject } from '@app/shared/utils/role-utils';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { MemberTable } from '@app/shared/member-table/member-table';
import type { MemberRow } from '@app/shared/member-table/member-table';
import { useMemberTable } from '@app/shared/member-list/member-table';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { ProjectRole } from '@task-board/shared';
import type { ProjectMember } from '@task-board/shared';
import { AUTO_PAGE_SIZE_SENTINEL } from '@app/shared/auto-table/auto-page-size';
import { useTableDensity } from '@app/shared/auto-table/table-density';

interface AddMemberFormModel {
  userId: string;
  role: string;
}

@Component({
  selector: 'ui-project-member-list',
  imports: [
    FieldControl,
    MemberTable,
    FormRoot,
    FormField,
    TranslocoPipe,
    NgIcon,
    HlmAlertImports,
    HlmButtonImports,
    HlmDialogImports,
    HlmFieldImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmSpinnerImports,
  ],
  providers: [provideIcons({ lucideUserPlus, lucideRows3 })],
  templateUrl: './project-member-list.html',
})
export class ProjectMemberList implements OnInit, OnDestroy {
  private readonly notify = injectUndoToasts();
  private readonly projectClient = inject(ProjectClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly route = inject(ActivatedRoute);
  private queryParamsSub?: Subscription;
  /** Bound via withComponentInputBinding() — receives project key from route */
  readonly projectKey = input<string>();
  /**
   * Resolved project UUID from the store (loaded by `projectGuard`) — never a raw route
   * param, so direct URL entry cannot produce an undefined id (V1-10/V2-1 family).
   */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /** Guard: until the context resolves, no requests fire and actions stay disabled. */
  private readonly hasContext = computed(() => this.projectId() !== '');
  /** Auto page-size preference (sentinel 0) shared with the tasks table. */
  private readonly preferencesStore = inject(PreferencesStore);
  protected readonly isAutoMode = computed(() => this.preferencesStore.pageSize() === AUTO_PAGE_SIZE_SENTINEL);
  /** Device-local table density toggle for the member table. */
  private readonly density = useTableDensity();
  protected readonly isCompact = this.density.compact;
  protected readonly toggleDensity = this.density.toggle;
  /** Measured member-table wrapper height feeding the Auto page size. */
  private readonly autoHeight = signal(0);
  /** Measured row pitch feeding the Auto page size. */
  private readonly autoRowHeight = signal(0);
  private readonly members = signal<ProjectMember[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly removingUserId = signal<string | null>(null);
  private readonly showAddMember = signal(false);
  protected readonly projectRoles = Object.values(ProjectRole).filter((role) => role !== ProjectRole.PROJECT_ADMIN);
  /** Only PROJECT_ADMIN+ (project) / ADMIN+ (tenant) may manage members (mirrors server RBAC). */
  protected readonly canManage = computed(() => {
    return canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole());
  });
  /**
   * Shared sort / column-filter / pagination machinery (see shared/member-list).
   * Filter and sort state is synced to URL query params.
   */
  private readonly table = useMemberTable<ProjectMember>({
    source: this.members,
    filters: {
      name: { matches: (m, q) => (m.displayName ?? m.userId).toLowerCase().includes(q) },
      email: { matches: (m, q) => (m.email ?? '').toLowerCase().includes(q) },
      role: { matches: (m, q) => m.role === q },
    },
    sorters: {
      name: (m) => m.displayName ?? m.userId,
      email: (m) => m.email ?? '',
      role: (m) => m.role,
    },
    load: () => this.loadMembers(),
    autoAvailableHeight: this.autoHeight,
    autoRowHeight: this.autoRowHeight,
  });
  protected readonly page = this.table.page;
  protected readonly pageSize = this.table.pageSize;
  protected readonly total = this.table.total;
  protected readonly totalPages = this.table.totalPages;
  protected readonly sortField = this.table.sortField;
  protected readonly sortDirection = this.table.sortDirection;
  /** Rows for the shared table (already sorted/filtered/paginated). */
  protected readonly tableRows = computed<MemberRow[]>(() =>
    this.table.paginated().map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      email: m.email,
      role: m.role,
    })),
  );
  /** Current column-filter snapshot passed down to the shared table. */
  protected readonly filterValues = computed<Record<string, string>>(() => ({
    name: this.table.getFilterValue('name'),
    email: this.table.getFilterValue('email'),
    role: this.table.getFilterValue('role'),
  }));
  private readonly memberModel = signal<AddMemberFormModel>({ userId: '', role: ProjectRole.EDITOR });
  protected readonly addMemberForm = form(
    this.memberModel,
    schema<AddMemberFormModel>((field) => {
      required(field.userId, { message: 'validation.userIdRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          if (!this.hasContext()) return;

          this.error.set('');

          this.projectClient
            .addMember(this.projectId(), this.memberModel().userId, this.memberModel().role as ProjectRole)
            .subscribe({
              next: () => {
                this.loadMembers();
                this.showAddMember.set(false);
                f().reset({ userId: '', role: ProjectRole.EDITOR });
                this.notify.success('toasts.created');
              },
              error: (err) => {
                this.error.set(getErrorMessage(err));
              },
            });
        },
      },
    },
  );

  onAddMemberDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showAddMember.set(false);
    }
  }

  ngOnInit(): void {
    // Sync URL query params → table state, then load
    this.queryParamsSub = this.route.queryParams.subscribe((params) => {
      this.table.syncFromParams(params);
    });
  }

  ngOnDestroy(): void {
    this.queryParamsSub?.unsubscribe();
  }

  private loadMembers(): void {
    // V1-10/V2-1 guard: never fetch without a resolved project id
    if (!this.hasContext()) {
      this.members.set([]);
      this.loading.set(false);

      return;
    }

    this.loading.set(true);

    this.projectClient
      .listMembers(this.projectId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (members) => {
          this.members.set(members);
        },
      });
  }

  /** Optimistic role update with rollback + error toast on failure. */
  protected changeRole(row: MemberRow, newRole: string): void {
    if (!row.userId || !newRole || newRole === row.role || !this.hasContext()) return;

    const previous = this.members();

    this.members.update((list) =>
      list.map((m) => (m.userId === row.userId ? { ...m, role: newRole as ProjectRole } : m)),
    );

    this.projectClient.updateMemberRole(this.projectId(), row.userId, newRole).subscribe({
      next: () => {
        this.notify.success('toasts.updated');
      },
      error: (err) => {
        this.members.set(previous); // rollback
        this.notify.error(getErrorMessage(err));
      },
    });
  }

  protected removeMember(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    const userId = row.userId;
    const previousRole = row.role;

    this.removingUserId.set(userId);

    this.projectClient
      .removeMember(this.projectId(), userId)
      .pipe(finalize(() => this.removingUserId.set(null)))
      .subscribe({
        next: () => {
          this.loadMembers();
          // Undo re-adds the member with their previous role.
          this.notify.successWithUndo('toasts.deleted', () =>
            this.projectClient.addMember(this.projectId(), userId, previousRole).pipe(tap(() => this.loadMembers())),
          );
        },
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }
}
