import { DatePipe } from '@angular/common';
import {
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideBan,
  lucideFilter,
  lucideMail,
  lucidePencil,
  lucideRefreshCw,
  lucideRotateCcw,
  lucideRows3,
  lucideSkull,
  lucideTrash2,
} from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { InvitationStatus, MemberStatus, TenantRole } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';
import { Pagination } from '@app/shared/pagination/pagination';
import { PreferencesStore } from '@stores/preferences-store';
import { memberStatusBadgeVariant, roleBadgeVariant } from '@app/constants/priority';
import { initials } from '@app/shared/utils/error-utils';
import { computeAutoPageSize, rowHeightForDensity } from '@app/shared/auto-table/auto-page-size';
import { useAutoRowMeasurement } from '@app/shared/auto-table/use-auto-row-measurement';

/** Normalized row model consumed by {@link MemberTable} — both member shapes map onto it. */
export interface MemberRow {
  userId: string;
  // `| undefined` — rows are built from shared `ProjectMember` /
  // `TenantMember` projections whose `email`/`displayName` are validated-but-absent
  // optionals (explicit `undefined`), so the row type must accept that value.
  displayName?: string | null | undefined;
  email?: string | null | undefined;
  role: string;
  /** Tenant variant only (`MemberStatus`). */
  status?: string | undefined;
  /** Tenant variant only (`InvitationStatus`). */
  invitationStatus?: string | null | undefined;
  /** Membership expiration (ISO 8601, tenant variant only, null = never). */
  expiresAt?: string | null | undefined;
}

/** Payload of the {@link MemberTable.memberChange} output. */
export interface MemberEditChange {
  row: MemberRow;
  role: string;
  /** Tenant variant only — updates the underlying user's display name. */
  name?: string;
  /** Tenant variant only — updates the underlying user's email. */
  email?: string;
  /** Tenant variant only — ISO datetime or null (clears the expiration). */
  expiresAt?: string | null;
}

interface ColumnDef {
  field: string;
  labelKey: string;
  filterType: 'text' | 'select' | 'none';
  popoverWidth: string;
  placeholderKey?: string;
  selectAllLabelKey?: string;
}

/** Display-name i18n keys for known roles; unknown roles fall back to the raw enum value. */
const ROLE_LABEL_KEYS: Record<string, string> = {
  [TenantRole.OWNER]: 'members.roleOwner',
  [TenantRole.ADMIN]: 'members.roleAdmin',
  [TenantRole.MEMBER]: 'members.roleMember',
  PROJECT_ADMIN: 'members.roleProjectAdmin',
  EDITOR: 'members.roleEditor',
  VIEWER: 'members.roleViewer',
};

/** Parse an ISO datetime string into a local Date (undefined for null/empty). */
function isoToDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;

  return new Date(value);
}

/**
 * Convert the picked expiration date to an end-of-day ISO datetime —
 * the member keeps access for the whole selected day and is revoked from the next day on.
 */
function toEndOfDayIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();
}

/**
 * Shared member table used by BOTH the tenant members and project members pages.
 *
 * Columns: User (avatar + name), Email, Role, [tenant-only: Access/Invitation status], Actions.
 * Actions: Edit (small dialog with role select + confirm) and Remove (confirm dialog);
 * the tenant variant adds Resend/Revoke (pending invitations), Reinvite (expired/revoked
 * invitations), Restore (revoked without pending invitation) and permanent delete.
 *
 * The host page owns data fetching, permissions and the actual API calls — this component
 * only renders state and emits intents. Sort/filter/pagination state is passed down and
 * changes are emitted back so pages can keep their URL-synced `useMemberTable` machinery.
 */
