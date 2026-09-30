import { Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideColumns2, lucideEyeOff, lucideX } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmCheckboxImports } from '@spartan-ng/helm/checkbox';
import { HlmDropdownMenuImports, HlmDropdownMenuTrigger } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { BrnPopover } from '@spartan-ng/brain/popover';
import type { TaskTableColumnKey } from '@task-board/shared';
import { isPinnedColumn, type TaskColumnDef } from '../task-column-def';

/** Emitted when a single column's visibility is toggled in the chooser */
export interface ColumnToggle {
  columnKey: TaskTableColumnKey;
  visible: boolean;
}

/**
 * Column-chooser UI extracted from the TaskTable composition root —
 * the toolbar chooser popover, the cursor-anchored chooser (opened from the
 * header context menu) and the header context menu itself.
 *
 * The column *visibility state and persistence* stay in the parent (the table
 * header/body render from it); this component owns the chooser/context-menu
 * interaction state and emits toggle requests up.
 */
@Component({
  selector: 'ui-task-table-columns',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    HlmButtonImports,
    HlmPopoverImports,
    HlmCheckboxImports,
    HlmDropdownMenuImports,
    HlmTooltipImports,
  ],
  providers: [provideIcons({ lucideColumns2, lucideEyeOff, lucideX })],
  host: { class: 'contents' },
  templateUrl: './task-table-columns.html',
})
export class TaskTableColumns {
  /** Full column-definition list (pinned + toggleable), owned by the parent */
  readonly taskColumns = input.required<TaskColumnDef[]>();
  /** Effective visible column keys (computed in the parent) */
  readonly visibleKeys = input.required<ReadonlySet<TaskTableColumnKey>>();
  /** Select-all state over the toggleable (non-pinned) columns */
  readonly allColumnsSelected = input(false);
  readonly someColumnsSelected = input(false);
  /** Single column visibility toggle (chooser checkbox) */
  readonly toggleColumn = output<ColumnToggle>();
  /** Bulk show/hide of ALL non-pinned columns (chooser select-all) */
  readonly toggleAll = output<boolean>();
  /** Hide a column via the header context menu */
  readonly hideColumn = output<TaskTableColumnKey>();
  /** Column-chooser popover visibility (toolbar instance) */
  readonly showColumnChooser = signal(false);
  /**
   * Cursor-anchored chooser instance — opened from the
   * header context menu so the chooser appears near the cursor, not at the
   * toolbar button. Shares state/handlers with the toolbar instance.
   */
  readonly showContextColumnChooser = signal(false);
  /** Column targeted by the header context menu */
  readonly contextColumn = signal<TaskColumnDef | null>(null);
  /** Exposed for the chooser template (pinned checkboxes are disabled) */
  protected readonly isPinnedColumn = isPinnedColumn;
  private readonly ctxAnchorRef = viewChild<ElementRef<HTMLSpanElement>>('ctxAnchor');
  /** Hidden trigger button of the cursor-anchored chooser popover */
  private readonly ctxChooserAnchorRef = viewChild<ElementRef<HTMLButtonElement>>('ctxChooserAnchor');
  /** The BrnPopover hosting the cursor-anchored chooser (for setOrigin). */
  private readonly ctxChooserPopover = viewChild('ctxChooserAnchor', { read: BrnPopover });
  private readonly ctxMenuTrigger = viewChild(HlmDropdownMenuTrigger);

  /** Right-click on a column header → open the context menu at the cursor */
  onHeaderContextMenu(event: MouseEvent, col: TaskColumnDef): void {
    event.preventDefault();
    // Round-4 F4: Linux fires `contextmenu` on mousedown — when the right button
    // is released the browser fires `auxclick`/`click` on the `<th>`, which CDK's
    // overlay outside-click dispatcher treats as an outside click and closes the
    // menu immediately. Swallow that single terminating event.
    this.openContextMenuAt(event.clientX, event.clientY, col, true);
  }

