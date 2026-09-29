/**
 * Structural behavior — mechanical acceptance predicates.
 *
 * Purpose: turn the E1 finding ("a criterion is only mechanically acceptable when a predicate has been
 * AUTHORED and VALIDATED, not derived from the criterion text") into deterministic code.
 *
 * Design rules:
 *  - declarative predicates only: a contract can select a kind and supply parameters, never a shell command;
 *  - fail-closed: a predicate that cannot decide (git failure, unreadable file) returns `error`, which makes
 *    the acceptance verdict `unresolved` — never `pass`;
 *  - no partial credit: a criterion is covered only when at least one check is declared for it;
 *  - acceptance never reads agent prose.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Declarative criterion boundaries and acceptance-evidence sources.
 *
 * `CRITERION_BOUNDARIES` describes whether a mechanical witness can establish a criterion. `EVIDENCE_SOURCES` separately
 * records who supplies acceptance evidence; neither vocabulary is a score or a policy input.
 */
export const CRITERION_BOUNDARIES = [
  'AUTOMATED_SAFE',
  'AUTOMATED_PENDING_VALIDATION',
  'HUMAN_OR_HYBRID',
  'NOT_AUTOMATABLE_WITH_CURRENT_OBSERVABLES',
];

export const EVIDENCE_SOURCES = ['AUTOMATED', 'HUMAN', 'HYBRID', 'UNAVAILABLE'];

/** Boundaries that claim a mechanical witness is available. */
export const AUTOMATED_BOUNDARIES = ['AUTOMATED_SAFE', 'AUTOMATED_PENDING_VALIDATION'];

export const CHECK_KINDS = [
  'absent_pattern',
  'present_pattern',
  'file_exists',
  'keyset_equal',
  'diff_scope',
  'gate_passed',
];

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|#)/;

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Search text. Default: the WORKING TREE (including untracked files), so uncommitted agent work is covered.
 * With `rev`: that revision only — used by predicate validation, which compares the source commit with the
 * historical solving commit (`--untracked` is working-tree-only, so it is omitted for a revision).
 */
function grepLines({ workspace, pattern, paths, commentsOnly = false, excludeComments = false, rev = null }) {
  const args =
    rev === null
      ? ['grep', '-n', '-I', '--untracked', '-E', pattern, '--', ...paths]
      : ['grep', '-n', '-I', '-E', pattern, rev, '--', ...paths];
  const result = git(args, workspace);

  if (result.status !== 0 && result.status !== 1) {
    return { error: `git grep failed with status ${result.status}: ${result.stderr.trim().slice(0, 200)}` };
  }

  const lines = result.stdout.split('\n').filter((line) => line !== '');
  const kept = lines.filter((line) => {
    // `git grep -n` output is `<path>:<line>:<text>` (working tree) or `<rev>:<path>:<line>:<text>` (a
    // revision). Strip the prefixes explicitly — splitting on ':' and assuming a field count silently broke
    // comment detection for revision-scoped searches (found by `harness predicates --validate`).
    let text = line;

    if (rev !== null) {
      text = text.replace(/^[0-9a-f]{7,40}:/, '');
    }

    text = text.replace(/^[^:]*:/, '').replace(/^\d+:/, '');

    if (commentsOnly) {
      return COMMENT_LINE.test(text);
    }

    if (excludeComments) {
      return !COMMENT_LINE.test(text);
    }

    return true;
  });

  return { count: kept.length, sample: kept.slice(0, 3) };
}

function flattenKeys(value, prefix, out) {
  if (value === null || typeof value !== 'object') {
    out.add(prefix);

    return out;
  }

  const keys = Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value);

  if (keys.length === 0) {
    out.add(prefix);
  }

  for (const key of keys) {
    flattenKeys(value[key], prefix === '' ? String(key) : `${prefix}.${key}`, out);
  }

  return out;
}

function jsonFilesUnder(dir) {
  const files = [];

  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.json')) {
        files.push(full);
      }
    }
  };

  if (existsSync(dir)) {
    walk(dir);
  }

  return files.sort();
}

