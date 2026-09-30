import { Component, DestroyRef, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { PreferencesStore } from '@stores/preferences-store';
import { getNextZoom } from '../../zoom.util';

@Component({
  selector: 'ui-user-menu-zoom-controls',
  standalone: true,
  imports: [HlmButtonImports, TranslocoPipe],
  templateUrl: './user-menu-zoom-controls.html',
})
export class UserMenuZoomControls {
  private readonly destroyRef = inject(DestroyRef);
  private readonly preferencesStore = inject(PreferencesStore);

  constructor() {
    // Commit pending zoom to backend when the dropdown is destroyed (closed).
    this.destroyRef.onDestroy(() => this.preferencesStore.commitZoom());
  }

  protected zoomOut(): void {
    this.preferencesStore.setZoomLocal(getNextZoom(this.preferencesStore.zoom(), 'out'));
  }

  protected zoomIn(): void {
    this.preferencesStore.setZoomLocal(getNextZoom(this.preferencesStore.zoom(), 'in'));
  }
}
