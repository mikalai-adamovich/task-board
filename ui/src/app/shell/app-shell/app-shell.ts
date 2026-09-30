import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { Sidebar } from '../sidebar/sidebar';
import { RouteFocusActivator } from '../route-focus';
import { KeyboardShortcuts } from '@app/shared/keyboard-shortcuts/keyboard-shortcuts';
import { PendingChangesDialog } from '@app/shared/pending-changes/pending-changes-dialog';

@Component({
  selector: 'ui-shell',
  // `uiRouteFocus` in the shell markup is what activates the single
  // focus-on-navigation mechanism (see `route-focus.ts`).
  imports: [
    RouterOutlet,
    Sidebar,
    TranslocoPipe,
    HlmButtonImports,
    HlmDialogImports,
    PendingChangesDialog,
    RouteFocusActivator,
  ],
  templateUrl: './app-shell.html',
})
export class AppShell {
  /** Global keyboard shortcuts + the `?` help dialog state */
  protected readonly shortcuts = inject(KeyboardShortcuts);
}