/** Evaluate one declarative check. Always returns a structured result; never throws. */
export function evaluateCheck(check, context) {
  const base = { id: check.id, criterion: check.criterion, kind: check.kind };

  try {
    if (check.kind === 'absent_pattern' || check.kind === 'present_pattern') {
      const found = grepLines({
        workspace: context.workspace,
        pattern: check.pattern,
        paths: check.paths,
        commentsOnly: check.comments_only === true,
        excludeComments: check.exclude_comments === true,
        rev: typeof check.rev === 'string' && check.rev !== '' ? check.rev : null,
      });

      if (found.error !== undefined) {
        return { ...base, status: 'error', detail: found.error };
      }

      const pass = check.kind === 'absent_pattern' ? found.count === 0 : found.count > 0;

      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `matches=${found.count}${found.sample.length > 0 ? ` first=${found.sample[0].slice(0, 120)}` : ''}`,
      };
    }

    if (check.kind === 'gate_passed') {
      // Covers the largest single class of criteria in this corpus ("tests and typecheck pass") without
      // letting a claim stand in for the gate: if the gate did not run, the check cannot decide.
      if (context.gate === undefined || context.gate.ran !== true) {
        return { ...base, status: 'error', detail: 'the gate did not run, so this criterion cannot be decided' };
      }

      return {
        ...base,
        status: context.gate.exitCode === 0 ? 'pass' : 'fail',
        detail: `gate=${context.gate.name ?? 'unknown'} exit=${context.gate.exitCode}`,
      };
    }

    if (check.kind === 'file_exists') {
      const present = existsSync(join(context.workspace, check.path));

      return { ...base, status: present ? 'pass' : 'fail', detail: `exists=${present} path=${check.path}` };
    }

    if (check.kind === 'keyset_equal') {
      const files = jsonFilesUnder(join(context.workspace, check.path));

      if (files.length === 0) {
        return { ...base, status: 'error', detail: `no .json files under ${check.path}` };
      }

      const sets = files.map((file) => {
        try {
          return {
            file,
            keys: [...flattenKeys(JSON.parse(readFileSync(file, 'utf8')), '', new Set())].sort().join('|'),
          };
        } catch (error) {
          return { file, keys: `PARSE_ERROR:${error.message}` };
        }
      });
      const distinct = new Set(sets.map((entry) => entry.keys));

      return {
        ...base,
        status: distinct.size === 1 ? 'pass' : 'fail',
        detail: `files=${files.length} distinct_keysets=${distinct.size}`,
      };
    }

    if (check.kind === 'diff_scope') {
      const result = git(['diff', '-U0', context.sourceCommit, '--', check.file], context.workspace);

      if (result.status !== 0) {
        return { ...base, status: 'error', detail: `git diff failed (${result.status})` };
      }

      const changed = result.stdout.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
      const outOfScope = changed.filter((line) => !new RegExp(check.pattern).test(line));
      const pass = changed.length > 0 && outOfScope.length === 0;

      return {
        ...base,
        status: pass ? 'pass' : 'fail',
        detail: `changed_lines=${changed.length} out_of_scope=${outOfScope.length}`,
      };
    }

    return { ...base, status: 'error', detail: `unknown check kind "${check.kind}"` };
  } catch (error) {
    return { ...base, status: 'error', detail: `predicate raised: ${error.message}` };
  }
}

/**
 * Per-criterion coverage states (Durable-state behavior). A criterion is only `covered_pass` when a declared predicate actually
 * evaluated it and passed; anything else stays visibly unresolved so it can never be read as accepted.
 */
export const CRITERION_STATES = ['covered_pass', 'covered_fail', 'covered_error', 'uncovered'];

