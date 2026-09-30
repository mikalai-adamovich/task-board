/**
 * `TaskQuerySchema` contract tests.
 *
 * The Sprints page needs a **Backlog** column meaning "tasks with no
 * sprint". Before F7 the API could not express that — `sprintId` is a strict
 * `uuid().optional()`, so omitting it means "no sprint filtering at all" and the
 * Backlog counter silently returned ALL project tasks.
 *
 * These tests pin the chosen contract:
 *   - absent  → no sprint filtering
 *   - `false` → only tasks with `sprintId === null` (the backlog)
 *   - `true`  → only tasks assigned to some sprint
 * and the mutual exclusion with `sprintId`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TASK_SEARCH_MAX_LENGTH, TASK_SEARCH_MIN_LENGTH } from '@task-board/shared';
import {
  BSON_MAX_IDS_PER_DOCUMENT,
  CreateTaskSchema,
  MAX_IDS_PER_DOCUMENT,
  MAX_TASK_PAGE,
  TaskQuerySchema,
  UpdateTaskSchema,
} from './task.js';
import { UpdateBoardColumnsSchema } from './board.js';
import { CreateFilterSchema } from './filter.js';

const SPRINT_UUID = '550e8400-e29b-41d4-a716-4466554400a1';
const OTHER_SPRINT_UUID = '550e8400-e29b-41d4-a716-4466554400a2';

describe('TaskQuerySchema — sprint filter (F7)', () => {
  describe('sprintId (unchanged contract)', () => {
    it('accepts a uuid sprint id and leaves hasSprint undefined', () => {
      const parsed = TaskQuerySchema.parse({ sprintId: SPRINT_UUID });

      expect(parsed.sprintId).toBe(SPRINT_UUID);
      expect(parsed.hasSprint).toBeUndefined();
    });

    it('rejects a non-uuid sprintId with 400-worthy validation issues', () => {
      // The pre-F6 failure mode: `sprintId=` (empty) must NOT be accepted.
      expect(TaskQuerySchema.safeParse({ sprintId: '' }).success).toBe(false);
      expect(TaskQuerySchema.safeParse({ sprintId: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe('hasSprint (the new tri-state filter)', () => {
    it('maps "false" to boolean false (the backlog filter)', () => {
      const parsed = TaskQuerySchema.parse({ hasSprint: 'false' });

      expect(parsed.hasSprint).toBe(false);
    });

    it('maps "true" to boolean true (only tasks in some sprint)', () => {
      const parsed = TaskQuerySchema.parse({ hasSprint: 'true' });

      expect(parsed.hasSprint).toBe(true);
    });

    it('is undefined when the param is absent (no sprint filtering)', () => {
      const parsed = TaskQuerySchema.parse({});

      expect(parsed.hasSprint).toBeUndefined();
    });

    it('rejects values outside the true/false enum (no loose coercion)', () => {
      // `hasSprint=1` / `hasSprint=yes` / empty must 400 rather than silently
      // becoming a truthy "has a sprint" filter.
      expect(TaskQuerySchema.safeParse({ hasSprint: '1' }).success).toBe(false);
      expect(TaskQuerySchema.safeParse({ hasSprint: 'yes' }).success).toBe(false);
      expect(TaskQuerySchema.safeParse({ hasSprint: '' }).success).toBe(false);
    });
  });

  describe('mutual exclusion with sprintId', () => {
    it('rejects sprintId + hasSprint together (they can contradict each other)', () => {
      const result = TaskQuerySchema.safeParse({ sprintId: SPRINT_UUID, hasSprint: 'false' });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'hasSprint');

        expect(issue?.message).toContain('mutually exclusive');
      }
    });

    it('still allows sprintId alone and hasSprint alone', () => {
      expect(TaskQuerySchema.safeParse({ sprintId: SPRINT_UUID }).success).toBe(true);
      expect(TaskQuerySchema.safeParse({ hasSprint: 'false' }).success).toBe(true);
      expect(TaskQuerySchema.safeParse({ hasSprint: 'true' }).success).toBe(true);
    });
  });

  it('keeps the other filters working alongside hasSprint', () => {
    const parsed = TaskQuerySchema.parse({ hasSprint: 'false', statusId: OTHER_SPRINT_UUID, page: '2', limit: '50' });

    expect(parsed.hasSprint).toBe(false);
    expect(parsed.statusId).toBe(OTHER_SPRINT_UUID);
    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(50);
  });
});

/**
 * `search` is an `$or` of five regexes over the whole `{projectId}` range —
 * no B-tree can serve it, so the cost is O(project size) no matter what the user
 * typed. The length bounds keep a guaranteed-whole-project query off the wire;
 * `maxTimeMS` (db/query-timeout.ts) is the actual cost backstop.
 */
