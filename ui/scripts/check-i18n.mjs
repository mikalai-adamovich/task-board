// check:i18n — i18n completeness gate. No dependencies — plain Node.
//
// Four checks, three of which are blocking:
//
//   1. code → en      Every dotted string literal in ui/src whose root segment is a
//                     top-level namespace of en.json must exist in en.json. This is the
//                     check the previous version was structurally unable to perform: it
//                     diffed locales against EACH OTHER, so a key missing from all 11
//                     (a raw dotted key rendered to the user) was invisible. (F-903 / M-903)
//   2. en → locales   Every key in en.json must exist in every other locale, and a locale
//                     must not carry keys en.json does not have. en.json is the source of
//                     truth, NOT the union of all locales.
//   3. locale files ⇄ the languages the app offers (FX3 / D-46). The previous version
//                     derived the locale set from the directory and never compared it to
//                     `availableLangs` in app.config.ts, so a language added in ONE place
//                     only was invisible in both directions: a `ja.json` with no `ja` entry
//                     in the switcher (a file no user can ever reach), or a switcher entry
//                     with no file (a 404 the first time the user picks it). Both are
//                     checked here, from the real config.
//   4. unused         Keys in en.json that no code references. Reported, non-blocking:
//                     a key can legitimately be resolved dynamically (e.g.
//                     `priorityLabelKey()` reads `TASK_PRIORITY_CONFIG[].i18nKey`), so
//                     treating this as an error would produce false positives. Use
//                     --fail-on-unused to turn it into a gate once the catalogue is pruned.
//
// Usage:
//   node scripts/check-i18n.mjs [--i18n-dir <dir>] [--src-dir <dir>]
//                               [--app-config <file>] [--fail-on-unused]
//
// The directory flags exist so the checker can be exercised against a fixture tree by
// its own unit test (src/app/shared/testing/check-i18n.spec.ts) instead of only against
// the real repository. `--app-config` points at the file that declares `availableLangs`;
// it defaults to `<src-dir>/app/app.config.ts` and a MISSING file is a hard failure rather
// than a skipped check — a gate that silently stops checking is worse than no gate.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultI18nDir = join(scriptDir, '..', 'public', 'assets', 'i18n');
const defaultSrcDir = join(scriptDir, '..', 'src');

/** Source locale — the one every other locale is derived from and diffed against. */
const SOURCE_LOCALE = 'en';

/** Spec files are excluded from the code scan: their TranslationsMock fixtures
 *  contain keys that intentionally do not (and should not) exist in the catalogue. */
const SOURCE_EXTS = ['.ts', '.html'];
const SOURCE_EXCLUDE = [/\.spec\.ts$/, /\.test\.ts$/];

/**
 * Dotted literals that live in ui/src but are NOT translation keys, yet whose root
 * segment collides with a catalogue namespace. Kept explicit (rather than silently
 * skipped) so a new collision is a conscious decision.
 */
const NON_TRANSLATION_LITERALS = new Set([
  // add `<key>` here with a one-line reason if the code scan reports a false positive
]);

function parseArgs(argv) {
  const opts = { i18nDir: defaultI18nDir, srcDir: defaultSrcDir, appConfig: null, failOnUnused: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--i18n-dir') opts.i18nDir = resolve(argv[++i] ?? '');
    else if (arg === '--src-dir') opts.srcDir = resolve(argv[++i] ?? '');
    else if (arg === '--app-config') opts.appConfig = resolve(argv[++i] ?? '');
    else if (arg === '--fail-on-unused') opts.failOnUnused = true;
  }

  if (!opts.appConfig) opts.appConfig = join(opts.srcDir, 'app', 'app.config.ts');

  return opts;
}

/**
 * The language ids the app actually offers, read from the Transloco
 * `availableLangs` array. This is the SECOND source of truth for the locale set
 * (the first being the files on disk); check 3 exists to keep them in step.
 *
 * The ids are read structurally — every `{ id: '<x>' … }` entry inside the
 * `availableLangs: [ … ]` literal — rather than by matching a known list, so a
 * newly invented language is judged by the same two rules with no edit here.
 */
