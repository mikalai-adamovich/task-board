/**
 * Tests for the header help menu's "Hotkeys" item.
 *
 * The item must be the FIRST entry in the menu and must open the shortcut-help
 * dialog by delegating to the root-provided {@link KeyboardShortcuts} service —
 * the same instance the app shell's dialog `[state]` binding reads from.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { KeyboardShortcuts } from '@app/shared/keyboard-shortcuts/keyboard-shortcuts';
import { clickUntil, settle } from '@app/shared/testing/zoneless';
import { HelpMenu } from './help-menu';

/**
 * KeyboardShortcuts now also coordinates the `m`/`w`/`p`
 * dropdown hotkeys and pulls in ProjectStore/PreferencesStore/BoardClient.
 * This spec only exercises the help-dialog delegation, so a minimal stub
 * keeps it free of those dependencies.
 */
function stubShortcuts(): Pick<KeyboardShortcuts, 'helpOpen' | 'openHelp' | 'closeHelp'> {
  const helpOpen = signal(false);

  return { helpOpen, openHelp: () => helpOpen.set(true), closeHelp: () => helpOpen.set(false) };
}

describe('HelpMenu', () => {
  let service: KeyboardShortcuts;

  async function setup(): Promise<ReturnType<typeof TestBed.createComponent<HelpMenu>>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { en: { header: { help: 'Help', hotkeys: 'Hotkeys' } } },
          preloadLangs: true,
        }),
        HelpMenu,
      ],
      providers: [provideRouter([]), { provide: KeyboardShortcuts, useValue: stubShortcuts() }],
    });

    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    service = TestBed.inject(KeyboardShortcuts);

    const fixture = TestBed.createComponent(HelpMenu);

    await settle(fixture);

    return fixture;
  }

  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  it('opens the help dialog when the Hotkeys item is clicked', async () => {
    const fixture = await setup();
    const trigger = fixture.nativeElement.querySelector('button');

    expect(trigger).toBeTruthy();

    await clickUntil(
      () => trigger.click(),
      () => expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
    );

    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    // TranslocoTestingModule may render the raw key (e.g. "en.header.hotkeys")
    const hotkeysItem = items.find((el) => el.textContent?.toLowerCase().includes('hotkeys'));

    expect(hotkeysItem).toBeTruthy();
    expect(service.helpOpen()).toBe(false);

    await clickUntil(
      () => hotkeysItem?.click(),
      () => expect(service.helpOpen()).toBe(true),
    );
  });

  it('lists Hotkeys as the FIRST item in the menu', async () => {
    const fixture = await setup();
    const trigger = fixture.nativeElement.querySelector('button');

    await clickUntil(
      () => trigger.click(),
      () => expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
    );

    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

    expect(items.length).toBeGreaterThan(1);
    expect(items[0]?.textContent?.toLowerCase()).toContain('hotkeys');
  });
});