/** Per-criterion state, in criterion order, derived from the same check results the verdict uses. */
function criterionStates(criteria, results) {
  const byCriterion = new Map();

  for (const result of results) {
    const list = byCriterion.get(result.criterion) ?? [];

    list.push(result);
    byCriterion.set(result.criterion, list);
  }

  const states = criteria.map((_, index) => {
    const criterion = index + 1;
    const evaluated = byCriterion.get(criterion) ?? [];
    let state = 'uncovered';

    if (evaluated.some((result) => result.status === 'fail')) {
      state = 'covered_fail';
    } else if (evaluated.some((result) => result.status === 'error')) {
      state = 'covered_error';
    } else if (evaluated.length > 0) {
      state = 'covered_pass';
    }

    return {
      criterion,
      state,
      checks: evaluated.map((result) => result.id),
      detail: evaluated.length > 0 ? evaluated.map((result) => result.detail).join(' | ') : 'no declared predicate',
    };
  });

  // The vocabulary is CHECKED, not trusted: before this conjunct the constant was exported and read by nobody while
  // the states above were re-typed as bare literals, so a fifth state added on one side only would have gone
  // unnoticed. Fail-closed — an unknown state throws here rather than reaching a report.
  for (const { criterion, state } of states) {
    if (!CRITERION_STATES.includes(state)) {
      throw new Error(`CRITERION_STATE_UNKNOWN: criterion ${criterion} derived state "${state}"`);
    }
  }

  return states;
}

/**
 * Derive the acceptance verdict from check results.
 * pass       = every criterion has at least one check and every check passed
 * fail       = at least one check failed
 * unresolved = no failure, but some criterion is uncovered or some check could not decide
 *
 * Durable-state behavior adds `criteria[]` (per-criterion state) and `coverage_state` ('covered' | 'partial' | 'uncovered') so the
 * difference between pass/fail/uncovered/errored is explicit rather than implied by a ratio.
 */
export function deriveAcceptance(criteria, results) {
  const covered = new Set(results.map((result) => result.criterion));
  const uncovered = [];

  for (let index = 1; index <= criteria.length; index += 1) {
    if (!covered.has(index)) {
      uncovered.push(index);
    }
  }

  const failed = results.filter((result) => result.status === 'fail');
  const errored = results.filter((result) => result.status === 'error');
  let verdict = 'pass';

  if (failed.length > 0) {
    verdict = 'fail';
  } else if (errored.length > 0 || uncovered.length > 0) {
    verdict = 'unresolved';
  }

  const criteriaDetail = criterionStates(criteria, results);

  return {
    verdict,
    criteria_total: criteria.length,
    criteria_covered: covered.size,
    coverage: criteria.length === 0 ? null : Number((covered.size / criteria.length).toFixed(4)),
    // Durable-state behavior: explicit per-criterion state, so "not covered" is a named outcome rather than a missing row.
    criteria: criteriaDetail,
    coverage_state:
      criteria.length === 0
        ? 'uncovered'
        : uncovered.length === 0 && errored.length === 0
          ? 'covered'
          : covered.size === 0
            ? 'uncovered'
            : 'partial',
    failed: failed.map((result) => ({ id: result.id, detail: result.detail })),
    errored: errored.map((result) => ({ id: result.id, detail: result.detail })),
    uncovered_criteria: uncovered,
    mechanism: 'mechanical',
  };
}

/** Paths a predicate must never be scoped to: they are generated, ignored, or another checkout. */
const FORBIDDEN_PATH_SEGMENTS = [
  'node_modules',
  'dist/',
  '.angular/',
  '.wrangler/',
  '.harness/state/worktrees/',
  '.git/',
];

/** Hardening hints surfaced by `harness predicates`, not errors. */
export function predicateWarnings(check) {
  const warnings = [];

  if (check.kind === 'absent_pattern' || check.kind === 'present_pattern') {
    if (check.comments_only !== true && check.exclude_comments !== true) {
      warnings.push(
        `${check.id}: comment semantics are unset — a match inside a comment decides this criterion (Structural behavior lost two predicates to exactly this)`,
      );
    }

    if (typeof check.pattern === 'string' && !/[\\|(){}\[\]+*?]/.test(check.pattern) && check.pattern.length < 8) {
      warnings.push(
        `${check.id}: pattern "${check.pattern}" is a short bare word — broad-match risk (BROAD_TEXT_MATCH)`,
      );
    }

    for (const path of check.paths ?? []) {
      if (
        /^(src|app|lib|index)\b/.test(path) === false &&
        path.split('/').length === 1 &&
        path !== 'server' &&
        path !== 'ui' &&
        path !== 'shared'
      ) {
        warnings.push(
          `${check.id}: path "${path}" is broad — scope it to the directory that owns the criterion (WRONG_FILE_SCOPE)`,
        );
      }
    }
  }

  return warnings;
}

