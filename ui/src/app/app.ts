import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Header } from './shell/header/header';
import { PreferencesStore } from './stores/preferences-store';
import { AppToaster } from './app-toaster/app-toaster';

@Component({
  selector: 'ui-root',
  // AppToaster is referenced ONLY inside an `@defer (on idle)`
  // block in the template, so the compiler extracts it — together with the
  // whole brn-sonner dependency chain — into a lazy chunk (toasts queue in
  // module state until the block hydrates).
  imports: [RouterOutlet, Header, AppToaster],
  templateUrl: './app.html',
})
export class App {
  // Eagerly injected so the store constructor runs before first paint,
  // restoring the theme from localStorage and preventing a theme flash.
  protected readonly preferencesStore = inject(PreferencesStore);
}
