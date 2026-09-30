import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { provideIcons, NgIcon } from '@ng-icons/core';
import {
  lucidePlus,
  lucideFolder,
  lucideSettings,
  lucideUsers,
  lucideListTodo,
  lucideArrowRight,
  lucideUserPlus,
} from '@ng-icons/lucide';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { form, FormField, FormRoot, schema, required, maxLength } from '@angular/forms/signals';
import { FieldControl } from '@app/shared/field-control/field-control';
import type { TaskPriorityLevel } from '@task-board/shared';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { InvitationStatus, TenantRole, TenantStatus } from '@task-board/shared';
import type { Task, TenantMember } from '@task-board/shared';
import { priorityBadgeVariant, priorityLabelKey, roleBadgeVariant, statusBadgeVariant } from '@app/constants/priority';
import { TranslocoService } from '@jsverse/transloco';
import { ProjectClient } from '@services/project-client';
import { ProjectStore } from '@stores/project-store';
import { TaskClient } from '@services/task-client';
import { TenantClient } from '@services/tenant-client';
import { TenantStore } from '@stores/tenant-store';
import { AuthStore } from '@stores/auth-store';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';
import { hasMinTenantRole } from '@app/shared/utils/role-utils';

export interface CreateProjectForm {
  name: string;
  key: string;
  description: string;
}

/** View model for one row of the "My Tasks" widget */
interface MyTaskItem {
  task: Task;
  projectKey: string;
  projectName: string;
}

/**
 * Unified tenant home (`/w/:tenantSlug`, DEC-033) — serves all roles.
 * Workspace header, primary "Create project" CTA, projects grid,
 * "My Tasks" widget and a pending-invitations summary for admins.
 */
@Component({
  selector: 'ui-tenant-home',
  imports: [
    FieldControl,
    HlmAlertImports,
    HlmEmptyImports,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCardImports,
    HlmDialogImports,
    HlmFieldImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmSpinnerImports,
    FormField,
    FormRoot,
  ],
  providers: [
    provideIcons({
      lucidePlus,
      lucideFolder,
      lucideSettings,
      lucideUsers,
      lucideListTodo,
      lucideArrowRight,
      lucideUserPlus,
    }),
  ],
  templateUrl: './tenant-home.html',
})
export class TenantHome {
  private readonly notify = injectToasts();
  private readonly projectClient = inject(ProjectClient);
  private readonly taskClient = inject(TaskClient);
  private readonly tenantClient = inject(TenantClient);
  private readonly tenantStore = inject(TenantStore);
  private readonly authStore = inject(AuthStore);
  /** Shared badge helpers (see constants/priority.ts) */
  protected readonly statusBadgeVariant = statusBadgeVariant;
  protected readonly roleBadgeVariant = roleBadgeVariant;
  protected readonly priorityBadgeVariant = priorityBadgeVariant;
  private readonly i18n = inject(TranslocoService);

