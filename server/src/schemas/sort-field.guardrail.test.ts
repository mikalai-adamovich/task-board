import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditQuerySchema } from './audit.js';
import { CreateFilterSchema, UpdateFilterSchema } from './filter.js';
import { SORT_FIELDS, TaskQuerySchema } from './task.js';

/**
 * The arbitrary-sort-field guardrail.
 *
 * Background: `validators/pagination.ts` used to export a `paginationQuery()`
 * whose `sort` was validated with
 *   /^[a-zA-Z_][a-zA-Z0-9_.]*:(asc|desc)$/
 * which accepts ANY field name — `?sort=__proto__:asc`, `?sort=actor.userId:desc`,
 * any unindexed or dotted path. Fed to a Mongo `sort` that is a guaranteed
 * COLLSCAN plus a per-request DoS knob.
 *
 * It was unreachable (the task list uses a closed 11-field allow-list, the audit
 * list hard-codes `createdAt`) and F22 deleted it — but "unreachable today" is not
 * a property a schema should rely on, and a deleted regex is exactly the kind of
 * thing a later audit fix re-introduces. So this test pins the property that
 * actually matters: for every sort-taking schema, an arbitrary field is REJECTED.
 *
 * The assertions are behavioural, against the real exported schemas — not a
 * source grep — so they fail if a permissive sort regex returns, even from a
 * differently-named file. The final `it` adds a source sweep purely to cover
 * schemas that exist but are not yet wired to a route.
 */
