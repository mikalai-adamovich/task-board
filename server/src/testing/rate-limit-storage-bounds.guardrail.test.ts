/**
 * The counter collection is bounded by TIME, and must stay uncapped by COUNT.
 *
 * Two claims in this repository can rot silently, and neither has a compiler:
 *
 *   1. **No global document cap exists, deliberately.** The TTL index bounds the
 *      collection by time — a document lives one window plus the grace after its
 *      last write — and the size is otherwise
 *      `document size × distinct scopes simultaneously live`
 *      (`docs/architecture.md` §2.7). A cap was considered and rejected: a shared
 *      ceiling is one contended quantity an attacker fills with cheap minted
 *      scopes, and every legitimate scope behind it is then refused by a limit
 *      that has nothing to do with its own budget. Adding one back would be a
 *      silent decision no reviewer would read as one, so it fails the build here
 *      instead. Any such gate needs a count the store never takes, so the scan is
 *      on the OPERATIONS, not on a phrase.
 *   2. **`DEFAULT_MAX_KEYS` is not that cap and never was.** It bounds the
 *      process-local advisory map. Presenting a per-isolate memory cap as a
 *      collection bound is the specific misreading this repository has already
 *      had to correct once, so the docblock that states the number is asserted
 *      to state its scope too — a reword that drops the scope is caught.
 *
 * Comments are stripped before every scan, so documenting a cap cannot satisfy
 * one and describing one cannot trip this.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `server/src/testing` -> `server/src` -> `server/` -> repo root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(ROOT, 'server', 'src');
/** Strip comments, so a docblock can neither satisfy nor trip a scan. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
const read = (...segments: string[]): string => readFileSync(join(SRC, ...segments), 'utf8');
/** The modules that can reach the collection: the repository and its one caller. */
const COUNTER_PATH = [
  ['repositories', 'rate-limit-counter.repository.ts'],
  ['services', 'rate-limit-authority.service.ts'],
] as const;
/**
 * Operations a size-based gate would have to use. None of them is the counter's
 * own single `findOneAndUpdate`, so each appearing in the counter path means
 * somebody is reading the collection's size, counting documents, or deleting
 * documents — the three shapes of a cap or an eviction.
 */
const SIZE_OPERATIONS = [
  'countDocuments',
  'estimatedDocumentCount',
  'collStats',
  '.stats(',
  'distinct(',
  'deleteMany',
  'deleteOne',
  'bulkWrite',
] as const;

describe('rate_limit_counters is bounded by TTL, not by a document cap', () => {
  it('no module in the counter path reads or trims the collection size', () => {
    const offenders = COUNTER_PATH.flatMap((segments) =>
      SIZE_OPERATIONS.filter((operation) => code(read(...segments)).includes(operation)).map(
        (operation) => `${segments.join('/')} uses ${operation}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('the store still writes exactly one document per probe, through one operation', () => {
    // The negative scan above is only honest while the write path is still the
    // single atomic upsert it is documented to be. A second write operation is
    // where an eviction or a trim would be introduced, so its absence is what
    // makes "no cap" a structural fact rather than a claim.
    const repository = code(read('repositories', 'rate-limit-counter.repository.ts'));
    const writes = repository.match(/collection\.\w+\(/g) ?? [];

    expect(writes).toEqual(['collection.findOneAndUpdate(']);
  });
});

describe('DEFAULT_MAX_KEYS states the scope of the number it bounds', () => {
  const limiter = read('utils', 'rate-limiter.ts');
  const docblock = limiter.slice(limiter.lastIndexOf('/**', limiter.indexOf('export const DEFAULT_MAX_KEYS')));

  it('declares it a bound on process memory', () => {
    expect(docblock).toMatch(/PROCESS MEMORY/i);
  });

  it('says outright that it is not a bound on the stored counters', () => {
    // The misreading this assertion exists to prevent: a 5 000-key cap is a
    // plausible-looking storage ceiling, and the collection's actual size has
    // nothing to do with it.
    //
    // `[\s*]*` rather than a space or a plain `\s+`: prose wraps AND the
    // emphasis markers sit inside the sentence, so neither a reword nor a
    // bolded word may decide whether this assertion passes.
    expect(docblock).toMatch(/not[\s*]+a[\s*]+bound[\s*]+on[\s*]+the[\s*]+collection/i);
    expect(docblock).toMatch(/one[\s*]+document[\s*]+per[\s*]+bucket\/scope[\s*]+pair/i);
  });
});

describe('the storage calculation is written down, and is dated', () => {
  const architecture = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8');
  const section = architecture.slice(architecture.indexOf('### 2.7'));

  it('the section exists and states the TTL horizon and the absence of a cap', () => {
    expect(section.length).toBeGreaterThan(0);
    // A document's life is the window plus the grace, which is what makes the
    // count term bounded without a count limit.
    expect(section).toMatch(/one window plus the grace after its last write/i);
    expect(section).toMatch(/no global document cap/i);
  });

  it('records the measured per-document size, the budget it is compared to, and the date', () => {
    expect(section).toMatch(/\d+\s*B/);
    expect(section).toMatch(/0\.5 GB/);
    // A measurement with no date cannot be re-measured against a changed
    // ceiling, and the ceilings ARE the input to it.
    expect(section).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('names all four buckets, so the cardinality table cannot lose one silently', () => {
    for (const bucket of ['login-account', 'login-source', 'register-source', 'forgot-email-ip']) {
      expect(section, `docs/architecture.md §2.7 must cover ${bucket}`).toContain(bucket);
    }
  });
});
