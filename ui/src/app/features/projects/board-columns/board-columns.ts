import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp, lucidePlus, lucideTrash2 } from '@ng-icons/lucide';
import { rxResource } from '@angular/core/rxjs-interop';
import { firstValueFrom, of } from 'rxjs';
import { BoardClient } from '@services/board-client';
import { ProjectRefStore } from '@stores/project-ref-store';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmCheckboxImports } from '@spartan-ng/helm/checkbox';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { canManageProject } from '@app/shared/utils/role-utils';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

/** Local editable representation of one board column (id kept for stable PATCH updates). */
interface EditableColumn {
  id: string;
  statusIds: string[];
}

/**
 * Project settings — Board workflow editor (single-board model, doc 102).
 * The project has exactly one board; this page edits its columns: which
 * statuses each column groups, their order, adding and removing columns.
 * There is no board create/rename/delete — the board belongs to the project.
 */
@Component({
  selector: 'ui-board-columns',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmBadgeImports,
    HlmCardImports,
    HlmAlertImports,
    HlmCheckboxImports,
    HlmTooltipImports,
  ],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp, lucidePlus, lucideTrash2 })],
  templateUrl: './board-columns.html',
})
export class BoardColumns {
  private readonly boardClient = inject(BoardClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly notify = injectToasts();
  /** Statuses come from the shared ProjectRefStore cache */
  private readonly refStore = inject(ProjectRefStore);
  /** Bound via withComponentInputBinding() — receives project key from route */
  readonly projectKey = input.required<string>();
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /**
   * Whether the current user can manage the workflow (PROJECT_ADMIN+).
   * Tenant OWNER/ADMIN bypass project role checks.
   */
  protected readonly isAdmin = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  private readonly boardResource = rxResource({
    params: () => ({ projectId: this.projectId() }),
    stream: ({ params }) => (params.projectId ? this.boardClient.getForProject(params.projectId) : of(null)),
    defaultValue: null,
  });
  protected readonly loading = computed(() => this.boardResource.isLoading());
  private readonly loadError = signal('');
  protected readonly error = computed(() => (this.loadError() ? this.loadError() : ''));
  // Shared cache — no per-page duplicate request
  private readonly statuses = computed(() =>
    this.refStore
      .statusEntities(this.projectId())
      .slice()
      .sort((a, b) => a.position - b.position),
  );
  /** Draft columns being edited — seeded from the board once it loads. */
  private readonly columns = signal<EditableColumn[]>([]);
  private readonly dirty = signal(false);
  /**
   * The version of the board this draft was seeded from, sent back
   * on save. Without it a second admin's save silently overwrites this one; with
   * it the server answers 409 and the draft is left untouched for the user to
   * reconcile. Seeded whenever the board loads and refreshed after a successful
   * save, so a retry after a 409 re-reads the current version on reload.
   */
  private readonly boardVersion = signal(1);
  private readonly isDirty = computed(() => this.dirty());
  /** A column must group at least one status for the payload to be valid. */
  private readonly canSave = computed(
    () => this.isDirty() && this.columns().length > 0 && this.columns().every((col) => col.statusIds.length > 0),
  );

  constructor() {
    // Seed the draft when the board loads (and re-seed after a reload), but
    // never clobber unsaved local edits.
    effect(() => {
      const board = this.boardResource.hasValue() ? this.boardResource.value() : null;

      if (board && !this.dirty()) {
        this.columns.set(board.columns.map((col) => ({ id: col.id, statusIds: [...col.statusIds] })));
        this.boardVersion.set(board.version);
      }
    });

    effect(() => {
      if (this.boardResource.error()) {
        this.loadError.set(getErrorMessage(this.boardResource.error()));
      }
    });

    // Load statuses through the shared cache; reading entities keeps the
    // effect reactive — after an invalidate() (status mutations) it re-runs.
    effect(() => {
      const pid = this.projectId();

      if (!pid) return;

      this.refStore.statusEntities(pid);
      this.refStore.ensure(pid, ['statuses']);
    });
  }

  protected statusName(statusId: string): string {
    return this.statuses().find((s) => s.id === statusId)?.name ?? statusId;
  }

  /** Statuses assigned to NO column — surfaced so nothing silently disappears. */
  private readonly unassignedStatuses = computed(() => {
    const assigned = new Set(this.columns().flatMap((col) => col.statusIds));

    return this.statuses().filter((status) => !assigned.has(status.id));
  });
  protected readonly unassignedStatusNames = computed(() =>
    this.unassignedStatuses()
      .map((s) => s.name)
      .join(', '),
  );

  protected hasStatus(col: EditableColumn, statusId: string): boolean {
    return col.statusIds.includes(statusId);
  }

  protected toggleStatus(colIndex: number, statusId: string, checked: boolean): void {
    this.columns.update((cols) =>
      cols.map((col, i) =>
        i === colIndex
          ? {
              ...col,
              statusIds: checked ? [...col.statusIds, statusId] : col.statusIds.filter((id) => id !== statusId),
            }
          : col,
      ),
    );
    this.dirty.set(true);
  }

  protected moveColumn(index: number, direction: -1 | 1): void {
    const target = index + direction;

    this.columns.update((cols) => {
      if (target < 0 || target >= cols.length) return cols;

      const next = [...cols];
      const moved = next[index];

      if (!moved) return cols;

      next.splice(index, 1);
      next.splice(target, 0, moved);

      return next;
    });
    this.dirty.set(true);
  }

  protected addColumn(): void {
    this.columns.update((cols) => [...cols, { id: crypto.randomUUID(), statusIds: [] }]);
    this.dirty.set(true);
  }

  protected removeColumn(index: number): void {
    this.columns.update((cols) => cols.filter((_, i) => i !== index));
    this.dirty.set(true);
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;

    try {
      const saved = await firstValueFrom(
        this.boardClient.updateColumns(this.projectId(), {
          columns: this.columns().map((col, position) => ({ id: col.id, statusIds: col.statusIds, position })),
          version: this.boardVersion(),
        }),
      );

      this.dirty.set(false);
      this.boardVersion.set(saved.version);

      // Re-seed the draft from the saved state so ids match the server.
      const board = await firstValueFrom(this.boardClient.getForProject(this.projectId()));

      this.columns.set(board.columns.map((col) => ({ id: col.id, statusIds: [...col.statusIds] })));
      this.boardVersion.set(board.version);
      this.notify.success('toasts.updated');
    } catch (err) {
      this.notify.error(getErrorMessage(err));
    }
  }
}