describe('TaskQuerySchema — search bounds (F11)', () => {
  it(`rejects a ${TASK_SEARCH_MIN_LENGTH - 1}-character search — the cheapest payload was the most expensive one`, () => {
    const result = TaskQuerySchema.safeParse({ search: 'a' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.join('.')).toBe('search');
    }
  });

  it(`accepts a search of exactly ${TASK_SEARCH_MIN_LENGTH} characters (acronyms stay usable)`, () => {
    expect(TaskQuerySchema.safeParse({ search: 'qa' }).success).toBe(true);
    expect(TaskQuerySchema.parse({ search: 'QA' }).search).toBe('QA');
  });

  it('still accepts an absent search and a long one up to the maximum', () => {
    expect(TaskQuerySchema.parse({}).search).toBeUndefined();
    expect(TaskQuerySchema.parse({ search: 'x'.repeat(TASK_SEARCH_MAX_LENGTH) }).search).toHaveLength(
      TASK_SEARCH_MAX_LENGTH,
    );
  });

  it(`rejects a search longer than ${TASK_SEARCH_MAX_LENGTH} characters`, () => {
    const result = TaskQuerySchema.safeParse({ search: 'x'.repeat(TASK_SEARCH_MAX_LENGTH + 1) });

    expect(result.success).toBe(false);
  });

  it('does not silently truncate — an over-long term is a 400, not a wrong result set', () => {
    // A `.slice()` here would make the API answer a DIFFERENT question than the
    // client asked, with a 200 and no indication of it.
    const result = TaskQuerySchema.safeParse({ search: 'y'.repeat(TASK_SEARCH_MAX_LENGTH + 50) });

    expect(result.success).toBe(false);
  });
});

/**
 * `skip` pagination is linear in the offset (measured 1 ms at offset 0 and
 * ~270 ms at offset 10,000 on a 25k-task project), and `page` had no upper bound
 * — `?page=50000&limit=200` walked 10 M index keys.
 */