/** Contract-level validation of declared checks (used by `harness validate`). */
export function validateAcceptanceChecks(task) {
  const problems = [];
  const checks = task.acceptance_checks;

  if (checks === undefined) {
    return problems;
  }

  if (!Array.isArray(checks)) {
    return ['"acceptance_checks" must be a list'];
  }

  const ids = new Set();
  const criteriaCount = Array.isArray(task.acceptance) ? task.acceptance.length : 0;

  for (const check of checks) {
    const label = check && check.id ? check.id : '(no id)';

    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      problems.push('each acceptance check must be an object');
      continue;
    }

    if (typeof check.id !== 'string' || check.id === '') {
      problems.push('acceptance check missing "id"');
    } else if (ids.has(check.id)) {
      problems.push(`duplicate acceptance check id "${check.id}"`);
    } else {
      ids.add(check.id);
    }

    if (!Number.isInteger(check.criterion) || check.criterion < 1 || check.criterion > criteriaCount) {
      problems.push(
        `acceptance check "${label}": "criterion" must be an index into acceptance[] (1..${criteriaCount})`,
      );
    }

    if (!CHECK_KINDS.includes(check.kind)) {
      problems.push(`acceptance check "${label}": "kind" must be one of ${CHECK_KINDS.join(', ')}`);
      continue;
    }

    if ((check.kind === 'absent_pattern' || check.kind === 'present_pattern') && typeof check.pattern !== 'string') {
      problems.push(`acceptance check "${label}": "${check.kind}" requires "pattern"`);
    }

    if (
      (check.kind === 'absent_pattern' || check.kind === 'present_pattern') &&
      (!Array.isArray(check.paths) || check.paths.length === 0)
    ) {
      problems.push(`acceptance check "${label}": "${check.kind}" requires "paths"`);
    }

    if (check.kind === 'file_exists' && typeof check.path !== 'string') {
      problems.push(`acceptance check "${label}": "file_exists" requires "path"`);
    }

    if (check.kind === 'keyset_equal' && typeof check.path !== 'string') {
      problems.push(`acceptance check "${label}": "keyset_equal" requires "path"`);
    }

    if (check.kind === 'diff_scope' && (typeof check.file !== 'string' || typeof check.pattern !== 'string')) {
      problems.push(`acceptance check "${label}": "diff_scope" requires "file" and "pattern"`);
    }

    for (const path of check.paths ?? []) {
      const normalised = `${path}/`;

      if (FORBIDDEN_PATH_SEGMENTS.some((segment) => normalised.includes(segment) || path.includes(segment))) {
        problems.push(
          `acceptance check "${label}": path "${path}" is generated, ignored or another checkout — predicates must not read them`,
        );
      }
    }

    if (check.rev !== undefined && (typeof check.rev !== 'string' || !/^[0-9a-f]{7,40}$/.test(check.rev))) {
      problems.push(`acceptance check "${label}": "rev" must be a git commit sha`);
    }

    if (check.pattern !== undefined && check.kind !== 'diff_scope') {
      try {
        void new RegExp(check.pattern);
      } catch {
        problems.push(`acceptance check "${label}": "pattern" is not a valid regular expression`);
      }
    }
  }

  return problems;
}

/**
 * The declared boundary/evidence source for one criterion.
 *
 * Missing stays missing: a criterion with no entry, or an entry without a field, returns `null` and is never inferred to
 * be mechanical or automated (Criterion-boundary behavior §20). Callers must treat `null` as "unknown".
 */
export function criterionBoundary(task, index) {
  // A malformed field must not make a read helper throw: anything that is not a list is treated as "no boundary
  // declared", and `validateAcceptanceBoundaries` is what reports the shape error.
  const entries = Array.isArray(task?.acceptance_boundaries) ? task.acceptance_boundaries : [];
  const entry = entries.find((candidate) => candidate?.criterion === index);

  return {
    criterion: index,
    boundary: entry?.boundary ?? null,
    evidence_source: entry?.evidence_source ?? null,
    declared: entry !== undefined,
  };
}

