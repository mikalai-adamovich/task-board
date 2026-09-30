import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for `ui/scripts/check-i18n.mjs` — the i18n completeness gate.
 *
 * The script is a standalone Node CLI (not a TS module under `src/`), so rather than
 * importing its internals we spawn it against a throwaway fixture tree via its
 * `--i18n-dir` / `--src-dir` flags and assert on the exit code + stderr. That exercises
 * the real CLI contract — the thing CI actually depends on — including the process
 * exit status that makes the gate blocking.
 *
 * The important case is the injected-missing-key test: a key that code references but
 * that no locale defines. That is the missing-key bug class, and it is precisely what the
 * previous cross-locale-only implementation could never detect.
 */

// <ui>/src/app/shared/testing → <ui>
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = join(uiRoot, 'scripts', 'check-i18n.mjs');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runChecker(i18nDir: string, srcDir: string, extraArgs: string[] = []): Run {
  try {
    const stdout = execFileSync('node', [script, '--i18n-dir', i18nDir, '--src-dir', srcDir, ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };

    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('check-i18n gate', () => {
  let root: string;
  let i18nDir: string;
  let srcDir: string;
  const en = { home: { title: 'Home' }, common: { cancel: 'Cancel' } };
  const de = { home: { title: 'Startseite' }, common: { cancel: 'Abbrechen' } };

  /**
   * A fixture `app.config.ts` declaring `availableLangs`. Check 3 reads the REAL
   * config, so the fixture tree needs one — the default is every test starts
   * from, and the cases that exercise the check overwrite it.
   */
  function writeAppConfig(langs: string[]): void {
    mkdirSync(join(srcDir, 'app'), { recursive: true });

    const entries = langs.map((id) => `          { id: '${id}', label: '${id.toUpperCase()}' },`).join('\n');

    writeFileSync(
      join(srcDir, 'app', 'app.config.ts'),
      `export const config = {\n  availableLangs: [\n${entries}\n  ],\n};\n`,
      'utf8',
    );
  }

  function writeI18n(locale: string, data: unknown): void {
    writeFileSync(join(i18nDir, `${locale}.json`), JSON.stringify(data, null, 2), 'utf8');
  }

  function writeSrc(name: string, content: string): void {
    writeFileSync(join(srcDir, name), content, 'utf8');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-i18n-'));
    i18nDir = join(root, 'i18n');
    srcDir = join(root, 'src');
    mkdirSync(i18nDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    // The two locales every case below ships, unless it says otherwise.
    writeAppConfig(['en', 'de']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when code keys exist in every locale', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 missing');
  });

  it('FAILS when a key is used in code but missing from en.json', () => {
    // The missing-key bug class: every locale is internally consistent, so a
    // cross-locale-only diff reports OK while the user sees a raw dotted key.
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('home.html', `<h1>{{ 'auth.resetPassword.passwordsNotMatch' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('auth.resetPassword.passwordsNotMatch');
    expect(result.stderr).toContain('missing from en.json');
  });

  it('FAILS when a key is in en.json but absent from another locale', () => {
    writeI18n('en', { ...en, common: { ...en.common, save: 'Save' } });
    writeI18n('de', de); // missing common.save
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[de] missing key: common.save');
  });

  it('FAILS when a locale carries a key en.json does not define', () => {
    writeI18n('en', en);
    writeI18n('de', { ...de, legacy: { removed: 'Alt' } });
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('legacy.removed');
  });

  it('does not fail on unused keys by default, but reports them', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`); // common.cancel unused

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('common.cancel');
    expect(result.stdout).toContain('non-blocking');
  });

  it('fails on unused keys with --fail-on-unused', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir, ['--fail-on-unused']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('common.cancel');
  });

  it('ignores dotted literals that are not translation keys', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    // `board.kind` shares no namespace with en.json, and `2026.01` is not a
    // key-shaped literal — neither should be treated as a missing translation.
    writeSrc('thing.ts', `const a = 'board.kind'; const b = '2026.01'; const c = 'task.name';`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
  });

  it('excludes spec files from the code scan', () => {
    // Specs ship their own TranslationsMock fixtures; keys there intentionally
    // need not exist in the catalogue.
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('thing.spec.ts', `const k = 'home.notInCatalogue';`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
  });

  it('FAILS for a key in a brand-new namespace used via the transloco pipe', () => {
    // The namespace does not exist in en.json at all, so the namespace-anchored rule
    // alone would skip it. The marker rule is what keeps this class from slipping through.
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('billing.html', `<p>{{ 'billing.invoiceDue' | transloco }}</p>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('billing.invoiceDue');
  });

  it('does not treat a double-quoted HTML attribute value as a key', () => {
    // `[value]="opt.value"` looks like a string literal to a naive regex but is an
    // attribute value; only `*Key="..."` attributes count in templates.
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('list.html', `<option [value]="opt.value">{{ opt.labelKey | transloco }}</option>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
  });

  it('treats a *Key= attribute as a translation key', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('dialog.html', `<ui-confirm-dialog titleKey="home.missingTitle"></ui-confirm-dialog>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('home.missingTitle');
  });

  it('fails when a locale file is invalid JSON', () => {
    writeI18n('en', en);
    writeFileSync(join(i18nDir, 'de.json'), '{ not json', 'utf8');
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
  });

  // ── check 3: the locale files ⇄ the languages the app offers ─────────────────

  it('FAILS when the switcher offers a language with no locale file', () => {
    // The untranslated-string defect class: the language exists in the UI's switcher only, so
    // picking it 404s on the first render and nothing says so.
    writeI18n('en', en);
    writeI18n('de', de);
    writeAppConfig(['en', 'de', 'ja']);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the language switcher offers 'ja' but there is no ja.json`);
  });

  it('FAILS when a locale file is shipped that the switcher never offers', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeI18n('ru', { ...de });
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ru.json is shipped but');
  });

  it('FAILS when availableLangs lists the same language twice', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeAppConfig(['en', 'de', 'de']);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`availableLangs lists 'de' twice`);
  });

  it('FAILS when the app config cannot be read, rather than skipping the check', () => {
    // A gate that silently stops checking when its input moves is worse than no
    // gate: the check must fail loudly so the flag is fixed with the file.
    writeI18n('en', en);
    writeI18n('de', de);
    rmSync(join(srcDir, 'app', 'app.config.ts'), { force: true });
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read the app config');
  });

  it('passes when the offered languages and the locale files agree', () => {
    writeI18n('en', en);
    writeI18n('de', de);
    writeSrc('home.html', `<h1>{{ 'home.title' | transloco }}</h1>`);

    const result = runChecker(i18nDir, srcDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 locales, 2 offered');
  });
});
