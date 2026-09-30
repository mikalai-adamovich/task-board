/**
 * The refuted `connectTimeoutMS` mechanism must not come back.
 *
 * `server/src/db/mongo.ts` carries the truth: driver 7.6.0 applies
 * `connectTimeoutMS` to the socket only while a connection is being
 * ESTABLISHED (`cmap/connect.js:303`) and clears it in the `finally` (`:337`),
 * so it cannot kill an established pooled connection. The narrative that grew
 * around the opposite claim — that the setting was an idle-socket timeout and
 * that removing it fixed the periodic latency spikes — was refuted by that
 * source, and the spikes are still unexplained.
 *
 * A code comment does not stop a document from asserting the refuted mechanism
 * again: `product-analysis/100-performance-optimizations.md` still carried it
 * in three places (§2.7's "ROOT CAUSE … causal proof … fix", §4.6's
 * "effective idle threshold is min(both)", §4.9's "correlates with the ~30 s
 * idle socket closure") long after the code comment was corrected. This test
 * names those claims verbatim, so restoring any one of them fails the build
 * instead of quietly becoming the accepted explanation again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const NARRATIVE = join(REPO, 'product-analysis', '100-performance-optimizations.md');
const MONGO = join(REPO, 'server', 'src', 'db', 'mongo.ts');
/**
 * Each entry is a phrase the refuted narrative used, quoted as it was written.
 * The check is a plain substring search rather than a topic search on purpose:
 * a guardrail that has to re-derive "does this sentence assert the refuted
 * mechanism" is a guardrail that eventually passes the thing it exists to
 * reject.
 */
const REFUTED_CLAIMS = [
  '### 2.7 ROOT CAUSE of latency spikes',
  '**Mechanism (proven via driver events',
  '**Causal proof:**',
  '**Fix:** the non-default `connectTimeoutMS` was removed',
  'the effective idle threshold is min(both)',
  'correlates with the ~30 s idle socket closure',
] as const;

describe('the refuted connection-timeout narrative stays refuted (N-12 / D-28)', () => {
  const narrative = readFileSync(NARRATIVE, 'utf8');

  it('the performance narrative no longer asserts the refuted mechanism', () => {
    const present = REFUTED_CLAIMS.filter((claim) => narrative.includes(claim));

    expect(
      present,
      'product-analysis/100-performance-optimizations.md asserts a mechanism that mongodb@7.6.0 does not have — see server/src/db/mongo.ts',
    ).toEqual([]);
  });

  it('the withdrawal is stated, so the correction is on the record', () => {
    // Deleting the claim without recording that it was refuted would let the
    // next reader re-derive it, which is what happened in the first place.
    expect(narrative, 'the narrative must say the explanation was withdrawn').toMatch(/WITHDRAWN|REFUTED/);
  });

  it('the code comment still carries the refutation and the driver line numbers', () => {
    // The setting itself is deliberately untouched (item 30: a documentation
    // hand-back, not a settings change). What must survive is the reason: a
    // comment that lost the refutation is how the refuted claim gets written
    // down again.
    const mongo = readFileSync(MONGO, 'utf8');

    expect(mongo).toMatch(/REFUTED/);
    expect(mongo).toContain('cmap/connect.js');
    expect(mongo).toMatch(/maxIdleTimeMS: 30_000/);
  });
});
