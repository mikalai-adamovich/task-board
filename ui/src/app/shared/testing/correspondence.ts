/**
 * The correspondence assertion, UI-side copy of `server/src/testing/correspondence.ts`.
 *
 * ## Why this file exists
 *
 * The two test trees are separate compilation units with separate `vitest`
 * runtimes, so the server helper is not importable here. The duplication is
 * deliberate: a shared "framework" for a two-function assertion would be an
 * abstraction to maintain, not to remove. Keep the two copies in step — the
 * failure-message shape below is intentionally identical to the server one so a
 * drift report reads the same wherever it was produced.
 *
 * ## The property (not the shape)
 *
 * A guardrail that keeps a hand-written list — page templates, locale ids,
 * route registrations — is only as good as that list's correspondence to the
 * artefact it enumerates. Two trusted UI guardrails were written that way and
 * had **already** stopped covering what they claimed, with nothing red:
 *
 *   - `document-structure.spec.ts` carried a 32-entry page-template literal
 *     whose only self-check asserted that each listed path still existed. It
 *     listed three templates that no route renders, and did not list the one
 *     routed page whose heading lives in a child component, so that page was
 *     never checked at all;
 *   - `check-i18n.mjs` derived the locale set from the directory on disk and
 *     never compared it to the `availableLangs` the app actually offers, so a
 *     language added in one place only was invisible.
 *
 * For a declared list and a derived list of string keys this asserts:
 *
 *   1. **liveness both ways by default** — every derived entry has a declared
 *      row, and every declared row still matches something derived;
 *   2. **no duplicates** on either side, so a copy-pasted row cannot silently
 *      stand in for two;
 *   3. **exemptions must be justified** — an entry allowed to exist in
 *      `derived` without a row carries a reason, so the exception list is never
 *      a bare set of names.
 *
 * It asserts nothing about how many entries there are, nor about any
 * particular entry: a 31st page or a 12th locale is a legitimate change that
 * must pass, while anything appearing on exactly one side must fail.
 */
import { expect } from 'vitest';

export interface CorrespondenceOptions {
  /**
   * Also fail on a declared row that no longer matches anything derived.
   * Default `true` (a two-way correspondence). Pass `false` where the derived
   * side is intentionally broader than the declared list.
   */
  bothDirections?: boolean;
  /**
   * Derived entries deliberately absent from the declared list, each mapped to
   * the reason. An entry without a reason is treated as undeclared, so an
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

  expect(new Set(declared).size, `${label}: the declared list contains duplicate entries`).toBe(declared.length);
  expect(new Set(derived).size, `${label}: the derived list contains duplicate entries`).toBe(derived.length);

  const declaredSet = new Set(declared);
  const derivedSet = new Set(derived);
  const undeclared = [...derivedSet].filter((entry) => !declaredSet.has(entry) && exempt[entry] === undefined).sort();
  const missing = bothDirections ? [...declaredSet].filter((entry) => !derivedSet.has(entry)).sort() : [];

  expect(
    { undeclared, missing },
    `${label}: the declared list and the derived list disagree — ` +
      `"undeclared" exist in the source but have no row, "missing" rows exist in the list but no longer ` +
      'in the source',
  ).toEqual({ undeclared: [], missing: [] });
}

/**
 * The `bothDirections: false` direction, for a derived list that is
 * deliberately wider than the declared one. Named so the intent is visible at
 * the call site instead of hidden in an option literal.
 */
export function assertDeclaredCoversDerived(
  label: string,
  declared: readonly string[],
  derived: readonly string[],
  exempt: Readonly<Record<string, string>> = {},
): void {
  assertCorrespondence(label, declared, derived, { bothDirections: false, exempt });
}