/** Counts of declared boundaries, per contract. `unknown` is the criteria with no boundary entry. */
export function boundarySummary(task) {
  const criteria = Array.isArray(task?.acceptance) ? task.acceptance.length : 0;
  const entries = Array.isArray(task?.acceptance_boundaries) ? task.acceptance_boundaries : [];
  const byBoundary = {};

  for (const entry of entries) {
    if (typeof entry?.boundary === 'string') {
      byBoundary[entry.boundary] = (byBoundary[entry.boundary] ?? 0) + 1;
    }
  }

  const byEvidenceSource = {};

  for (const entry of entries) {
    if (typeof entry?.evidence_source === 'string') {
      byEvidenceSource[entry.evidence_source] = (byEvidenceSource[entry.evidence_source] ?? 0) + 1;
    }
  }

  const annotated = new Set(
    entries.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => entry?.criterion),
  ).size;

  return {
    criteria,
    declared_entries: entries.length,
    criteria_with_a_boundary: Object.values(byBoundary).reduce((sum, count) => sum + count, 0),
    criteria_unknown: criteria - annotated,
    automated_boundaries: entries.filter(
      (entry) => entry !== null && typeof entry === 'object' && AUTOMATED_BOUNDARIES.includes(entry.boundary),
    ).length,
    by_boundary: byBoundary,
    by_evidence_source: byEvidenceSource,
  };
}

/**
 * Contract-level validation of the declared boundaries (used by `harness validate`).
 *
 * Fail-closed and non-normalising: an out-of-vocabulary value, an out-of-range or duplicated criterion, an empty entry,
 * an unknown key, or an `AUTOMATED_SAFE` claim with no declared witness is an error. A contract with no
 * `acceptance_boundaries` at all is valid — it means every criterion keeps an unknown boundary.
 */
export function validateAcceptanceBoundaries(task) {
  const problems = [];
  const entries = task?.acceptance_boundaries;

  if (entries === undefined) {
    return problems;
  }

  if (!Array.isArray(entries)) {
    return ['"acceptance_boundaries" must be a list'];
  }

  const criteriaCount = Array.isArray(task.acceptance) ? task.acceptance.length : 0;
  const seen = new Set();

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('each acceptance boundary must be an object');
      continue;
    }

    const label = Number.isInteger(entry.criterion) ? `criterion ${entry.criterion}` : '(no criterion)';

    if (!Number.isInteger(entry.criterion) || entry.criterion < 1 || entry.criterion > criteriaCount) {
      problems.push(
        `acceptance boundary ${label}: "criterion" must be an index into acceptance[] (1..${criteriaCount})`,
      );
    } else if (seen.has(entry.criterion)) {
      problems.push(`duplicate acceptance boundary for criterion ${entry.criterion}`);
    } else {
      seen.add(entry.criterion);
    }

    const unknownKeys = Object.keys(entry).filter((key) => !['criterion', 'boundary', 'evidence_source'].includes(key));

    if (unknownKeys.length > 0) {
      problems.push(`acceptance boundary ${label}: unknown field(s) ${unknownKeys.join(', ')}`);
    }

    if (entry.boundary === undefined && entry.evidence_source === undefined) {
      problems.push(`acceptance boundary ${label}: must declare "boundary" and/or "evidence_source"`);
    }

    if (entry.boundary !== undefined && !CRITERION_BOUNDARIES.includes(entry.boundary)) {
      problems.push(
        `acceptance boundary ${label}: "boundary" must be one of ${CRITERION_BOUNDARIES.join(', ')} (got ${JSON.stringify(entry.boundary)})`,
      );
    }

    if (entry.evidence_source !== undefined && !EVIDENCE_SOURCES.includes(entry.evidence_source)) {
      problems.push(
        `acceptance boundary ${label}: "evidence_source" must be one of ${EVIDENCE_SOURCES.join(', ')} (got ${JSON.stringify(entry.evidence_source)})`,
      );
    }

    // The claim that needs an actual witness is the claim of being witnessed. `AUTOMATED_PENDING_VALIDATION` means the
    // opposite — a mechanical witness is conceivable but none is established — so it does not require a declared check.
    if (
      entry.boundary === 'AUTOMATED_SAFE' &&
      !(task.acceptance_checks ?? []).some((check) => check.criterion === entry.criterion)
    ) {
      problems.push(
        `acceptance boundary ${label}: boundary "AUTOMATED_SAFE" claims a mechanical witness but no acceptance check is declared for this criterion`,
      );
    }
  }

  return problems;
}

