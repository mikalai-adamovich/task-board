/**
 * The correspondence assertion, shared by the server guardrails.
 *
 * ## Why this module exists
 *
 * A guardrail that keeps a hand-written table — route registrations, index
 * contracts, schema/domain value sets — is only as good as the table's
 * correspondence to the thing it enumerates. Six trusted server guardrails were
 * written that way and three of them had **already** stopped covering what they
 * claimed, with no gate red anywhere:
 *
 *   - `tenant-isolation.test.ts` had 54 rows while one id-bearing tenant-scoped
 *     route (`GET /api/projects/by-key/:key`) had none, so that route was
 *     asserted neither cross-tenant nor same-tenant;
 *   - `migrations.test.ts` matched query fragments **with comments not
 *     stripped**, so a row naming a query that had been deleted as dead code was
 *     satisfied by the comment that documented the deletion;
 *   - `shared-parity.test.ts` pinned the inviteable roles by a POSITIONAL slice
 *     of the shared tuple, so reordering the shared constant — a correct change
 *     — failed the suite, while a genuinely wrong role set passed.
 *
 * The fix is the same one line everywhere: the table must assert its own
 * correspondence to a list **derived from the artefact it enumerates**. That is
 * what this module expresses, so six call sites share one implementation and one
 * failure message shape.
 *
 * ## What it asserts (the property, not the shape)
 *
 * For a declared table `declared` and a derived list `derived` of string keys:
 *
 *   1. **liveness both ways by default** — every derived entry has a declared
 *      row, and every declared row still matches something derived;
 *   2. **no duplicates** in either list, so a copy-pasted row cannot silently
 *      stand in for two;
 *   3. **exemptions must be justified** — an entry that is allowed to exist in
 *      `derived` without a row needs a reason string, so the exception list is
 *      never a bare set of names.
 *
 * It deliberately asserts nothing about *how many* entries there are, nor about
 * any particular entry: adding a 12th cascade repository, a 55th route or a new
 * shared enum member is a legitimate change that must pass, while any of them
 * appearing on exactly one side of the correspondence must fail.
 */
import { expect } from 'vitest';

export interface CorrespondenceOptions {
  /**
   * Also fail on a declared row that no longer matches anything derived.
   * Default `true` (a two-way correspondence). Pass `false` where the derived
   * side is intentionally broader than the table — e.g. a scan that covers more
   * than the table enumerates.
   */
  bothDirections?: boolean;
  /**
   * Derived entries that are deliberately not in the declared table, each mapped
   * to the reason. An entry without a reason is treated as undeclared, so an
   * exemption can never be added silently.
   */
  exempt?: Readonly<Record<string, string>>;
}

export function assertCorrespondence(
  label: string,
  declared: readonly string[],
  derived: readonly string[],
  options: CorrespondenceOptions = {},
): void {
  const { bothDirections = true, exempt = {} } = options;

  expect(new Set(declared).size, `${label}: the declared table contains duplicate entries`).toBe(declared.length);
  expect(new Set(derived).size, `${label}: the derived list contains duplicate entries`).toBe(derived.length);

  const declaredSet = new Set(declared);
  const derivedSet = new Set(derived);
  const undeclared = [...derivedSet].filter((entry) => !declaredSet.has(entry) && exempt[entry] === undefined).sort();
  const missing = bothDirections ? [...declaredSet].filter((entry) => !derivedSet.has(entry)).sort() : [];

  expect(
    { undeclared, missing },
    `${label}: the declared table and the derived list disagree — ` +
      `"undeclared" exist in the source but have no row, "missing" rows exist in the table but no longer ` +
      'in the source',
  ).toEqual({ undeclared: [], missing: [] });
}

/**
 * The `bothDirections: false` direction used where the derived side is
 * deliberately wider than the table (a scan covering more sources than the table
 * enumerates). Named so the intent is visible at the call site instead of hiding
 * in an option literal.
 */
export function assertDeclaredCoversDerived(
  label: string,
  declared: readonly string[],
  derived: readonly string[],
  exempt: Readonly<Record<string, string>> = {},
): void {
  assertCorrespondence(label, declared, derived, { bothDirections: false, exempt });
}