describe('sort field allow-listing (F22 guardrail)', () => {
  const SCHEMA_DIR = dirname(fileURLToPath(import.meta.url));
  const VALIDATOR_DIR = join(SCHEMA_DIR, '..', 'validators');
  /**
   * Strips comments before a source check, so that DOCUMENTING the old defect in
   * a comment (which the deletion notes in `common.ts` legitimately do) cannot
   * trip the guardrail. Only executable code is inspected.
   */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  /**
   * Every sort entry point the API actually exposes.
   *
   * This list previously held only the two QUERY schemas. The PERSISTED
   * sort — `CreateFilterSchema` / `UpdateFilterSchema`, whose `field` was
   * `z.string()` — was missing, which is why the one free-form field in the
   * schema directory survived: a saved filter could store `passwordHash` and
   * hand it to a `sort` the moment somebody applied it. `AuditQuerySchema` has
   * no field component at all, so it takes the `{ sort: 'asc' }` shape below
   * and rejects everything else.
   */
  const SORT_SCHEMAS = [
    ['TaskQuerySchema', TaskQuerySchema],
    ['AuditQuerySchema', AuditQuerySchema],
    ['CreateFilterSchema', CreateFilterSchema],
    ['UpdateFilterSchema', UpdateFilterSchema],
  ] as const;
  /**
   * The closed allow-list, IMPORTED rather than copied. The eleven field
   * names used to be written out a second time in this file, and a hard-coded
   * pair of lists is exactly how `TaskQuerySchema` and the persisted sort would
   * drift: a field added to one and not the other would fail here, and a field
   * REMOVED from one would keep passing here.
   */

  describe('the allow-listed task sort accepts exactly its own fields', () => {
    it.each(SORT_FIELDS)('accepts "%s:asc" and "%s:desc"', (field) => {
      expect(TaskQuerySchema.safeParse({ sort: `${field}:asc` }).success).toBe(true);
      expect(TaskQuerySchema.safeParse({ sort: `${field}:desc` }).success).toBe(true);
    });

    it('rejects a field that merely starts like an allowed one', () => {
      // The regex is built with `SORT_FIELDS.join('|')`; an unanchored
      // alternation would accept `createdAtX`. This pins the anchoring.
      expect(TaskQuerySchema.safeParse({ sort: 'createdAtX:asc' }).success).toBe(false);
    });
  });

  describe('arbitrary / hostile sort fields are rejected by every sort schema', () => {
    const HOSTILE: unknown[] = [
      'passwordHash:asc', // plain unindexed field
      'actor.userId:desc', // dotted path — nested traversal attempt
      'changes.oldValue:asc',
      '__proto__:asc', // prototype-pollution shape
      'constructor.prototype:desc',
      '$where:asc', // operator-injection shape
      'a.$b:asc',
      'title extra:asc', // an allowed field name glued to something else
      ':asc', // malformed / empty
      'title:',
      'title:up',
      42, // not a string at all
    ];

    it.each(SORT_SCHEMAS)('%s rejects every one of them', (name, schema) => {
      for (const sort of HOSTILE) {
        const result = schema.safeParse({ sort });

        expect(result.success, `${name} accepted the hostile sort ${JSON.stringify(sort)}`).toBe(false);
      }
    });
  });

  /**
   * The persisted half of the rule, asserted behaviourally against the real
   * exported schemas.
   *
   * The property is not "these eleven names are allowed" — it is "**a filter
   * cannot persist a sort field the task query would later reject**". That is
   * why the allow-list is imported from the schema that owns it, and why the
   * round-trip is asserted in both directions: every field `TaskQuerySchema`
   * accepts must be storable, and a field it rejects must be refused AT THE
   * WRITE rather than at apply time, in a different request, with a different
   * user.
   */
  describe('the persisted sort is drawn from the same allow-list the task query enforces', () => {
    const FILTER_SCHEMAS = [
      ['CreateFilterSchema', CreateFilterSchema],
      ['UpdateFilterSchema', UpdateFilterSchema],
    ] as const;

    /** The `sort.field` values each filter schema accepts, read from the schema. */
    function acceptedFields(): string[] {
      // Probe: a value is acceptable to `CreateFilterSchema` exactly when the
      // schema accepts a body carrying it. Enumerated from the task query's own
      // message-free behaviour rather than from a second literal.
      return SORT_FIELDS.filter(
        (field) => CreateFilterSchema.safeParse({ name: 'f', filters: {}, sort: { field, direction: 'desc' } }).success,
      );
    }

    it('stores every field the task query accepts — a legal sort is never refused', () => {
      expect(acceptedFields().sort()).toEqual([...SORT_FIELDS].sort());
    });

    it('refuses every field the task query rejects, at the write', () => {
      const taskAccepts = (field: string): boolean =>
        TaskQuerySchema.safeParse({ sort: `${field}:asc` }).success ||
        TaskQuerySchema.safeParse({ sort: `${field}:desc` }).success;

      for (const field of ['passwordHash', 'actor.userId', '__proto__', 'createdAtX', '', 'number ']) {
        expect(taskAccepts(field), `${field} is accepted by the task query — the allow-lists disagree`).toBe(false);

        for (const [name, schema] of FILTER_SCHEMAS) {
          const result = schema.safeParse({ name: 'f', sort: { field, direction: 'desc' } });

          expect(result.success, `${name} persisted the sort field ${JSON.stringify(field)}`).toBe(false);
        }
      }
    });

    it('a persisted sort field round-trips into the task query unchanged', () => {
      // The end-to-end property: whatever a filter can store, the query that
      // replays it must accept. This is the assertion that would have caught
      // as a behaviour, rather than as a shape.
      for (const field of SORT_FIELDS) {
        const stored = CreateFilterSchema.safeParse({ name: 'f', filters: {}, sort: { field, direction: 'desc' } });

        expect(stored.success, `CreateFilterSchema refused ${field}`).toBe(true);

        const parsed = stored.success ? stored.data.sort : undefined;

        expect(TaskQuerySchema.safeParse({ sort: `${parsed?.field}:${parsed?.direction}` }).success).toBe(true);
      }
    });

    it('still validates the name and the direction — narrowing the field did not loosen the object', () => {
      expect(
        CreateFilterSchema.safeParse({ name: '', filters: {}, sort: { field: 'number', direction: 'desc' } }).success,
      ).toBe(false);
      expect(
        CreateFilterSchema.safeParse({ name: 'f', filters: {}, sort: { field: 'number', direction: 'sideways' } })
          .success,
      ).toBe(false);
    });
  });

  describe('the audit list cannot sort by a client-chosen field at all', () => {
    it('accepts only a bare direction — there is no field component to abuse', () => {
      expect(AuditQuerySchema.safeParse({ sort: 'asc' }).success).toBe(true);
      expect(AuditQuerySchema.safeParse({ sort: 'desc' }).success).toBe(true);

      // Anything carrying a `field:direction` pair is not a valid audit sort.
      expect(AuditQuerySchema.safeParse({ sort: 'createdAt:desc' }).success).toBe(false);
      expect(AuditQuerySchema.safeParse({ sort: 'passwordHash:asc' }).success).toBe(false);
    });
  });

  /**
   * Second line of defence — and now the ONLY one. The behavioural blocks above
   * cover the schemas this file imports; a NEW sort-taking schema with a
   * permissive regex would not be noticed there until someone wires it to a
   * route. This sweeps `schemas/` + `validators/` RECURSIVELY and fails on the
   * exact pattern that was the original defect, wherever it is written.
   *
   * The two deletion-marker assertions that used to sit here (that
   * `PaginationQuerySchema`/`ListQuerySchema` are gone and that
   * `validators/pagination.ts` no longer exists) were RETIRED: they protected a
   * cleanup that is finished. They could only fail when someone correctly moved
   * on — reintroducing the *name* in an unrelated context failed them, and
   * leaving them in place made this file look like it policed two things when it
   * polices one property: no source declares an arbitrary-field sort.
   */
  it('no schema or validator reintroduces the arbitrary-field sort regex', () => {
    const ARBITRARY_SORT = /\[a-zA-Z_\]\[a-zA-Z0-9_\.\]\*:\(asc\|desc\)/;
    const offenders: string[] = [];

    for (const dir of [SCHEMA_DIR, VALIDATOR_DIR]) {
      for (const file of readdirSync(dir, { recursive: true })) {
        const path = String(file);

        if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;

        if (ARBITRARY_SORT.test(code(readFileSync(join(dir, path), 'utf8')))) {
          offenders.push(path);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the sweep still reaches the validator directory (a rename must not empty it)', () => {
    // Anti-vacuity: the block above iterates two directory listings. If either
    // stopped resolving, `offenders` would be empty for the wrong reason and the
    // guardrail would be green while covering nothing.
    expect(readdirSync(VALIDATOR_DIR).length).toBeGreaterThan(0);
  });
});
