import { Component, inject, input, signal, OnInit } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TaskRelationshipClient } from '@services/task-relationship-client';
import { TaskRelationshipType } from '@task-board/shared';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { finalize } from 'rxjs';
import type { TaskRelationship } from '@task-board/shared';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { ConfirmDialog } from '@app/shared/confirm-dialog/confirm-dialog';

@Component({
  selector: 'ui-task-relationships',
  imports: [
    ConfirmDialog,
    HlmAlertImports,
    TranslocoPipe,
    HlmButtonImports,
    HlmSpinnerImports,
    HlmCardImports,
    HlmInputImports,
    HlmSelectImports,
    HlmBadgeImports,
    HlmDialogImports,
    HlmFieldImports,
  ],
  templateUrl: './task-relationships.html',
})
export class TaskRelationships implements OnInit {
  private readonly notify = injectToasts();
  private readonly relationshipClient = inject(TaskRelationshipClient);
  /** Current task ID */
  readonly taskId = input.required<string>();
  /** Current project ID */
  readonly projectId = input.required<string>();
  private readonly relationships = signal<TaskRelationship[]>([]);
  private readonly loading = signal(true);
  private readonly error = signal('');
  // Create form
  private readonly targetTaskId = signal('');
  private readonly relationshipType = signal<string>(TaskRelationshipType.BLOCKS);
  private readonly creating = signal(false);
  private readonly showCreateForm = signal(false);
  // Delete confirmation
  private readonly showDeleteConfirm = signal(false);
  private readonly relationshipToDelete = signal<TaskRelationship | null>(null);
  protected readonly relationshipTypes = [
    TaskRelationshipType.BLOCKS,
    TaskRelationshipType.RELATES_TO,
    TaskRelationshipType.DUPLICATES,
  ];

  ngOnInit(): void {
    this.loadRelationships();
  }

  private loadRelationships(): void {
    this.loading.set(true);
    this.relationshipClient
      .list(this.taskId())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (data) => {
          this.relationships.set(data);
        },
        error: () => {
          this.error.set('relationships.loadError');
        },
      });
  }

  protected createRelationship(): void {
    const targetId = this.targetTaskId().trim();

    if (!targetId) return;

    this.creating.set(true);
    this.relationshipClient
      .create(this.taskId(), {
        targetTaskId: targetId,
        type: this.relationshipType() as TaskRelationshipType,
      })
      .pipe(finalize(() => this.creating.set(false)))
      .subscribe({
        next: (rel) => {
          this.relationships.update((list) => [...list, rel]);
          this.targetTaskId.set('');
          this.showCreateForm.set(false);
          this.notify.success('toasts.created');
        },
        error: () => {
          this.error.set('relationships.createError');
        },
      });
  }

  protected confirmDelete(rel: TaskRelationship): void {
    this.relationshipToDelete.set(rel);
    this.showDeleteConfirm.set(true);
  }

  protected onDeleteDialogStateChange(open: boolean): void {
    if (!open) {
      this.showDeleteConfirm.set(false);
      this.relationshipToDelete.set(null);
    }
  }

  protected deleteRelationship(): void {
    const rel = this.relationshipToDelete();

    if (!rel) return;

    this.relationshipClient.delete(rel.id).subscribe({
      next: () => {
        this.relationships.update((list) => list.filter((r) => r.id !== rel.id));
        this.showDeleteConfirm.set(false);
        this.relationshipToDelete.set(null);
      },
      error: () => {
        this.error.set('relationships.deleteError');
      },
    });
  }

  /** Whether the current task is the source of this relationship */
  private isSource(rel: TaskRelationship): boolean {
    return rel.sourceTaskId === this.taskId();
  }

  /** Get the "other" task ID in the relationship */
  protected otherTaskId(rel: TaskRelationship): string {
    return this.isSource(rel) ? rel.targetTaskId : rel.sourceTaskId;
  }

  /** Whether the relationship type is BLOCKS (visually distinct) */
  protected isBlocks(rel: TaskRelationship): boolean {
    return rel.type === TaskRelationshipType.BLOCKS;
  }

  protected onTargetTaskIdInput(event: Event): void {
    this.targetTaskId.set((event.target as HTMLInputElement).value);
  }

  // `onTypeChange()` was removed as dead code — the relationship-type select
  // binds through the signal's own `(change)`/model path, not this handler.
}