describe('TaskQuerySchema — deep-pagination cap (F11)', () => {
  it(`rejects page=${MAX_TASK_PAGE + 1}`, () => {
    const result = TaskQuerySchema.safeParse({ page: String(MAX_TASK_PAGE + 1) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(String(MAX_TASK_PAGE));
    }
  });

  it('rejects the unbounded-DoS payloads (a huge page, and a huge page with the max limit)', () => {
    expect(TaskQuerySchema.safeParse({ page: '50000' }).success).toBe(false);
    expect(TaskQuerySchema.safeParse({ page: '50000', limit: '200' }).success).toBe(false);
  });

  it(`still allows the cap itself and every page below it (page ${MAX_TASK_PAGE} = task 10,000 at the default limit)`, () => {
    expect(TaskQuerySchema.parse({ page: String(MAX_TASK_PAGE) }).page).toBe(MAX_TASK_PAGE);
    expect(TaskQuerySchema.safeParse({ page: '1' }).success).toBe(true);
    expect(TaskQuerySchema.safeParse({ page: '250' }).success).toBe(true);
  });

  it('keeps the existing page/limit floors (page 0 and a non-integer are still rejected)', () => {
    expect(TaskQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(TaskQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    expect(TaskQuerySchema.safeParse({ page: '-3' }).success).toBe(false);
  });
});

/**
 * An array of ids inside a SINGLE document has a ceiling.
 *
 * The property, not the value: **no array that lands in one BSON document is
 * unbounded, and no ceiling exceeds what the platform can physically store.**
 * Both halves are asserted, the second one against the 16 MiB document ceiling
 * the constant's own comment derives it from — so a bound raised to "whatever
 * seems fine" fails here, and a bound that some future edit removes fails the
 * source sweep below, which reads the schema directory rather than a list of
 * fields this file happens to know about today.
 */
describe('D-13 — per-document id arrays are bounded', () => {
  const UUIDS = (n: number): string[] =>
    Array.from({ length: n }, (_unused, i) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
  const TASK_BODY = {
    typeId: SPRINT_UUID,
    title: 't',
    statusId: SPRINT_UUID,
    priorityLevel: 1,
  };
  /** Every array-of-ids that lands in one document, with the schema that owns it. */
  const BOUNDED_ARRAYS = [
    {
      name: 'CreateTaskSchema.labelIds',
      at: MAX_IDS_PER_DOCUMENT,
      parse: (n: number) => CreateTaskSchema.safeParse({ ...TASK_BODY, labelIds: UUIDS(n) }),
    },
    {
      name: 'UpdateTaskSchema.labelIds',
      at: MAX_IDS_PER_DOCUMENT,
      parse: (n: number) => UpdateTaskSchema.safeParse({ labelIds: UUIDS(n), version: 1 }),
    },
    {
      name: 'UpdateBoardColumnsSchema.columns',
      at: MAX_IDS_PER_DOCUMENT,
      parse: (n: number) =>
        UpdateBoardColumnsSchema.safeParse({
          columns: UUIDS(n).map((id) => ({ id, statusIds: [id], position: 0 })),
          version: 1,
        }),
    },
    {
      name: 'BoardColumnSchema.statusIds',
      at: MAX_IDS_PER_DOCUMENT,
      parse: (n: number) =>
        UpdateBoardColumnsSchema.safeParse({
          columns: [{ id: SPRINT_UUID, statusIds: UUIDS(n), position: 0 }],
          version: 1,
        }),
    },
    {
      name: 'CreateFilterSchema.filters.labelIds',
      at: MAX_IDS_PER_DOCUMENT,
      parse: (n: number) =>
        CreateFilterSchema.safeParse({
          name: 'f',
          filters: { labelIds: UUIDS(n) },
          sort: { field: 'number', direction: 'desc' },
        }),
    },
  ] as const;

  it.each(BOUNDED_ARRAYS)('$name accepts exactly up to the bound and refuses one more', ({ parse, at }) => {
    expect(parse(at).success, `refused an array of exactly ${at}`).toBe(true);
    expect(parse(at + 1).success, `accepted an array of ${at + 1}`).toBe(false);
  });

  it('the bound is within what one BSON document can physically hold', () => {
    // Above this line the write fails on the DOCUMENT SIZE, with an error the
    // author cannot act on — so a bound larger than the ceiling is not a
    // lenient choice, it is a meaningless one.
    expect(MAX_IDS_PER_DOCUMENT).toBeGreaterThan(0);
    expect(MAX_IDS_PER_DOCUMENT).toBeLessThanOrEqual(BSON_MAX_IDS_PER_DOCUMENT);
  });

  it('rejects the payloads the defect was written about — a 10,000-column board and 1,000 label ids', () => {
    expect(
      UpdateBoardColumnsSchema.safeParse({
        columns: UUIDS(10_000).map((id) => ({ id, statusIds: [id], position: 0 })),
        version: 1,
      }).success,
    ).toBe(false);
    expect(CreateTaskSchema.safeParse({ ...TASK_BODY, labelIds: UUIDS(1_000) }).success).toBe(false);
  });

  /**
   * The sweep is what protects the NEXT array: a field added tomorrow with a
   * bare `z.array(…)` fails here without anyone remembering this file. Comments
   * are stripped first, so documenting the old defect cannot satisfy it.
   *
   * An exception is possible, but it must NAME the file and STATE a reason, and
   * the last assertion makes the list self-checking in both directions: an entry
   * that no longer matches real code fails, so the list cannot outlive the
   * exception it was written for.
   */
  const UNBOUNDED_BY_DESIGN: Record<string, string> = {
    // These two are REQUEST payloads (`PUT …/reorder`), not fields persisted
    // into a single document: the array is a list of positions the caller is
    // writing, so it is bounded by how many entities the project has rather
    // than by the size of a stored document. They are the same class of
    // unbounded body as `labelIds` and belong to the same question — "what bounds a
    // request body?" — which is not this file's to decide. Reported as a
    // deferral, not silently accepted.
    'status.ts': 'reorder payload, not a persisted field — see the D-13 deferral in fix-FX7.md',
    'task-type.ts': 'reorder payload, not a persisted field — see the D-13 deferral in fix-FX7.md',
  };

  function unboundedArrays(ignoreExemptions = false): string[] {
    const SCHEMA_DIR = dirname(new URL(import.meta.url).pathname);
    const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const sources = readdirSync(SCHEMA_DIR, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .map((path) => ({ path, source: code(readFileSync(join(SCHEMA_DIR, path), 'utf8')) }));
    /**
     * Element schemas whose domain is FINITE by construction — `z.enum(…)` and
     * `z.literal(…)`, or a name assigned from one. An array of these cannot grow
     * a document past `domain size × element size`, so demanding a `.max()` on
     * it would be demanding a bound the type system already provides. Resolved
     * across the whole directory rather than listed, so redefining
     * `taskPriorityLevelSchema` as a number makes its array an offender.
     */
    const finiteElements = new Set<string>();

    for (const { source } of sources) {
      for (const match of source.matchAll(/(?:const|export const)\s+(\w+)\s*=\s*z\.(?:enum|literal)\(/g)) {
        finiteElements.add(match[1] as string);
      }
    }

    const offenders: string[] = [];

    for (const { path, source } of sources) {
      let from = 0;

      for (;;) {
        const start = source.indexOf('z.array(', from);

        if (start === -1) break;

        // Walk to the `)` that closes `z.array(`, then look at the element and
        // at what follows: a chain that reaches `.max(` is bounded, whatever
        // else is chained on.
        let depth = 0;
        let end = start;

        for (; end < source.length; end += 1) {
          if (source[end] === '(') depth += 1;
          if (source[end] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }

        const element = source.slice(start + 'z.array('.length, end).trim();
        const chain = source.slice(end, end + 200);
        const terminates = /;|\n\s*\n/.exec(chain);
        const modifiers = terminates ? chain.slice(0, terminates.index) : chain;
        const finite = /z\.(enum|literal)\(/.test(element) || finiteElements.has(element);

        if (!finite && !/\.max\(/.test(modifiers) && (ignoreExemptions || UNBOUNDED_BY_DESIGN[path] === undefined)) {
          offenders.push(`${path}: unbounded z.array(${element.slice(0, 40)}) — ${modifiers.trim().split('\n')[0]}`);
        }

        from = end + 1;
      }
    }

    return offenders;
  }

  it('no schema declares an unbounded array, unless the file is a named, reasoned exception', () => {
    expect(unboundedArrays()).toEqual([]);
  });

  it('every exception still matches real code — the list cannot outlive the array it excuses', () => {
    const excused = new Set(unboundedArrays(true).map((offender) => offender.split(':')[0]));
    const stale = Object.keys(UNBOUNDED_BY_DESIGN).filter((file) => !excused.has(file));

    // A named file whose unbounded array has since been bounded would keep its
    // entry forever otherwise, and an exception nobody re-reads is how an
    // allowlist rots into a hole.
    expect(stale).toEqual([]);
  });
});
