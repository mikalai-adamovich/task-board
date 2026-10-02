/**
 * Every declared permission action is enforced by at least one call site.
 *
 * The RBAC matrix is a table a reader trusts: a row naming `view_task` says
 * task reads are permission-checked, and a reader designing a new surface — or
 * an agent handed a tool contract — will rely on it. When the row has no
 * enforcement the table still says it, so the claim is a security-relevant lie
 * that no type, lint rule or test reported. Four such rows shipped
 * (`view_task`, `view_comment`, `manage_filters`, `view_task_history`): reads
 * are authorised by tenant and project scope (`assertProjectInTenant` /
 * `assertTenantEntity`) instead, so nothing enforced them and nothing broke
 * when they were deleted.
 *
 * ## The invariant
 *
 * The set of actions `PermissionAction` declares is exactly the set with an
 * enforcement site in production source. Adding an action to the union and the
 * matrix without adding the call site that checks it now fails the build, which
 * is the only thing that stops the rows returning one at a time.
 *
 * ## Why it lives here and not in `rules/`
 *
 * That file owns the AGENTS.md prose-MUSTs (P-01 … P-04) plus one scan of its
 * own; a scan of no such rule filed under it would give one fact two owners.
 * This is a cross-cutting scan over `services/`, `routes/` and `middleware/`
 * that asserts the shape of the matrix, which is what the other `testing/`
 * cross-cutting scans do.
 *
 * ## What counts as an enforcement site
 *
 * A string literal passed as an argument to a CALL. That is deliberately
 * broader than grepping `ensurePermission('…')`, because the seams forward the
 * action through a typed parameter: `task.service.ts`'s `assertTaskPermission`
 * and `sprint.service.ts`'s `assertSprintPermission` pass `action` down to
 * `ensurePermission`, `comment.service.ts`'s `ensureCommentAccess` takes an
 * `'edit_comment' | 'delete_comment'` parameter, and `project.service.ts`'s
 * `requireTenantPermission` passes it to `can()`. The literal sits at the
 * CALLER of the seam in every one of those, so "appears as a call argument"
 * sees the enforcement where "appears in an `ensurePermission` argument" would
 * not.
 *
 * The scan parses with the TypeScript compiler rather than stripping comments
 * and matching text, so a doc comment naming a removed action — which these
 * files legitimately do — can never satisfy the invariant, and the union's own
 * members and the matrix's own row keys are structurally not call arguments.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const MATRIX_FILE = join(SRC, 'services', 'rbac.service.ts');
const THIS_FILE = fileURLToPath(import.meta.url);
/** The seams a permission is allowed to reach the matrix through. */
const PERMISSION_SEAMS = new Set(['ensurePermission', 'requirePermission', 'can']);

function parseText(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parse(file: string): ts.SourceFile {
  return parseText(file, readFileSync(file, 'utf8'));
}

/** Production `.ts` under `server/src`, specs and this scan excluded. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(path);

        continue;
      }

      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      // A spec may build anything, and this scan would otherwise read its own
      // synthetic sources as evidence.
      if (path === THIS_FILE) continue;

      out.push(path);
    }
  };

  walk(SRC);

  return out.sort();
}

/** The actions the `PermissionAction` union declares, in declaration order. */
function declaredActions(source: ts.SourceFile): string[] {
  const actions: string[] = [];

  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== 'PermissionAction') continue;
    if (!ts.isUnionTypeNode(statement.type)) continue;

    for (const member of statement.type.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) actions.push(member.literal.text);
    }
  }

  return actions;
}

/** The keys of a `Record<…>` matrix literal, in declaration order. */
function matrixRows(source: ts.SourceFile, variableName: string): string[] {
  const rows: string[] = [];

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue;
      if (declaration.initializer === undefined || !ts.isObjectLiteralExpression(declaration.initializer)) continue;

      for (const property of declaration.initializer.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) rows.push(property.name.text);
      }
    }
  }

  return rows;
}

/** Every string literal passed as an argument to a call, in one source. */
function callArgumentLiterals(source: ts.SourceFile): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        if (ts.isStringLiteral(argument)) literals.push(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return literals;
}

/** The callee's own name, whether it was called bare or as a method. */
function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;

  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;

  return '';
}

