import { inject, Service } from '@angular/core';
import { ThemeRegistry } from './theme-registry';

const THEMES_DIR = '/themes';

/**
 * Responsible for applying a theme by dynamically loading its CSS stylesheet.
 * Does NOT know which themes exist — that is ThemeRegistry's job.
 *
 * ── The stylesheet name comes from the manifest, not from the id ─────────────
 * The URL is built from the theme's `css` field in `/themes/manifest.json`,
 * which is what lets a release publish content-hashed stylesheet names
 * (`ui/scripts/hash-runtime-assets.mjs` rewrites that field at build time). It
 * used to be built from the id alone — `light.css` — so the manifest's `css`
 * field was carried in every release and read by nobody, and no runtime asset
 * could be given a name that changes when its bytes change.
 *
 * The registry is consulted rather than the manifest file directly: it is
 * already loaded before the first theme is applied, it caches, and awaiting it
 * here means a theme applied before the manifest arrives still gets the hashed
 * name instead of a stable one that no longer exists. When the manifest knows
 * nothing about the theme (the dev server, a manifest that failed to load) the
 * id-derived name is used, which is what both of those produce.
 */
@Service()
export class ThemeLoader {
  private readonly themeRegistry = inject(ThemeRegistry);
  private currentThemeLink?: HTMLLinkElement;
  private loadToken = 0;

  /**
   * Load and apply a theme CSS file.
   * @param themeId The theme identifier (e.g., "light", "dark", "claude").
   */
  async loadTheme(themeId: string): Promise<void> {
    const token = ++this.loadToken;
    const newLink = document.createElement('link');
    // Resolved before the first `await` whenever the manifest already knows the
    // theme, which is the case in the running application: the <link> is still
    // created synchronously, so a theme switch is not delayed by a microtask.
    // Only a theme the manifest has never heard of defers, and that is the
    // dev-server / unknown-id path.
    const known = this.themeRegistry.findById(themeId);
    const file = known?.css ?? (await this.stylesheetFor(themeId));

    newLink.rel = 'stylesheet';
    newLink.href = `${THEMES_DIR}/${file}`;
    newLink.dataset.theme = themeId;

    await new Promise<void>((resolve, reject) => {
      newLink.onload = () => resolve();
      newLink.onerror = () => {
        // A stylesheet that never loaded is dead weight: the success path and the
        // superseded-load path both remove their <link>, and a failure that kept
        // its own would accumulate one element (and one stylesheet reference) in
        // document.head for every failed theme switch.
        newLink.remove();
        newLink.onload = null;
        newLink.onerror = null;
        reject(new Error(`Failed to load theme "${themeId}"`));
      };

      document.head.appendChild(newLink);
    });

    if (token !== this.loadToken) {
      newLink.remove();
      return;
    }

    this.currentThemeLink?.remove();
    this.currentThemeLink = newLink;
  }

  /**
   * The manifest's filename for a theme the registry has not loaded yet,
   * falling back to the id-derived one.
   *
   * The fallback is not a guess about production: in a hashed build every entry
   * IS in the manifest, so it only fires where no hashing happened (`ng serve`)
   * or where the manifest could not be fetched.
   */
  private async stylesheetFor(themeId: string): Promise<string> {
    await this.themeRegistry.load();

    return this.themeRegistry.findById(themeId)?.css ?? `${themeId}.css`;
  }
}
