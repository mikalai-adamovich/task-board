/**
 * Form guardrail: a signal-form field declared `required(…)` must be BOUND in
 * the template, and the binding must render the field's error.
 *
 * The defect: `create-task.ts` declared
 * `required(field.typeId)`, `required(field.statusId)` and
 * `required(field.priorityLevel)`, but the three `<hlm-select>`s were bound by
 * hand — `[value]="model().statusId"` plus `(valueChange)` — and never with
 * `[formField]`. A control that is not bound to the form is not a form control:
 * the submit never marked it touched, so the schema error existed, was never
 * rendered, was never announced, and the submit button silently did nothing.
 * The defect was invisible in the type system and in every existing test.
 *
 * The property this spec protects — stated so a *differently written* correct
 * form still passes:
 *
 *   > Every field the schema marks required is wired to a control that reports
 *   > the field's validity to the DOM (an error slot guarded by the field's own
 *   > state), so an omitted value produces a visible, associated error.
 *
 * It is deliberately NOT "create-task has three `[formField]` bindings" — that
 * would be a coupling to today's shape. A new form, a renamed field or a fourth
 * required select all pass; an unbound required field anywhere fails.
 *
 * Why a source scan: several of the affected controls (every `<hlm-select>` body)
 * live behind a CDK portal that unit tests never attach, and a scan covers every
 * form in the app, not the one the fixer happened to look at.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');

/** Recursively collect every component `.ts` under `ui/src/app` (no specs). */
function collectComponents(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) collectComponents(path, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }

  return out;
}

/** `const someForm = form(` — the form instance a template binds against. */
const FORM_RE = /\b(\w+)\s*=\s*form\(/g;
/** `required(field.title, …)` — any signal-form required declaration. */
const REQUIRED_RE = /\brequired\(\s*\w+\.(\w+)/g;

interface Row {
  file: string;
  form: string;
  field: string;
  bound: boolean;
  hasErrorSlot: boolean;
}

function templateOf(source: string, file: string): string | null {
  const inline = source.match(/template:\s*`([\s\S]*?)`/);
  const url = source.match(/templateUrl:\s*'([^']+)'/);
  const urlPath = url?.[1];
  const inlineTemplate = inline?.[1];

  if (urlPath !== undefined) return readFileSync(join(file, '..', urlPath), 'utf8');

  return inlineTemplate ?? null;
}

const rows: Row[] = [];
const formsWithoutTemplate: string[] = [];

for (const file of collectComponents(SRC)) {
  const source = readFileSync(file, 'utf8');

  if (!source.includes("from '@angular/forms/signals'")) continue;

  const required = [...source.matchAll(REQUIRED_RE)].map((m) => m[1]);
  const forms = [...source.matchAll(FORM_RE)].map((m) => m[1]);

  if (required.length === 0 || forms.length === 0) continue;

  const template = templateOf(source, file);

  if (template === null) {
    formsWithoutTemplate.push(relative(SRC, file).split(sep).join('/'));
    continue;
  }

  for (const form of forms) {
    for (const field of required) {
      rows.push({
        file: relative(SRC, file).split(sep).join('/'),
        form: form ?? '',
        field: field ?? '',
        // The property: the template binds THIS field of THIS form to a control.
        bound: template.includes(`[formField]="${form}.${field}"`),
        // …and the control renders the field's own error, so the message is
        // visible and (via Spartan's a11y service) associated with the control.
        hasErrorSlot: template.includes(`${form}.${field}().touched()`) && template.includes('hlm-field-error'),
      });
    }
  }
}

describe('required signal-form fields are bound and render their error (D-40)', () => {
  it('finds no required field left unbound', () => {
    const report = rows
      .filter((r) => !r.bound)
      .map((r) => `${r.file}: required field "${r.form}.${r.field}" has no [formField] binding`)
      .join('\n');

    expect(report).toBe('');
  });

  it('finds no required field whose error is never rendered', () => {
    const report = rows
      .filter((r) => r.bound && !r.hasErrorSlot)
      .map((r) => `${r.file}: required field "${r.form}.${r.field}" has no <hlm-field-error> slot`)
      .join('\n');

    expect(report).toBe('');
  });

  // Guards the guardrail: a broken path, a renamed `form(` pattern or an empty
  // corpus would make the two assertions above pass for the wrong reason.
  it('actually inspects the forms the D-40 audit flagged', () => {
    expect(formsWithoutTemplate).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => `${r.file}#${r.form}.${r.field}`)).toEqual(
      expect.arrayContaining([
        'features/tasks/create-task/create-task.ts#createForm.typeId',
        'features/tasks/create-task/create-task.ts#createForm.statusId',
        'features/tasks/create-task/create-task.ts#createForm.priorityLevel',
        'features/auth/login/login.ts#loginForm.email',
        'features/auth/login/login.ts#loginForm.password',
      ]),
    );
  });
});
