import { TestBed } from '@angular/core/testing';
import { ThemeLoader } from './theme-loader';
import { ThemeRegistry } from './theme-registry';
import type { ThemeManifestItem } from '@task-board/shared';

/**
 * A release publishes CONTENT-HASHED stylesheet names, so the URL
 * must come from the manifest entry rather than from the theme id. These tests
 * drive both directions against a stubbed registry: a hashed name is followed,
 * and a theme the manifest does not know still resolves (the dev server, where
 * nothing was hashed).
 */
describe('ThemeLoader', () => {
  let loader: ThemeLoader;
  let registryLoad: ReturnType<typeof vi.fn>;
  const theme = (id: string, css: string): ThemeManifestItem => ({
    id,
    name: id,
    mode: 'light',
    css,
    preview: { primary: '', muted: '', foreground: '', card: '', border: '' },
  });
  /** The manifest a hashed release publishes. */
  const MANIFEST: ThemeManifestItem[] = [
    theme('light', 'light.1a2b3c4d.css'),
    theme('claude', 'claude.5e6f7a8b.css'),
    theme('nord', 'nord.9c0d1e2f.css'),
  ];
  const lastLink = (): HTMLLinkElement => {
    const links = document.head.querySelectorAll<HTMLLinkElement>('link[data-theme]');

    return links[links.length - 1] as HTMLLinkElement;
  };

  beforeEach(() => {
    document.head.querySelectorAll<HTMLLinkElement>('link[data-theme]').forEach((l) => l.remove());
    registryLoad = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ThemeRegistry,
          useValue: {
            load: registryLoad,
            findById: (id: string) => MANIFEST.find((t) => t.id === id),
          },
        },
      ],
    });
    loader = TestBed.inject(ThemeLoader);
  });

  it('requests the content-hashed stylesheet the manifest names, not <id>.css', async () => {
    // The property the content-hashing step rests on: a stable name here would 404 the moment the
    // release that hashed the assets shipped. The manifest already knows the
    // theme, so the <link> exists as soon as `loadTheme` is called.
    const promise = loader.loadTheme('claude');
    const link = lastLink();

    expect(link.href).toContain('/themes/claude.5e6f7a8b.css');
    expect(link.href).not.toContain('/themes/claude.css');
    expect(link.dataset['theme']).toBe('claude');
    // Nothing had to be fetched, so no request is made for it.
    expect(registryLoad).not.toHaveBeenCalled();

    link.onload?.(new Event('load'));
    await promise;
  });

  it('falls back to <id>.css for a theme the manifest does not know', async () => {
    // The dev server, where nothing was hashed. It is a real code path, not a
    // convenience: an unknown id must still produce a request rather than a
    // stylesheet URL of `undefined`. This is the one case that defers, because
    // the registry has to be asked first.
    const promise = loader.loadTheme('local-only');

    // Draining microtasks until the element exists rather than counting them:
    // the loader awaits the registry, and the number of ticks that takes is an
    // implementation detail this test must not encode.
    for (let tick = 0; tick < 10 && !lastLink(); tick += 1) await Promise.resolve();

    const link = lastLink();

    expect(link.href).toContain('/themes/local-only.css');
    expect(registryLoad).toHaveBeenCalled();

    link.onload?.(new Event('load'));
    await promise;
  });

  it('removes the previous theme link when switching themes', async () => {
    const first = loader.loadTheme('light');

    lastLink().onload?.(new Event('load'));
    await first;

    const second = loader.loadTheme('nord');
    const nordLink = lastLink();

    expect(nordLink.href).toContain('/themes/nord.9c0d1e2f.css');

    nordLink.onload?.(new Event('load'));
    await second;

    const remaining = document.head.querySelectorAll<HTMLLinkElement>('link[data-theme]');

    expect(remaining.length).toBe(1);
    expect(remaining[0]?.dataset['theme']).toBe('nord');
  });

  it('rejects when the stylesheet fails to load', async () => {
    const promise = loader.loadTheme('claude');
    const link = lastLink();

    link.onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow('Failed to load theme "claude"');
  });

  // A failed load used to leave its <link> in document.head, so every
  // failed theme switch accumulated an element holding a stylesheet reference.
  // Asserted as a PROPERTY — "no <link> survives a load that did not succeed" —
  // so it holds for any theme id, any number of failures, and any success path.
  it('leaves no <link> in document.head after a failed load', async () => {
    const promise = loader.loadTheme('claude');

    lastLink().onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow();

    expect(document.head.querySelectorAll('link[data-theme]').length).toBe(0);
  });

  it('leaves no accumulation over repeated failed loads', async () => {
    for (const themeId of ['claude', 'light', 'nord']) {
      const promise = loader.loadTheme(themeId);

      lastLink().onerror?.(new Event('error'));
      await expect(promise).rejects.toThrow();
    }

    expect(document.head.querySelectorAll('link[data-theme]').length).toBe(0);
  });

  it('still keeps the successful theme applied after a failed one', async () => {
    const ok = loader.loadTheme('light');

    lastLink().onload?.(new Event('load'));
    await ok;

    const failed = loader.loadTheme('claude');

    lastLink().onerror?.(new Event('error'));
    await expect(failed).rejects.toThrow();

    const remaining = document.head.querySelectorAll<HTMLLinkElement>('link[data-theme]');

    expect(remaining.length).toBe(1);
    expect(remaining[0]?.dataset['theme']).toBe('light');
  });
});
