import { Component, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { inject } from '@angular/core';
import type { BoardTask, TaskPriorityLevel } from '@task-board/shared';
import { priorityBadgeVariant, priorityLabelKey, type BadgeVariant } from '@app/constants/priority';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';

@Component({
  selector: 'ui-task-card',
  imports: [TranslocoPipe, HlmBadgeImports, HlmAvatarImports],
  host: {
    class: 'block',
    draggable: 'true',
    '(dragstart)': 'onDragStart($event)',
  },
  templateUrl: './task-card.html',
})
export class TaskCard {
  readonly task = input.required<BoardTask>();
  readonly projectKey = input<string>('');
  /** Resolved issue-type display name (from the shared reference-data store) */
  readonly typeName = input<string>('');
  readonly taskClick = output<BoardTask>();
  /**
   * a11y: keyboard equivalent of the (pointer-only) CDK drag. `v` while the
   * card has focus asks the board to offer a "move to column" picker, so a
   * keyboard or screen-reader user can move a card between columns at all.
   * The card is a `role="button"`, so a nested move button is not an option —
   * a documented shortcut on the focusable card is the honest alternative.
   */
  readonly moveRequested = output<BoardTask>();
  readonly dragStart = output<{ task: BoardTask; dragEvent: DragEvent }>();
  private readonly i18n = inject(TranslocoService);

  /** Translated priority label; unknown values render verbatim. */
  protected priorityLabel(priorityLevel: TaskPriorityLevel): string {
    const key = priorityLabelKey(priorityLevel);

    return key ? this.i18n.translate(key) : String(priorityLevel);
  }

  protected priorityVariant(): BadgeVariant {
    return priorityBadgeVariant(this.task().priorityLevel);
  }

  protected taskLabel(): string {
    const key = this.projectKey();
    const num = this.task().number;

    return key ? `${key}-${num}` : `#${num}`;
  }

  protected assigneeInitials(): string {
    const snap = this.task().assigneeSnapshot;

    if (!snap?.displayName) return '?';

    return snap.displayName
      .split(' ')
      .map((w) => w[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();
  }

  protected onDragStart(event: DragEvent): void {
    this.dragStart.emit({ task: this.task(), dragEvent: event });
  }
}