export function collectAvailableLangs(configSource) {
  const block = /availableLangs\s*:\s*\[([\s\S]*?)\]/.exec(configSource);

  if (!block) return null;

  return [...block[1].matchAll(/\bid\s*:\s*['"]([^'"]+)['"]/g)].map(([, id]) => id);
}

/** Flatten a nested translation object into dot-separated leaf key paths. */
export function flattenKeys(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenKeys(value, path, out);
    } else {
      out.add(path);
    }
  }

  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);

    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXTS.some((ext) => entry.endsWith(ext)) && !SOURCE_EXCLUDE.some((re) => re.test(entry))) {
      out.push(p);
    }
  }

  return out;
}

// A dotted key: starts with a letter, contains at least one `.`, and every segment is
// [A-Za-z0-9_]. This deliberately excludes CSS classes (`a.b` never appears as
// `text-sm`), paths, and version/date strings.
const KEY = String.raw`[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+`;

// In a template, `{{ 'x.y' | transloco }}` is single/backtick quoted, but a plain
// double-quoted attribute is a VALUE, not a JS string — `[value]="opt.value"` must not
// be read as the string literal `opt.value`. So for templates we only take
// single/backtick-quoted runs, plus double-quoted values of `*Key=` attributes
// (`titleKey="members.removeMemberTitle"`), which ARE translation keys.
const HTML_LITERAL_RE = new RegExp(String.raw`(['\x60])(${KEY})\1|(\b\w*Key\s*=\s*")(${KEY})(")`, 'g');

// In TypeScript every quote style is a genuine string literal.
const TS_LITERAL_RE = new RegExp(String.raw`(['"\x60])(${KEY})\1`, 'g');

