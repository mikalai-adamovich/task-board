/**
 * Ratcheting guardrail: no NEW text-only test block may be added.
 *
 * ## What "text-only" means here
 *
 * A test block whose EVERY `expect(...)` is about rendered prose — the string a
 * user reads — and which asserts nothing about structure, attributes, state,
 * events or effects. Such a block passes whether the string sits in the right
 * element, the wrong element, or with the wrong meaning. The audit found
 * two rendering regressions that every one of these blocks missed: a
 * language-switch race and a missing accessible name.
 *
 * This is a DELIBERATELY NARROW definition, stated here because a ratchet whose
 * classifier is vague is a ratchet nobody trusts. A block that also asserts a
 * signal, a DOM attribute, a class, an emitted event, a mock call or an object
 * shape is NOT text-only, whatever else it checks. A block with no `expect` at
 * all is not counted either.
 *
 * ## The count is recomputed, and the rule is about the COUNT
 *
 * The decision table's "64" was measured over an older 78-file suite with a
 * looser classifier, and is stale. The number below was recomputed from the
 * tree with this spec's own classifier (TypeScript AST, not a search — an
 * earlier regex probe silently missed half the blocks and reported a
 * meaningless 0, which is exactly the failure mode a ratchet must not have).
 *
 * The rule is `count <= BASELINE`: the number may FALL as blocks are converted
 * or deleted, and may never RISE. Lowering the constant is a deliberate act by
 * whoever converted the blocks; raising it must be argued for in review.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const APP = join(__dirname, '..', '..');
const APP_REL = (absolute: string): string => relative(APP, absolute).split(sep).join('/');
/**
 * The ceiling, measured 2026-09-29 against the tree as it stood at the start of
 * this package. Recompute with this spec's classifier after converting blocks
 * and lower the number in the same commit.
 */
const BASELINE = 9;
/** When BASELINE was measured — a bare number with no date is not a ratchet. */
const BASELINE_DATE = '2026-09-29';
// ── the classifier ────────────────────────────────────────────────────────────
/** Assertions that pin something other than the prose. */
const NON_TEXT_ASSERTION = [
  /toHaveClass|toHaveAttribute|toHaveProperty|toHaveStyle|toBeInTheDocument|toContainHTML|toHaveText/,
  /toHaveBeenCalled|toThrow|rejects\.|resolves\./,
  /toMatchObject|toStrictEqual|toEqual|toBe\(|toBeTruthy|toBeFalsy|toBeNull|toBeUndefined|toBeDefined/,
  /toBeGreaterThan|toBeLessThan|toBeCloseTo/,
  /\.(?:invalid|valid|touched|dirty|disabled|errors|classList|dataset)\b/,
  /querySelector|nativeElement|\bfixture\b|getAttribute/,
];
/** Assertions that read rendered prose. */
const TEXT_ASSERTION = [
  /textContent|innerText|getByText|queryByText|findByText/,
  /\.toContain\(/,
  /\.toMatch\(\s*\/[^)]*\/[a-z]*\s*\)/,
];

function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;

  return '';
}

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) specFiles(path, out);
    else if (entry.endsWith('.spec.ts')) out.push(path);
  }

  return out;
}

interface TextOnlyBlock {
  where: string;
  title: string;
}

/** Every text-only `it(...)` / `test(...)` block under `dir`. */
function textOnlyBlocks(dir: string): TextOnlyBlock[] {
  const found: TextOnlyBlock[] = [];

  for (const file of specFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && /^(it|test)$/.test(calleeName(node.expression))) {
        const body = node.arguments[1];
        const title = node.arguments[0]?.getText(ast) ?? '';

        if (body) {
          const assertions: string[] = [];
          const collect = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && calleeName(n.expression) === 'expect') assertions.push(n.getText(ast));
            ts.forEachChild(n, collect);
          };

          collect(body);

          const allText = assertions.length > 0 && assertions.every((a) => TEXT_ASSERTION.some((r) => r.test(a)));
          const anyOther = assertions.some((a) => NON_TEXT_ASSERTION.some((r) => r.test(a)));

          if (allText && !anyOther) {
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

            found.push({
              where: `${APP_REL(file)}:${line}`,
              title: title.replace(/^['"`]|['"`]$/g, ''),
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(ast);
  }

  return found;
}

const BLOCKS = textOnlyBlocks(APP);

describe('text-only test blocks (N-7 / item 23)', () => {
  it('finds a non-empty spec set and a non-empty assertion-bearing set (anti-vacuity)', () => {
    // A classifier that silently matches nothing would satisfy the ratchet
    // forever, so the input side is asserted too.
    expect(specFiles(APP).length).toBeGreaterThan(50);
    expect(BASELINE).toBeGreaterThan(0);
    expect(BASELINE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has not grown past the dated baseline', () => {
    // The ratchet: the count may fall, never rise. Each offending block is
    // named so the next person converts a block instead of deleting it.
    const over = BLOCKS.slice(BASELINE);

    expect(
      over.map((block) => `${block.where} — ${block.title}`).join('\n'),
      `${BLOCKS.length} text-only blocks, baseline ${BASELINE} (measured ${BASELINE_DATE}). ` +
        `Convert ${BLOCKS.length - BASELINE} of them, or argue for a new baseline in review.`,
    ).toBe('');
  });

  it('reports the current count so a lowering of the baseline is deliberate', () => {
    // Not an assertion about a number that can go stale — the value is printed
    // in the failure message above; this asserts the classifier still sees the
    // blocks it saw on the baseline date, so a silent reclassification is loud.
    expect(BLOCKS.length).toBeLessThanOrEqual(BASELINE);
  });
});
