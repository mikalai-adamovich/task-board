import { firstValueFrom } from 'rxjs';
/**
 * Tests for the shared MemberTable component.
 *
 * Covers:
 * - Variant rendering (project hides the status column, tenant shows it)
 * - Row rendering (name/email/role)
 * - Permission gating (Actions column only when canManage)
 * - Edit flow (open dialog → confirm emits roleChange)
 * - Remove flow (confirm dialog → remove emitted)
 * - Tenant-only actions visibility (resend/revoke/restore)
 * - Context-missing guard (V1-10/V2-1): error state instead of table
 * - Empty / loading states
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { PreferencesStore } from '@stores/preferences-store';
import { MemberTable } from './member-table';
import type { MemberRow } from './member-table';
import { clickUntil, settle } from '@app/shared/testing/zoneless';

const rows: MemberRow[] = [
  {
    userId: 'u1',
    displayName: 'Owner User',
    email: 'owner@example.com',
    role: 'OWNER',
    status: 'ACTIVE',
    invitationStatus: null,
  },
  {
    userId: 'u2',
    displayName: 'Member User',
    email: 'member@example.com',
    role: 'MEMBER',
    status: 'ACTIVE',
    invitationStatus: null,
  },
];
const pendingRow: MemberRow = {
  userId: 'u3',
  displayName: null,
  email: 'pending@example.com',
  role: 'MEMBER',
  status: 'ACTIVE',
  invitationStatus: 'PENDING',
};
const revokedRow: MemberRow = {
  userId: 'u4',
  displayName: 'Revoked User',
  email: 'revoked@example.com',
  role: 'MEMBER',
  status: 'ACCESS_REVOKED',
  invitationStatus: null,
};

describe('MemberTable', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;
  let fixture: ComponentFixture<MemberTable>;
  let el: HTMLElement;

  /**
   * Native `[title]` was replaced by the Spartan `hlmTooltip` directive,
   * which leaves no DOM attribute — action buttons are located via their icon instead.
   */
  function actionButton(iconName: string): HTMLButtonElement | null {
    return el.querySelector(`ng-icon[name="${iconName}"]`)?.closest('button') ?? null;
  }

  async function create(
    variant: 'tenant' | 'project',
    tableRows: MemberRow[] = rows,
    canManage = true,
    inputs: Record<string, unknown> = {},
  ): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } }), MemberTable],
      providers: [
        provideRouter([]),
        {
          provide: PreferencesStore,
          useValue: {
            datePipeFormat: () => 'yyyy-MM-dd',
            // Active language used as the DatePipe locale
            language: () => 'en',
          },
        },
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    fixture = TestBed.createComponent(MemberTable);

    const fixtureRef = fixture;

    fixtureRef.componentRef.setInput('variant', variant);
    fixtureRef.componentRef.setInput('rows', tableRows);
    fixtureRef.componentRef.setInput('canManage', canManage);
    fixtureRef.componentRef.setInput('roles', ['ADMIN', 'MEMBER']);

    for (const [key, value] of Object.entries(inputs)) {
      fixtureRef.componentRef.setInput(key, value);
    }

    await settle(fixtureRef);

    component = fixtureRef.componentInstance;
    el = fixtureRef.nativeElement as HTMLElement;
  }

  // ── Layout (full-height flex column) ─────────────────

  it('should put the full-height flex classes on the HOST element so the table stretches inside the page column', async () => {
    await create('tenant');

    const host: HTMLElement = fixture.nativeElement;

    expect(host.classList.contains('flex')).toBe(true);
    expect(host.classList.contains('flex-col')).toBe(true);
    expect(host.classList.contains('flex-1')).toBe(true);
    expect(host.classList.contains('min-h-0')).toBe(true);
  });

  // ── Rendering ──────────────────────────────────────────────────

  it('should render user name, email and role cells', async () => {
    await create('tenant');

    expect(el.textContent).toContain('Owner User');
    expect(el.textContent).toContain('owner@example.com');
    expect(el.textContent).toContain('member@example.com');
  });

  it('should render the status column only in the tenant variant', async () => {
    await create('tenant');
    expect(el.textContent).toContain('members.status');

    await create('project');
    expect(el.textContent).not.toContain('members.status');
  });

  it('should show the invitation-pending badge for pending invitations', async () => {
    await create('tenant', [...rows, pendingRow]);

    expect(el.textContent).toContain('members.invitationPending');
  });

  // ── Permission gating ──────────────────────────────────────────

  it('should hide the Actions column and buttons without canManage', async () => {
    await create('tenant', rows, false);

    expect(el.textContent).not.toContain('members.actions');
    expect(actionButton('lucidePencil')).toBeNull();
    expect(actionButton('lucideTrash2')).toBeNull();
  });

  it('should not render actions for the owner row', async () => {
    await create('tenant');

    const bodyRows = Array.from(el.querySelectorAll('tbody tr'));

    expect(bodyRows[0]?.querySelector('ng-icon[name="lucideTrash2"]')).toBeNull();
    expect(bodyRows[1]?.querySelector('ng-icon[name="lucideTrash2"]')).not.toBeNull();
  });

  // ── Edit flow ──────────────────────────────────────────────────

  it('should open the edit dialog and emit memberChange on confirm', async () => {
    await create('tenant');

    const emitted: unknown[] = [];

    component.memberChange.subscribe((v: unknown) => emitted.push(v));
    await clickUntil(
      () => (actionButton('lucidePencil') as HTMLButtonElement).click(),
      () => expect(component.editingRow()?.userId).toBe('u2'),
    );

    component.editRole.set('ADMIN');
    component.confirmMemberChange();

    expect(emitted).toEqual([
      { row: rows[1], role: 'ADMIN', name: 'Member User', email: 'member@example.com', expiresAt: null },
    ]);
    expect(component.editingRow()).toBeNull();
  });

  it('should not emit memberChange when nothing changed', async () => {
    await create('tenant');

    const emitted: unknown[] = [];

    component.memberChange.subscribe((v: unknown) => emitted.push(v));
    await clickUntil(
      () => (actionButton('lucidePencil') as HTMLButtonElement).click(),
      () => expect(component.editingRow()?.userId).toBe('u2'),
    );
    component.confirmMemberChange();

    expect(emitted).toEqual([]);
  });

  it('should emit a future expiresAt as end-of-day ISO on confirm (DEC-055)', async () => {
    await create('tenant');

    const emitted: { expiresAt?: string | null }[] = [];

    component.memberChange.subscribe((v: { expiresAt?: string | null }) => emitted.push(v));
    await clickUntil(
      () => (actionButton('lucidePencil') as HTMLButtonElement).click(),
      () => expect(component.editingRow()?.userId).toBe('u2'),
    );

    const picked = new Date(2030, 0, 1);

    component.editExpiresAt.set(picked);
    component.confirmMemberChange();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.expiresAt).toBe(new Date(2030, 0, 1, 23, 59, 59, 999).toISOString());
  });

  it('should render the Expiration column only in the tenant variant', async () => {
    await create('tenant');
    expect(el.textContent).toContain('members.expiresAt');

    await create('project');
    expect(el.textContent).not.toContain('members.expiresAt');
  });

  it('should show the Expired badge for a row whose expiration has passed', async () => {
    const expiredRow: MemberRow = {
      userId: 'u5',
      displayName: 'Expired User',
      email: 'expired@example.com',
      role: 'MEMBER',
      status: 'ACTIVE',
      invitationStatus: null,
      expiresAt: '2020-01-01T00:00:00.000Z',
    };

    await create('tenant', [...rows, expiredRow]);

    expect(el.textContent).toContain('members.expired');
  });

  // ── Remove flow ────────────────────────────────────────────────

  it('should require confirmation before emitting remove', async () => {
    await create('tenant');

    const emitted: MemberRow[] = [];

    component.remove.subscribe((v: MemberRow) => emitted.push(v));
    await clickUntil(
      () => (actionButton('lucideTrash2') as HTMLButtonElement).click(),
      () => expect(component.rowToRemove()?.userId).toBe('u2'),
    );
    expect(emitted).toEqual([]);

    component.onRemoveConfirmed();

    expect(emitted).toEqual([rows[1]]);
    expect(component.rowToRemove()).toBeNull();
  });

  // ── Tenant-only actions ────────────────────────────────────────

  it('should show resend/revoke for pending invitations', async () => {
    await create('tenant', [pendingRow]);

    expect(actionButton('lucideRefreshCw')).not.toBeNull();
    expect(actionButton('lucideBan')).not.toBeNull();
    expect(actionButton('lucideRotateCcw')).toBeNull();
  });

  it('should show restore for revoked members without pending invitation', async () => {
    await create('tenant', [revokedRow]);

    expect(actionButton('lucideRotateCcw')).not.toBeNull();
    expect(actionButton('lucideBan')).toBeNull();
    expect(actionButton('lucideRefreshCw')).toBeNull();
  });

  it('should not render tenant lifecycle actions in the project variant', async () => {
    await create('project', [{ ...(rows[1] as MemberRow), status: 'ACCESS_REVOKED' }]);

    expect(actionButton('lucideRotateCcw')).toBeNull();
    expect(actionButton('lucideRefreshCw')).toBeNull();
  });

  // ── Guard / states ─────────────────────────────────────────────

  it('should show the context-error state instead of the table when the id is missing', async () => {
    await create('tenant', rows, true, { contextMissing: true });

    expect(el.querySelector('hlm-alert')).not.toBeNull();
    expect(el.textContent).toContain('members.contextError');
    expect(el.querySelector('table')).toBeNull();
  });

  it('should render the empty state when there are no rows (no loading spinner — Q2/F-05)', async () => {
    await create('tenant', []);

    expect(el.textContent).toContain('members.noMembers');
    expect(el.querySelector('hlm-spinner')).toBeNull();
  });

  // ── Role label i18n ────────────────────────────────────────────

  it('maps project roles to their i18n keys (roleProjectAdmin/roleEditor/roleViewer)', async () => {
    await create('project');

    // TranslocoTestingModule has empty langs → unresolved keys echo back with the lang prefix
    expect(component.roleLabel('PROJECT_ADMIN')).toContain('members.roleProjectAdmin');
    expect(component.roleLabel('EDITOR')).toContain('members.roleEditor');
    expect(component.roleLabel('VIEWER')).toContain('members.roleViewer');
    // Tenant roles keep their existing keys
    expect(component.roleLabel('OWNER')).toContain('members.roleOwner');
    // Unknown roles fall back to the raw value
    expect(component.roleLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });

  // ── Auto page-size (measured wrapper + row height) ───

  describe('auto page-size (Q2/F-05)', () => {
    /**
     * Minimal ResizeObserver stub — jsdom has none (same pattern as task-table.spec.ts).
     */
    class MockResizeObserver {
      static instances: MockResizeObserver[] = [];
      readonly observed: Element[] = [];
      readonly unobserve = vi.fn();
      readonly disconnect = vi.fn();
      private readonly cb: ResizeObserverCallback;

      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        MockResizeObserver.instances.push(this);
      }

      observe(target: Element): void {
        this.observed.push(target);
      }

      trigger(wrapperHeight: number): void {
        this.cb(
          [{ contentRect: { height: wrapperHeight } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
    }

    /** The observer the component attached to the table wrapper */
    function wrapperObserver(): MockResizeObserver | undefined {
      const wrapEl = component.tableWrapRef()?.nativeElement as Element | undefined;

      return MockResizeObserver.instances.find((i) => wrapEl !== undefined && i.observed.includes(wrapEl));
    }

    beforeEach(() => {
      MockResizeObserver.instances = [];
      vi.stubGlobal('ResizeObserver', MockResizeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Create an Auto-mode table and mock the real body-row height (~44px vs the 48px fallback). */
    async function createAuto(): Promise<void> {
      await create('tenant', rows, true, { isAuto: true, autoEnabled: true, pageSize: 20 });

      const row: HTMLElement | null = el.querySelector('tbody tr:not([aria-hidden="true"])');

      if (row) vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);
    }

    it('should fit MORE rows using the MEASURED row height than the 48px fallback', async () => {
      await createAuto();

      const ro = wrapperObserver();

      // floor(704/45) = 15 measured (44px row + 1px border pitch) vs floor(704/48) = 14 fallback
      ro?.trigger(704);

      expect(component.effectivePageSize()).toBe(15);
    });

    it('should forward the measured available height to the host page (rowsHeightChange)', async () => {
      await createAuto();

      const emitted: number[] = [];

      component.rowsHeightChange.subscribe((v: number) => emitted.push(v));

      wrapperObserver()?.trigger(704);
      await settle(fixture); // flush the rowsHeightChange effect

      expect(emitted).toContain(704);
    });
  });
});