  /** Translated priority label for the "My Tasks" widget; unknown values render verbatim. */
  protected priorityLabel(priorityLevel: TaskPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.i18n.translate(key) : String(priorityLevel);
  }
  protected readonly TenantStatus = TenantStatus;
  protected readonly TenantRole = TenantRole;
  private readonly tenant = computed(() => this.tenantStore.activeTenant());
  private readonly role = computed(() => this.authStore.tenantRole());
  private readonly isOwnerOrAdmin = computed(() => hasMinTenantRole(this.role(), TenantRole.ADMIN));
  // ─── Projects grid ────────────────────────────────────────────────────────
  // The project list comes from the shared tenant-scoped cache in
  // ProjectStore (ProjectSwitcher reads the SAME cache — one GET /projects per
  // tenant session instead of two independent fetches). Invalidation (see
  // upsertProject / invalidateProjectList) re-triggers the ensure effect below.
  private readonly projectStore = inject(ProjectStore);
  /** Active tenant id — both the read and the ensure effect track this */
  private readonly activeTenantId = computed(() => this.tenantStore.activeTenant()?.id ?? '');
  private readonly projects = computed(() => this.projectStore.projectList(this.activeTenantId()));
  protected readonly loadingProjects = computed(
    () => this.activeTenantId() !== '' && this.projectStore.isProjectListLoading(this.activeTenantId()),
  );
  // ─── My Tasks widget (recent tasks assigned to me in THIS tenant) ─────────
  private readonly myTasksResource = rxResource({
    params: () => ({ tenantId: this.tenantStore.activeTenant()?.id ?? '' }),
    stream: ({ params }) => (params.tenantId ? this.taskClient.getMyTasks() : of([])),
    defaultValue: [] as Task[],
  });
  private readonly myTasks = computed(() => (this.myTasksResource.hasValue() ? this.myTasksResource.value() : []));
  /** Tasks scoped to this tenant's projects, each resolved to its project key */
  protected readonly myTaskItems = computed<MyTaskItem[]>(() => {
    const byProjectId = new Map(this.projects().map((p) => [p.id, p]));

    return this.myTasks().flatMap((task) => {
      const project = byProjectId.get(task.projectId);

      return project ? [{ task, projectKey: project.key, projectName: project.name }] : [];
    });
  });
  // ─── Pending invitations summary (admins) ────────────────────────────────
  // Converted from `effect` + manual `subscribe()`. The resource cancels
  // the in-flight request on teardown/param change (no write after destroy, no
  // subscription leak) and surfaces failures through `error()` instead of an
  // unhandled subscription. The `tenantId` param is blank for non-admins, so
  // the request is skipped entirely in that case.
  private readonly invitesResource = rxResource({
    params: () => ({ tenantId: this.isOwnerOrAdmin() ? (this.tenant()?.id ?? '') : '' }),
    stream: ({ params }) =>
      params.tenantId ? this.tenantClient.listMembers(params.tenantId) : of([] as TenantMember[]),
    defaultValue: [] as TenantMember[],
  });
  protected readonly pendingInvites = computed(() => {
    if (!this.invitesResource.hasValue()) return [];

    return this.invitesResource.value().filter((m) => m.invitation?.status === InvitationStatus.PENDING);
  });
  protected readonly loadingInvites = computed(() => this.invitesResource.isLoading());
  // ─── Create project dialog ────────────────────────────────────────────────
  private readonly showCreateModal = signal(false);
  private readonly actionError = signal('');
  protected readonly error = computed(() => this.actionError());
  private readonly model = signal<CreateProjectForm>({
    name: '',
    key: '',
    description: '',
  });
  protected readonly newProjectForm = form(
    this.model,
    schema<CreateProjectForm>((field) => {
      required(field.name, { message: 'validation.nameRequired' });
      required(field.key, { message: 'validation.keyRequired' });
      maxLength(field.description, 120, { message: 'validation.descriptionMax' });
    }),
    {
      submission: {
        action: async (f) => {
          this.actionError.set('');
          this.projectClient
            .create({
              name: this.model().name,
              key: this.model().key.toUpperCase(),
              description: this.model().description || undefined,
            })
            .subscribe({
              next: (project) => {
                // Patch the SHARED cache — the sidebar ProjectSwitcher sees
                // the new project immediately (no extra GET /projects).
                this.projectStore.upsertProject(project);
                this.showCreateModal.set(false);
                f().reset({ name: '', key: '', description: '' });
                this.notify.success('toasts.created');
              },
              error: (err) => {
                this.actionError.set(getErrorMessage(err));
              },
            });
        },
      },
    },
  );

  constructor() {
    // Load the project list through the shared cache. This effect performs
    // no fetching of its own: `ensureProjectList()` is the shared, deduped,
    // signal-backed cache loader (an imperative `ensure` by design), and
    // reading `projectList()` keeps the effect reactive — after
    // `invalidateProjectList()` it re-runs and refetches.
    effect(() => {
      const tenantId = this.activeTenantId();

      if (!tenantId) return;

      this.projectStore.projectList(tenantId);
      void this.projectStore.ensureProjectList(tenantId).catch(() => {
        // Non-critical: the grid stays empty; a later navigation retries.
      });
    });
  }

  /** V2-10: only tenant OWNER/ADMIN may create projects — the server denies MEMBERs. */
  protected canCreate(): boolean {
    return this.isOwnerOrAdmin();
  }

  protected onDialogStateChange(state: BrnDialogState): void {
    if (state === 'closed') {
      this.showCreateModal.set(false);
    }
  }
}