  /** Position the hidden anchors at (x, y) and open the header context menu */
  private openContextMenuAt(x: number, y: number, col: TaskColumnDef, swallowTerminatingClick: boolean): void {
    this.contextColumn.set(col);

    const anchor = this.ctxAnchorRef()?.nativeElement;

    if (!anchor) return;

    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;

    // Keep the cursor-anchored chooser trigger at the
    // same coordinates so "Select columns" opens the popover at the cursor.
    const chooserAnchor = this.ctxChooserAnchorRef()?.nativeElement;

    if (chooserAnchor) {
      chooserAnchor.style.left = `${x}px`;
      chooserAnchor.style.top = `${y}px`;
    }

    // Open once the anchor position is committed to the DOM
    setTimeout(() => {
      // `openFocused()` opens the menu AND moves focus into it via CDK's
      // `focusFirstItem()` — which syncs the FocusKeyManager's active index
      // with the focused item. A raw DOM `.focus()` on the first item leaves
      // the key-manager index at -1, so the first ArrowDown was a no-op
      // (re-activating item 0) and ArrowUp wrapped to the last item.
      this.ctxMenuTrigger()?.openFocused();

      if (swallowTerminatingClick) this.swallowNextClick();
    });
  }

  /**
   * Round-4 F4: swallow exactly ONE terminating click after a programmatic menu
   * open. One-shot capture-phase listeners on `document` stop the event before it
   * reaches CDK's body-level outside-click dispatcher; they remove themselves after
   * the first event (or after ~500 ms as a safety), so a later click that selects a
   * menu item is never eaten.
   */
  swallowNextClick(): void {
    let handle: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      document.removeEventListener('auxclick', swallow, true);
      document.removeEventListener('click', swallow, true);

      if (handle !== null) clearTimeout(handle);

      handle = null;
    };
    const swallow = (event: Event): void => {
      event.stopPropagation();
      cleanup();
    };

    handle = setTimeout(cleanup, 500);
    document.addEventListener('auxclick', swallow, true);
    document.addEventListener('click', swallow, true);
  }

  canHideContextColumn(): boolean {
    const col = this.contextColumn();

    return !!col && !isPinnedColumn(col.columnKey) && this.visibleKeys().has(col.columnKey);
  }

  hideContextColumn(): void {
    const col = this.contextColumn();

    if (col) this.hideColumn.emit(col.columnKey);
  }

  /** Open the CURSOR-anchored instance, never the toolbar one */
  openChooserFromContextMenu(): void {
    // The popover is opened via the `[state]` binding (not a trigger
    // click), so BrnPopoverTrigger never runs `setOrigin` — without an origin
    // the overlay fell back to its default (mid-table) position. Point it at
    // the hidden cursor-anchored trigger button first.
    const anchor = this.ctxChooserAnchorRef()?.nativeElement;

    if (anchor) this.ctxChooserPopover()?.setOrigin(anchor);

    this.showColumnChooser.set(false);
    this.showContextColumnChooser.set(true);
  }

  onChooserStateChange(state: 'open' | 'closed'): void {
    // When the toolbar popover is opened by CLICKING its trigger, the
    // overlay's internal state goes 'open' but the `[state]` binding signal
    // stayed false — so the × button's `showColumnChooser.set(false)` was a
    // no-op (same value → input never changes → BrnOverlay's effect never
    // closes). Mirror the overlay state into the signal so the binding is the
    // single source of truth. Round-5 P9: only one instance open at a time.
    if (state === 'open') {
      this.showColumnChooser.set(true);
      this.showContextColumnChooser.set(false);
    } else {
      this.showColumnChooser.set(false);
    }
  }

  onContextChooserStateChange(state: 'open' | 'closed'): void {
    if (state === 'open') {
      this.showContextColumnChooser.set(true);
      this.showColumnChooser.set(false);
    } else {
      this.showContextColumnChooser.set(false);
    }
  }

  /** × button in the shared chooser header — closes whichever instance is open */
  closeColumnChooser(): void {
    this.showColumnChooser.set(false);
    this.showContextColumnChooser.set(false);
  }
}
