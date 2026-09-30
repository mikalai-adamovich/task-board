import { Component, computed, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import { lucideRows3, lucideShield, lucideUserPlus } from '@ng-icons/lucide';
import { finalize, tap } from 'rxjs';
import { form, FormRoot, FormField, schema, required } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import { TenantClient } from '@services/tenant-client';
import { AuthStore } from '@stores/auth-store';
import { TenantStore } from '@stores/tenant-store';
import { PreferencesStore } from '@stores/preferences-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { MemberTable } from '@app/shared/member-table/member-table';
import type { MemberEditChange, MemberRow } from '@app/shared/member-table/member-table';
import { useMemberTable } from '@app/shared/member-list/member-table';
import { injectUndoToasts } from '@app/shared/utils/undo-toast';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { hasMinTenantRole } from '@app/shared/utils/role-utils';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { InvitationStatus, MemberStatus, TenantRole } from '@task-board/shared';
import type { TenantMember } from '@task-board/shared';
import { AUTO_PAGE_SIZE_SENTINEL } from '@app/shared/auto-table/auto-page-size';
import { useTableDensity } from '@app/shared/auto-table/table-density';

interface InviteFormModel {
  email: string;
  role: string;
}

@Component({
  selector: 'ui-tenant-member-list',
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
  providers: [provideIcons({ lucideUserPlus, lucideShield, lucideRows3 })],
  templateUrl: './tenant-member-list.html',
})
export class TenantMemberList implements OnInit, OnDestroy {
  private readonly notify = injectUndoToasts();
  private readonly tenantClient = inject(TenantClient);
  private readonly authStore = inject(AuthStore);
  private readonly tenantStore = inject(TenantStore);
  private readonly route = inject(ActivatedRoute);
  private queryParamsSub?: Subscription;
  /**
   * Resolved tenant id — always derived from the tenant context (slug → tenant via the
   * `tenantGuard` + {@link TenantStore}), never from a raw route param (V1-10/V2-1).
   */
  private readonly tenantId = computed(() => this.tenantStore.activeTenant()?.id ?? '');
  /** Guard: until the context resolves, no requests fire and actions stay disabled. */
  private readonly hasContext = computed(() => this.tenantId() !== '');
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
  private readonly members = signal<TenantMember[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  private readonly showInviteDialog = signal(false);
  protected readonly TenantRole = TenantRole;
  protected readonly roles = Object.values(TenantRole).filter((role) => role !== TenantRole.OWNER);
  private readonly model = signal<InviteFormModel>({ email: '', role: TenantRole.MEMBER });
  protected readonly inviteForm = form(
    this.model,
    schema<InviteFormModel>((field) => {
      required(field.email, { message: 'validation.emailRequired' });
      required(field.role, { message: 'validation.roleRequired' });
    }),
    {
      submission: {
        action: async (f) => {
          if (!this.hasContext()) return;

          this.error.set('');

          const modelValue = this.model();

          this.tenantClient.inviteMember(this.tenantId(), modelValue.email, modelValue.role).subscribe({
            next: () => {
              this.showInviteDialog.set(false);
              f().reset({ email: '', role: TenantRole.MEMBER });
              this.loadMembers();
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
  private readonly removingUserId = signal<string | null>(null);
  private readonly actioningUserId = signal<string | null>(null);
  /** Only Owner/Tenant Admin may manage members (mirrors server RBAC). */
  protected readonly canManage = computed(() => hasMinTenantRole(this.authStore.tenantRole(), TenantRole.ADMIN));
  /**
   * Shared sort / column-filter / pagination machinery (see shared/member-list).
   * Filter and sort state is synced to URL query params.
   */
  private readonly table = useMemberTable<TenantMember>({
    source: this.members,
    filters: {
      name: { matches: (m, q) => (m.displayName ?? m.email ?? m.userId ?? '').toLowerCase().includes(q) },
      email: { matches: (m, q) => (m.email ?? '').toLowerCase().includes(q) },
      role: { matches: (m, q) => m.role === q },
      status: { matches: (m, q) => m.status === q },
      expiresAt: { matches: (m, q) => (m.expiresAt ?? '').toLowerCase().includes(q) },
    },
    sorters: {
      name: (m) => m.displayName ?? m.email ?? m.userId ?? '',
      email: (m) => m.email ?? '',
      role: (m) => m.role,
      status: (m) => m.status,
      expiresAt: (m) => m.expiresAt ?? '',
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
      status: m.status,
      invitationStatus: m.invitation?.status ?? null,
      expiresAt: m.expiresAt,
    })),
  );
  /** Current column-filter snapshot passed down to the shared table. */
  protected readonly filterValues = computed<Record<string, string>>(() => ({
    name: this.table.getFilterValue('name'),
    email: this.table.getFilterValue('email'),
    role: this.table.getFilterValue('role'),
    status: this.table.getFilterValue('status'),
    expiresAt: this.table.getFilterValue('expiresAt'),
  }));

  protected onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showInviteDialog.set(false);
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
    // V1-10/V2-1 guard: never fetch without a resolved tenant id (`tenants/undefined`)
    if (!this.hasContext()) {
      this.members.set([]);
      this.loading.set(false);

      return;
    }

    this.loading.set(true);
    this.tenantClient
      .listMembers(this.tenantId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (members) => {
          this.members.set(members);
        },
      });
  }

  /**
   * Full member edit (role + name/email/expiration). The response is
   * the enriched member — it replaces the local row so profile changes show up.
   */
  protected onMemberChange(change: MemberEditChange): void {
    const { row, role, name, email, expiresAt } = change;

    if (!row.userId || !this.hasContext()) return;

    // Pure role no-op (the dialog already suppresses full no-ops)
    if (name === undefined && email === undefined && expiresAt === undefined && role === row.role) return;

    const previous = this.members();

    this.members.update((list) =>
      list.map((m) =>
        m.userId === row.userId
          ? {
              ...m,
              role: role as TenantRole,
              displayName: name ?? m.displayName,
              email: email ?? m.email,
              expiresAt: expiresAt ?? null,
            }
          : m,
      ),
    );

    this.tenantClient
      .updateMember(this.tenantId(), row.userId, {
        role,
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
      .subscribe({
        next: (updated) => {
          this.members.update((list) => list.map((m) => (m.userId === row.userId ? updated : m)));
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

    this.removingUserId.set(row.userId);

    this.tenantClient
      .removeMember(this.tenantId(), row.userId)
      .pipe(finalize(() => this.removingUserId.set(null)))
      .subscribe({
        next: () => {
          this.members.update((list) => list.filter((m) => m.userId !== row.userId));
          this.notify.success('toasts.deleted');
        },
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }

  /**
   * Revoke dispatch (V2-7): a PENDING invitation is revoked via the dedicated
   * invitation route; an ACTIVE membership via revoke-access.
   */
  protected revokeAccess(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    const userId = row.userId;
    const isPendingInvitation = row.invitationStatus === InvitationStatus.PENDING;

    this.actioningUserId.set(userId);

    const request$ = isPendingInvitation
      ? this.tenantClient.revokeInvitation(this.tenantId(), userId)
      : this.tenantClient.revokeAccess(this.tenantId(), userId);

    request$.pipe(finalize(() => this.actioningUserId.set(null))).subscribe({
      next: () => {
        this.loadMembers();
        // Undo restores a revoked ACTIVE membership. A revoked
        // PENDING invitation has no compensating restore op — re-sending it is
        // the separate reinvite flow — so no undo is offered there.
        if (!isPendingInvitation) {
          this.notify.successWithUndo('toasts.updated', () =>
            this.tenantClient.restoreMembership(this.tenantId(), userId).pipe(tap(() => this.loadMembers())),
          );
        }
      },
      error: (err) => {
        this.notify.error(getErrorMessage(err));
      },
    });
  }

  protected restoreMembership(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    this.actioningUserId.set(row.userId);
    this.tenantClient
      .restoreMembership(this.tenantId(), row.userId)
      .pipe(finalize(() => this.actioningUserId.set(null)))
      .subscribe({
        next: () => {
          this.members.update((list) =>
            list.map((m) => (m.userId === row.userId ? { ...m, status: MemberStatus.ACTIVE } : m)),
          );
        },
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }

  protected reinviteMember(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    this.actioningUserId.set(row.userId);
    this.tenantClient
      .reinviteMember(this.tenantId(), row.userId)
      .pipe(finalize(() => this.actioningUserId.set(null)))
      .subscribe({
        next: () => {
          this.loadMembers();
        },
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }

  protected resendInvitation(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    this.actioningUserId.set(row.userId);
    this.tenantClient
      .resendInvitation(this.tenantId(), row.userId)
      .pipe(finalize(() => this.actioningUserId.set(null)))
      .subscribe({
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }

  protected hardDeleteMember(row: MemberRow): void {
    if (!row.userId || !this.hasContext()) return;

    this.actioningUserId.set(row.userId);
    this.tenantClient
      .hardDeleteMember(this.tenantId(), row.userId)
      .pipe(finalize(() => this.actioningUserId.set(null)))
      .subscribe({
        next: () => {
          this.members.update((list) => list.filter((m) => m.userId !== row.userId));
        },
        error: (err) => {
          this.notify.error(getErrorMessage(err));
        },
      });
  }
}
