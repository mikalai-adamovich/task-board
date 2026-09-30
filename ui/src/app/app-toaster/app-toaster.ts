import { Component } from '@angular/core';
import { HlmToasterImports } from '@spartan-ng/helm/sonner';

/**
 * Render surface for toast notifications.
 *
 * Exists solely so the heavy brn-sonner module (~49 kB) can be kept out of
 * the initial bundle: the root template wraps `<ui-app-toaster />` in an
 * `@defer (on idle)` block, and because this component is the ONLY static
 * importer of `@spartan-ng/helm/sonner`, the whole toaster dependency chain
 * is extracted into the deferred lazy chunk. Toasts fired before hydration
 * are not lost — `toast.*` calls queue into module-level state which the
 * toaster renders once the block loads.
 */
@Component({
  selector: 'ui-app-toaster',
  imports: [HlmToasterImports],
  templateUrl: './app-toaster.html',
})
export class AppToaster {}