/**
 * Human acceptance records: explicit authority, in-range coverage, basis, and timestamp.
 *
 * Exactly five fields: mechanism, authority, covered_criteria, basis, recorded_at. The record is the provenance of a
 * human acceptance act; it is `operator trust` until the authority and scope are present, and it never changes
 * `coverage_state` (H2) — a human judges criteria the harness could not judge, and the two facts stay separate.
 *
 * Fail-closed by design (H4): an unknown field, a missing field, an out-of-range or duplicated criterion index is a
 * problem, never something to normalise. An ABSENT record is not a problem here — the caller classifies that case as
 * `operator_trust` (H3) and reports it as such.
 *
 * H1 (a human act must not silently cover a criterion that already has a passing mechanical witness) is a rule for
 * readers, not a machine check: on the human path the predicates are not evaluated, so the harness cannot know which
 * criteria are machine-judged. It is therefore not enforced here and must not be claimed to be.
 */
export const HUMAN_ACCEPTANCE_FIELDS = ['mechanism', 'authority', 'covered_criteria', 'basis', 'recorded_at'];

export function validateHumanAcceptance({ criteria, record }) {
  if (record === null || record === undefined) {
    return [];
  }

  if (typeof record !== 'object' || Array.isArray(record)) {
    return ['human acceptance record must be an object'];
  }

  const problems = [];

  for (const key of Object.keys(record)) {
    if (!HUMAN_ACCEPTANCE_FIELDS.includes(key)) {
      problems.push(`unknown field "${key}" (allowed: ${HUMAN_ACCEPTANCE_FIELDS.join(', ')})`);
    }
  }

  if (record.mechanism !== 'human') {
    problems.push('"mechanism" must be "human" for a human acceptance record');
  }

  if (typeof record.authority !== 'string' || record.authority.trim() === '') {
    problems.push('"authority" is required: record who accepted');
  } else if (record.authority.length > 200) {
    problems.push(`"authority" is ${record.authority.length} chars (max 200)`);
  }

  const total = Array.isArray(criteria) ? criteria.length : 0;

  if (!Array.isArray(record.covered_criteria) || record.covered_criteria.length === 0) {
    problems.push(`"covered_criteria" must be a non-empty list of indices into acceptance[] (1..${total})`);
  } else {
    for (const value of record.covered_criteria) {
      if (!Number.isInteger(value) || value < 1 || value > total) {
        problems.push(
          `"covered_criteria" entry ${JSON.stringify(value)} is not an index into acceptance[] (1..${total})`,
        );
      }
    }

    if (new Set(record.covered_criteria).size !== record.covered_criteria.length) {
      problems.push('"covered_criteria" contains duplicate indices');
    }
  }

  if (typeof record.basis !== 'string' || record.basis.trim() === '') {
    problems.push('"basis" is required: one bounded evidence line for the judged criteria');
  } else if (record.basis.length > 400) {
    problems.push(`"basis" is ${record.basis.length} chars (max 400)`);
  }

  if (typeof record.recorded_at !== 'string' || record.recorded_at.trim() === '') {
    problems.push('"recorded_at" is required');
  }

  return problems;
}

/** Run every declared check for a task against a workspace. */
export function runAcceptanceChecks(task, context) {
  const checks = task.acceptance_checks ?? [];
  const results = checks.map((check) => evaluateCheck(check, context));

  return { results, acceptance: deriveAcceptance(task.acceptance ?? [], results) };
}