// A line carrying one of these markers is a "translation usage site": a dotted literal
// on such a line is a translation key EVEN IF its root segment is not (yet) a namespace
// in the catalogue. This closes the one blind spot of the namespace rule: a brand-new
// namespace (e.g. `billing.invoiceDue` when en.json has no `billing` section at all)
// would otherwise be silently ignored. Marker-gating keeps this from flagging arbitrary
// dotted strings that merely sit on the same line as unrelated code.
const TRANSLOCO_MARKER_RE =
  /\|\s*transloco\b|transloco\.|translate\(|getErrorMessage\(|\bnotify\.|\b\w*Key\s*=|\bmessage\s*:\s*['"`]/;

/** Extract the key-shaped literals from one line, respecting file-type quoting rules. */
function extractKeys(line, isTemplate) {
  const re = isTemplate ? HTML_LITERAL_RE : TS_LITERAL_RE;
  const keys = [];

  re.lastIndex = 0;

  let m;

  while ((m = re.exec(line))) keys.push(m[2] ?? m[4]);

  return keys;
}

/**
 * Map<key, Set<"file:line">>> of every translation-key-shaped literal in `srcDir`.
 * A literal qualifies if its root segment is a catalogue namespace OR it appears on a
 * line marked as a translation usage site (see TRANSLOCO_MARKER_RE).
 */
export function collectReferencedKeys(srcDir, namespaces) {
  const refs = new Map();

  for (const file of walk(srcDir)) {
    const isTemplate = file.endsWith('.html');

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const marked = TRANSLOCO_MARKER_RE.test(line);

        for (const key of extractKeys(line, isTemplate)) {
          if (!namespaces.has(key.split('.')[0]) && !marked) continue;
          if (NON_TRANSLATION_LITERALS.has(key)) continue;
          if (!refs.has(key)) refs.set(key, new Set());
          refs.get(key).add(`${relative(srcDir, file)}:${i + 1}`);
        }
      });
  }

  return refs;
}

function fail(message) {
  console.error(`check:i18n — ${message}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const localeFiles = readdirSync(opts.i18nDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (localeFiles.length === 0) {
    fail(`no locale files found in ${opts.i18nDir}`);
  }

  if (!localeFiles.includes(`${SOURCE_LOCALE}.json`)) {
    fail(`source locale ${SOURCE_LOCALE}.json is missing from ${opts.i18nDir}`);
  }

  /** Map<locale, Set<key>> */
  const keysByLocale = new Map();

  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/, '');
    let json;

    try {
      json = JSON.parse(readFileSync(join(opts.i18nDir, file), 'utf8'));
    } catch (err) {
      fail(`${file} is not valid JSON: ${err.message}`);
    }

    keysByLocale.set(locale, flattenKeys(json));
  }

  const enKeys = keysByLocale.get(SOURCE_LOCALE);
  const namespaces = new Set([...enKeys].map((k) => k.split('.')[0]));
  const errors = [];

  // ── 1. code → en.json ───────────────────────────────────────────────────────
  const refs = collectReferencedKeys(opts.srcDir, namespaces);
  const missingInSource = [...refs.keys()].filter((k) => !enKeys.has(k)).sort();

  for (const key of missingInSource) {
    errors.push(`  [code] key used in ${[...refs.get(key)].join(', ')} but missing from ${SOURCE_LOCALE}.json: ${key}`);
  }

  // ── 2. en.json → every other locale ──────────────────────────────────────────
  for (const [locale, keys] of keysByLocale) {
    if (locale === SOURCE_LOCALE) continue;

    for (const key of enKeys) {
      if (!keys.has(key)) errors.push(`  [${locale}] missing key: ${key}`);
    }

    for (const key of keys) {
      if (!enKeys.has(key)) errors.push(`  [${locale}] key not present in ${SOURCE_LOCALE}.json: ${key}`);
    }
  }

  // ── 3. the locale files ⇄ the languages the app offers, BOTH ways ───────────
  let appConfigSource;

  try {
    appConfigSource = readFileSync(opts.appConfig, 'utf8');
  } catch (err) {
    fail(`cannot read the app config that declares availableLangs: ${opts.appConfig} (${err.message})`);
  }

  const availableLangs = collectAvailableLangs(appConfigSource);

  if (availableLangs === null || availableLangs.length === 0) {
    fail(`no availableLangs entries found in ${opts.appConfig} — the locale correspondence cannot be checked`);
  }

  const offeredLangs = new Set(availableLangs);
  const shippedLangs = new Set([...keysByLocale.keys()]);

  for (const lang of [...offeredLangs].filter((l) => !shippedLangs.has(l)).sort()) {
    errors.push(
      `  [config] the language switcher offers '${lang}' but there is no ${lang}.json in ${opts.i18nDir} — ` +
        'picking it would 404 on the first render',
    );
  }

  for (const lang of [...shippedLangs].filter((l) => !offeredLangs.has(l)).sort()) {
    errors.push(`  [config] ${lang}.json is shipped but '${lang}' is not in availableLangs — no user can reach it`);
  }

  for (const [index, lang] of availableLangs.entries()) {
    if (availableLangs.indexOf(lang) !== index) errors.push(`  [config] availableLangs lists '${lang}' twice`);
  }

  if (!offeredLangs.has(SOURCE_LOCALE)) {
    errors.push(`  [config] availableLangs does not include the source locale '${SOURCE_LOCALE}'`);
  }

  // ── 4. unused keys in en.json (non-blocking by default) ──────────────────────
  const unused = [...enKeys].filter((k) => !refs.has(k)).sort();

  if (errors.length > 0) {
    console.error(`check:i18n — ${errors.length} i18n problem(s) found:\n`);
    for (const line of errors) console.error(line);
    console.error(`\nSource locale: ${SOURCE_LOCALE}.json · locales: ${keysByLocale.size}`);
    process.exit(1);
  }

  console.log(
    `check:i18n — OK: ${keysByLocale.size} locales, ${offeredLangs.size} offered, ` +
      `${enKeys.size} keys, ${refs.size} referenced in code, 0 missing.`,
  );

  if (unused.length > 0) {
    const label = opts.failOnUnused ? 'ERROR' : 'WARN (non-blocking)';

    console.log(`check:i18n — ${unused.length} key(s) in ${SOURCE_LOCALE}.json not referenced in code [${label}]:`);
    for (const key of unused) console.log(`  - ${key}`);

    if (opts.failOnUnused) process.exit(1);
  }
}

main();