@Component({
  selector: 'ui-member-table',
  imports: [
    ConfirmDialog,
    DatePipe,
    NgIcon,
    Pagination,
    TranslocoPipe,
    HlmAlertImports,
    HlmAvatarImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmDatePickerImports,
    HlmDialogImports,
    HlmFieldImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmPopoverImports,
    HlmSelectImports,
    HlmSpinnerImports,
    HlmTableImports,
    HlmTooltipImports,
  ],
  providers: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideBan,
      lucideFilter,
      lucideMail,
      lucidePencil,
      lucideRefreshCw,
      lucideRotateCcw,
      lucideRows3,
      lucideSkull,
      lucideTrash2,
    }),
  ],
  templateUrl: './member-table.html',
  // The host element is a flex item of the page's full-height column —
  // flexing it lets the inner table wrapper stretch and the pagination pin to the bottom.
  host: { class: 'flex min-h-0 w-full flex-1 flex-col' },
})
export class MemberTable {
  /** `'tenant'` adds the Access/Invitation status column and invitation lifecycle actions. */
  readonly variant = input.required<'tenant' | 'project'>();
  /** Rows to render (already filtered/sorted/paginated by the host page). */
  readonly rows = input.required<MemberRow[]>();
  /** Whether the current user may manage members (shows the Actions column). */
  readonly canManage = input(false);
  /**
   * Whether the Auto rows-per-page option is offered (full-height tables only).
   * When `isAuto` is set, the effective page size is derived from the measured wrapper height.
   */
  readonly autoEnabled = input(false);
  readonly isAuto = input(false);
  /**
   * Guard for V1-10/V2-1: when the tenant/project id could not be resolved from the
   * store context, an error state is shown instead of the table and no requests fire.
   */
  readonly contextMissing = input(false);
  /** Assignable roles for the Edit dialog and the Role column filter. */
  readonly roles = input<string[]>([]);
  /** Row-level action in flight (spinner + disabled buttons). */
  readonly busyUserId = input<string | null>(null);
  /** Row-level removal in flight. */
  readonly removingUserId = input<string | null>(null);
  readonly page = input(1);
  readonly pageSize = input(20);
  readonly total = input(0);
  readonly totalPages = input(1);
  /** Measured wrapper height forwarded to the host page for Auto pagination. */
  readonly rowsHeightChange = output<number>();
  /** Measured row pitch forwarded to the host page for an exact Auto page size. */
  readonly rowHeightChange = output<number>();
  /** The user picked the Auto option in the rows-per-page selector. */
  readonly autoPageSizeChange = output();
  readonly sortField = input('');
  readonly sortDirection = input<'asc' | 'desc'>('asc');
  /** Current column-filter values keyed by field name. */
  readonly filters = input<Record<string, string>>({});
  readonly sortToggle = output<string>();
  readonly filterChange = output<{ field: string; value: string }>();
  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();
  /** Confirmed member edit (role + tenant: name/email/expiration) from the Edit dialog. */
  readonly memberChange = output<MemberEditChange>();
  /** Confirmed removal (after the confirm dialog). */
  readonly remove = output<MemberRow>();
  /** Tenant variant: resend a pending invitation. */
  readonly resend = output<MemberRow>();
  /** Tenant variant: revoke access (active member or pending invitation). */
  readonly revoke = output<MemberRow>();
  /** Tenant variant: restore a revoked membership without pending invitation. */
  readonly restore = output<MemberRow>();
  /** Tenant variant: reinvite after an expired/revoked invitation. */
  readonly reinvite = output<MemberRow>();
  /** Tenant variant: permanently delete a revoked/declined member. */
  readonly hardDelete = output<MemberRow>();
  private readonly i18n = inject(TranslocoService);
  /**
   * Device-local table density — owned by the HOST page (the toggle
   * lives in the page header) and passed down; compact mode shrinks vertical cell
   * padding via a class on the `<table>`, and the Auto math reacts through the
   * density-aware fallback row height.
   */
  readonly isCompact = input(false, { transform: booleanAttribute });
  /** Density-aware fallback row height used by the Auto page-size math */
  private readonly rowHeightPx = computed(() => rowHeightForDensity(this.isCompact()));
  /**
   * Measures this table's wrapper so Auto mode can derive its row count;
   * the height is forwarded to the host page which owns the effective page size.
   */
  private readonly measurement = useAutoRowMeasurement();
  private readonly availableRowsHeight = this.measurement.availableRowsHeight;
  /**
   * Effective row height for the Auto math: the REAL measured
   * body-row height when available (real rows are ~44px vs the 48px fallback —
   * using the fallback undercounts how many rows fit), otherwise the
   * density-aware constant.
   */
  private readonly effectiveRowHeightPx = computed(() => this.measurement.measuredRowHeight() || this.rowHeightPx());
  private readonly tableWrapRef = viewChild<ElementRef<HTMLDivElement>>('tableWrap');
  protected readonly initials = initials;
  protected readonly roleBadgeVariant = roleBadgeVariant;
  protected readonly memberStatusBadgeVariant = memberStatusBadgeVariant;
  protected readonly MemberStatus = MemberStatus;
  protected readonly InvitationStatus = InvitationStatus;
  private readonly editingRow = signal<MemberRow | null>(null);
  private readonly editRole = signal('');
  private readonly editName = signal('');
  private readonly editEmail = signal('');
  /** Picked expiration date in the Edit dialog (null = no expiration). */
  private readonly editExpiresAt = signal<Date | null>(null);
  private readonly rowToRemove = signal<MemberRow | null>(null);
  private readonly preferencesStore = inject(PreferencesStore);
  /** DatePipe token derived from the user's date format preference. */
  protected readonly dateFmt = this.preferencesStore.datePipeFormat;
  /** Active language passed as the DatePipe locale for localized month names */
  protected readonly lang = this.preferencesStore.language;
  /** Column definitions depend on the variant (tenant adds the status column). */
  private readonly columns = computed<ColumnDef[]>(() => {
    const cols: ColumnDef[] = [
      {
        field: 'name',
        labelKey: 'members.name',
        filterType: 'text',
        popoverWidth: 'w-56',
        placeholderKey: 'members.filterByName',
      },
      {
        field: 'email',
        labelKey: 'members.email',
        filterType: 'text',
        popoverWidth: 'w-56',
        placeholderKey: 'members.filterByEmail',
      },
      {
        field: 'role',
        labelKey: 'members.role',
        filterType: 'select',
        popoverWidth: 'w-48',
        selectAllLabelKey: 'members.allRoles',
      },
    ];

    if (this.variant() === 'tenant') {
      cols.push({
        field: 'status',
        labelKey: 'members.status',
        filterType: 'select',
        popoverWidth: 'w-48',
        selectAllLabelKey: 'members.allStatuses',
      });
      // Expiration date — display-only column (no filter popover)
      cols.push({
        field: 'expiresAt',
        labelKey: 'members.expiresAt',
        filterType: 'none',
        popoverWidth: 'w-48',
      });
    }

    return cols;
  });
  protected readonly colspan = computed(() => this.columns().length + (this.canManage() ? 1 : 0));
  /** Effective numeric page size — derived from the measured height in Auto mode. */
  protected readonly effectivePageSize = computed(() =>
    this.isAuto() ? computeAutoPageSize(this.availableRowsHeight(), this.effectiveRowHeightPx()) : this.pageSize(),
  );

