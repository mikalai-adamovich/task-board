import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideRotateCcw, lucideTrash2, lucideXCircle } from '@ng-icons/lucide';
import { ProjectClient } from '@services/project-client';
import { AuthStore } from '@stores/auth-store';
import { ProjectStore } from '@stores/project-store';
import { TenantStore } from '@stores/tenant-store';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ProjectStatus } from '@task-board/shared';
import type { Project } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { canManageProject } from '@app/shared/utils/role-utils';
import { statusBadgeVariant } from '@app/constants/priority';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

/**
 * Project settings — Danger Zone page (spec S15, DEC-035).
 * Archive / restore / cancel-deletion / delete with typed confirmation.
 * Moved out of the project overview.
 */
@Component({
  selector: 'ui-project-danger-zone',
  imports: [
    RouterLink,
    DatePipe,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmDialogImports,
    HlmSpinnerImports,
    HlmFieldImports,
    HlmInputImports,
    HlmBadgeImports,
    HlmCardImports,
    HlmAlertImports,
  ],
  providers: [provideIcons({ lucideArchive, lucideRotateCcw, lucideTrash2, lucideXCircle })],
  templateUrl: './project-danger-zone.html',
})
export class ProjectDangerZone {
  /** Shared badge-class helper (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  private readonly notify = injectToasts();
  private readonly router = inject(Router);
  private readonly tenantStore = inject(TenantStore);
  private readonly projectClient = inject(ProjectClient);
  private readonly authStore = inject(AuthStore);
  private readonly projectStore = inject(ProjectStore);
  /** Bound via withComponentInputBinding() — receives project key from route */
  readonly projectKey = input.required<string>();
  /** Current tenant slug for navigating back to the overview */
  private readonly tenantSlug = computed(() => this.tenantStore.activeTenant()?.slug ?? '');
  /** Resolved project UUID from the store */
  private readonly projectId = computed(() => this.projectStore.activeProject()?.id ?? '');
  /**
   * Whether the current user can manage project settings (PROJECT_ADMIN+).
   * Tenant OWNER/ADMIN bypass project role checks.
   */
  protected readonly isAdmin = computed(() =>
    canManageProject(this.projectStore.projectRole(), this.authStore.tenantRole()),
  );
  protected readonly ProjectStatus = ProjectStatus;
  private readonly project = signal<Project | null>(this.projectStore.activeProject());
  protected readonly loading = signal(false);
  private readonly error = signal('');
  private readonly showDeleteConfirm = signal(false);
  private readonly deleteConfirmText = signal('');
  /** Whether the delete confirmation text matches the project key */
  private readonly canConfirmDelete = computed(() => {
    const p = this.project();

    return p !== null && this.deleteConfirmText() === p.key;
  });

  // ─── Project Lifecycle ────────────────────────────────────────────────────

  protected archiveProject(): void {
    this.projectClient.archive(this.projectId()).subscribe({
      next: () => {
        this.project.update((p) => (p ? { ...p, status: ProjectStatus.ARCHIVED } : p));
        this.syncStore();
        this.notify.success('toasts.updated');
      },
      error: (err) => this.error.set(getErrorMessage(err)),
    });
  }

  protected restoreProject(): void {
    this.projectClient.restore(this.projectId()).subscribe({
      next: () => {
        this.project.update((p) => (p ? { ...p, status: ProjectStatus.ACTIVE, deletionScheduledAt: null } : p));
        this.syncStore();
        this.notify.success('toasts.updated');
      },
      error: (err) => this.error.set(getErrorMessage(err)),
    });
  }

  protected requestDeleteProject(): void {
    this.deleteConfirmText.set('');
    this.showDeleteConfirm.set(true);
  }

  protected confirmDeleteProject(): void {
    const p = this.project();

    if (!p || !this.canConfirmDelete()) return;

    this.projectClient.delete(this.projectId()).subscribe({
      next: () => {
        this.showDeleteConfirm.set(false);
        this.deleteConfirmText.set('');
        this.notify.success('toasts.deleted');
        // The overview no longer re-fetches the project, so the store must
        // reflect the new status BEFORE navigating back (the read-only banner
        // reads ProjectStore.activeProject). The server only returns
        // { success: true } here — the status is derived client-side, same as
        // archiveProject/restoreProject above.
        this.project.update((current) => (current ? { ...current, status: ProjectStatus.DELETION_PENDING } : current));
        this.syncStore();
        // Navigate back to the overview so the read-only banner is visible
        this.router.navigate(['/w', this.tenantSlug(), 'projects', this.projectKey()]);
      },
      error: (err) => {
        this.error.set(getErrorMessage(err));
        this.showDeleteConfirm.set(false);
        this.deleteConfirmText.set('');
      },
    });
  }

  protected cancelDeletion(): void {
    this.projectClient.cancelDeletion(this.projectId()).subscribe({
      next: () => {
        this.project.update((p) => (p ? { ...p, status: ProjectStatus.ACTIVE, deletionScheduledAt: null } : p));
        this.syncStore();
      },
      error: (err) => this.error.set(getErrorMessage(err)),
    });
  }

  protected onDeleteDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showDeleteConfirm.set(false);
      this.deleteConfirmText.set('');
    }
  }

  /** Keep the shared project context (and the F4 tenant list cache) in sync */
  private syncStore(): void {
    const p = this.project();

    if (p) {
      this.projectStore.activeProject.set(p);
      this.projectStore.upsertProject(p);
    }
  }
}