/** Every string literal passed to a permission seam, in one source. */
function seamArgumentLiterals(source: ts.SourceFile): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (PERMISSION_SEAMS.has(calleeName(node))) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteral(argument)) literals.push(argument.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return literals;
}

describe('every declared permission action is enforced somewhere', () => {
  const matrix = parse(MATRIX_FILE);
  const declared = declaredActions(matrix);
  const enforced = new Set(
    productionSources()
      .map((file) => callArgumentLiterals(parse(file)))
      .flat()
      .filter((literal) => declared.includes(literal)),
  );

  it('reads the matrix, so an empty scan cannot make the assertion vacuous', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(enforced.size).toBeGreaterThan(10);
  });

  it('has no declared action that nothing enforces', () => {
    // The defect this file exists for: a row in a security-relevant table with
    // no call site behind it. The message names the action, because "the matrix
    // disagrees with the code" alone is not something anyone can act on.
    const unenforced = declared.filter((action) => !enforced.has(action));

    expect(
      unenforced,
      'these actions are declared in PermissionAction but no production call site ever checks them — wire the check or drop the row; a declared-but-unenforced action reads as a control and is not one',
    ).toEqual([]);
  });

  it('has no action enforced under a name the matrix does not declare', () => {
    // The other direction of the same fact. A seam reached with a name outside
    // the union lands in `can()`'s own `if (!allowedRoles) return false` — an
    // unconditional deny wearing a configured permission's name.
    const unknown = productionSources().flatMap((file) =>
      seamArgumentLiterals(parse(file))
        .filter((literal) => !declared.includes(literal))
        .map((literal) => `${literal} (${file})`),
    );

    expect(unknown, 'these are checked at a permission seam but declared by no matrix row').toEqual([]);
  });

  it('declares exactly the rows it populates — a union member with no row denies everyone', () => {
    const rows = [...matrixRows(matrix, 'tenantPermissions'), ...matrixRows(matrix, 'projectPermissions')];

    expect([...rows].sort()).toEqual([...declared].sort());
  });

  it('DETECTS a declared action nothing enforces — the negative control for the scan itself', () => {
    // The claim "an action added without its call site fails here the day it is
    // written" is only worth something if the detector demonstrably fires. A
    // synthetic matrix and a synthetic caller are run through the SAME functions
    // as the real scan: the matrix adds a row the caller never checks, and the
    // detector must report that row and only that row.
    const syntheticMatrix = parseText(
      'synthetic.rbac.service.ts',
      [
        'export type PermissionAction =',
        "  | 'manage_boards'",
        "  | 'undeclared_action';",
        'const projectPermissions: Record<string, never> = {',
        '  manage_boards: [],',
        '  undeclared_action: [],',
        '};',
      ].join('\n'),
    );
    const syntheticCaller = parseText(
      'synthetic.service.ts',
      [
        "import { ensurePermission } from './rbac.service.js';",
        'export function update(role: string): void {',
        "  ensurePermission('manage_boards', role, null);",
        '}',
      ].join('\n'),
    );
    const actions = declaredActions(syntheticMatrix);
    const enforcedInCaller = new Set(callArgumentLiterals(syntheticCaller));

    expect(actions).toEqual(['manage_boards', 'undeclared_action']);
    expect(matrixRows(syntheticMatrix, 'projectPermissions').sort()).toEqual([...actions].sort());
    expect(actions.filter((action) => !enforcedInCaller.has(action))).toEqual(['undeclared_action']);
  });

  it('does not read an action back out of a comment — a documented removal is not an enforcement', () => {
    // The real matrix documents the four actions it dropped, in prose, in the very
    // file a text scan would read. A comment-stripped match would pass those names
    // off as enforcement, which would make the guard satisfiable by writing a
    // sentence; parsing is what makes that impossible.
    const source = parseText(
      'synthetic.rbac.service.ts',
      [
        '/** `view_task` used to be declared here. */',
        'export type PermissionAction =',
        "  | 'view_task';",
        '// `view_task_history` went with it, for the same reason',
      ].join('\n'),
    );

    expect(declaredActions(source)).toEqual(['view_task']);
    expect(callArgumentLiterals(source)).toEqual([]);
  });
});