  constructor() {
    // Measure the table wrapper so Auto mode derives its row count from real space
    effect(() => {
      this.measurement.observe(this.tableWrapRef()?.nativeElement, 'thead');
    });

    // Forward the measured height and row pitch whenever they change
    // (the host page owns the effective page size)
    effect(() => {
      if (!this.autoEnabled()) return;

      this.rowsHeightChange.emit(this.availableRowsHeight());
      this.rowHeightChange.emit(this.measurement.measuredRowHeight());
    });
  }
  protected readonly roleOptions = computed(() =>
    this.roles().map((role) => ({ value: role, label: this.roleLabel(role) })),
  );
  protected readonly statusOptions: { value: string; labelKey: string }[] = [
    { value: MemberStatus.ACTIVE, labelKey: 'members.statusActive' },
    { value: MemberStatus.ACCESS_REVOKED, labelKey: 'members.statusAccessRevoked' },
  ];

  /** Human-readable role label; unknown enum values render verbatim. */
  private roleLabel(role: string): string {
    const key = ROLE_LABEL_KEYS[role];

    return key ? this.i18n.translate(key) : role;
  }

  protected getFilterValue(field: string): string {
    return this.filters()[field] ?? '';
  }

  // ── Edit (member change) ───────────────────────────────────────

  protected openEdit(row: MemberRow): void {
    this.editingRow.set(row);
    this.editRole.set(row.role);
    this.editName.set(row.displayName ?? '');
    this.editEmail.set(row.email ?? '');
    this.editExpiresAt.set(isoToDate(row.expiresAt) ?? null);
  }

  protected onEditDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.editingRow.set(null);
    }
  }

  protected onEditExpirationChange(value: Date | null): void {
    this.editExpiresAt.set(value);
  }

  protected clearEditExpiration(): void {
    this.editExpiresAt.set(null);
  }

  protected confirmMemberChange(): void {
    const row = this.editingRow();

    this.editingRow.set(null);

    if (!row) return;

    if (this.variant() === 'tenant') {
      const role = this.editRole();
      const name = this.editName().trim();
      const email = this.editEmail().trim();
      const picked = this.editExpiresAt();
      const expiresAt = picked ? toEndOfDayIso(picked) : null;
      const unchanged =
        role === row.role &&
        name === (row.displayName ?? '') &&
        email === (row.email ?? '') &&
        expiresAt === (row.expiresAt ?? null);

      if (unchanged) return;

      this.memberChange.emit({ row, role, name, email, expiresAt });
    } else {
      const role = this.editRole();

      if (!role || role === row.role) return;

      this.memberChange.emit({ row, role });
    }
  }

  // ── Remove ─────────────────────────────────────────────────────

  protected confirmRemove(row: MemberRow): void {
    this.rowToRemove.set(row);
  }

  protected onRemoveDialogStateChange(open: boolean): void {
    if (!open) {
      this.rowToRemove.set(null);
    }
  }

  protected onRemoveConfirmed(): void {
    const row = this.rowToRemove();

    this.rowToRemove.set(null);

    if (row) {
      this.remove.emit(row);
    }
  }

  // ── Row predicates ─────────────────────────────────────────────

  protected isOwner(row: MemberRow): boolean {
    return row.role === TenantRole.OWNER;
  }

  /** The membership expiration date is on/after now (lazy revoke). */
  protected isExpired(row: MemberRow): boolean {
    return row.expiresAt !== null && row.expiresAt !== undefined && new Date(row.expiresAt).getTime() <= Date.now();
  }

  /** Revoked/expired invitation → Reinvite applies (pending ones only via the invitee). */
  protected hasExpiredOrRevokedInvitation(row: MemberRow): boolean {
    return row.invitationStatus === InvitationStatus.EXPIRED || row.invitationStatus === InvitationStatus.REVOKED;
  }

  protected canRestore(row: MemberRow): boolean {
    return row.status === MemberStatus.ACCESS_REVOKED && row.invitationStatus !== InvitationStatus.PENDING;
  }

  protected canRevoke(row: MemberRow): boolean {
    return row.status === MemberStatus.ACTIVE || row.invitationStatus === InvitationStatus.PENDING;
  }

  protected canHardDelete(row: MemberRow): boolean {
    return row.status === MemberStatus.ACCESS_REVOKED || row.invitationStatus === InvitationStatus.DECLINED;
  }
}
