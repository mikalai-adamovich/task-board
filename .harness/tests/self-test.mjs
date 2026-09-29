/**
 * Final harness control-plane self-tests across Structural, durable-state, and compatibility behavior (I1..I13).
 *
 * Hermetic: everything runs in a temporary directory with a throwaway git repository, a throwaway
 * HARNESS_HOME and no Zoo runtime. Deterministic fixtures only; no live agent is launched.
 *
 * Usage: node node .harness/runtime/harness.mjs self-test
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- F9: the temporary roots this suite creates, and the discipline that keeps `npm run check:harness` idempotent on
// disk. INLINED, and that duplication is deliberate: `SAN-03` requires every import in this file to be a `node:`
// builtin, so the suite has no module of its own to import from. Editing the copy in the other suite is part of the
// change; there is exactly one behaviour and two copies, and the behaviour is asserted from both sides.
//
// The leak predates this pass but every gate run enlarged it: ~617 MB of `harness-*` directories had accumulated under
// `tmpdir()`, 462 of them created in 70 minutes. Two mechanisms, because the first cannot cover the interesting case.
//
// 1. `suiteTempDir` is the ONLY way a fixture root is created, and every root is removed in a `process.on('exit')`
//    handler. That covers every path this process can reach: a passing run, a case that threw, and a case that is
//    interrupted in-process rather than surviving one.
// 2. `sweepStaleSuiteTempDirs` removes what this process could not clean — the roots of a SIGKILLed or power-lost run.
//    It is deliberately CONSERVATIVE: only roots carrying one of this suite's own prefixes, and only those untouched for
//    longer than the stale window. A concurrent suite run's fixtures are minutes old, so they are never swept out from
//    under it, which is what lets a case running two concurrent processes keep working.
//
// What this does NOT do, stated because the limit belongs next to the mechanism: it does not reclaim a root still in use,
// it cannot survive a SIGKILL by itself, and it touches nothing outside the prefixes below. A worktree is not a security
// boundary and neither is a temporary directory.
const SUITE_TEMP_PREFIXES = [
  'harness-self-test-',
  'harness-compatibility-',
  'harness-compat-wt-',
  'harness-san01-',
  'harness-san02-',
  'harness-san10-',
  'harness-e19-cache-',
  'harness-e23-probe-',
  'harness-e23-probe-child-',
  'harness-compat-ledger-',
  'harness-i23-',
  // Two prefixes belong to MARKER FILES written by CHILD scripts this suite generates, not to roots it creates itself
  // (a self-cancelling child's rendezvous marker, and a per-run counter). They are one byte each, and the exit handler
  // cannot reach them because the writer is a different process — so the sweep is the only path that reclaims them, and
  // that is stated here rather than left as a mystery the next reader has to solve.
  'harness-e17-self-cancel-',
  'harness-e20-counter-',
  'task-board-acceptance-other-checkout-',
  'task-board-s2-export-',
];
const SUITE_TEMP_STALE_MS = 6 * 60 * 60 * 1000;
const suiteTempCreated = new Set();

function suiteTempRoots() {
  return [...suiteTempCreated];
}

function suiteTempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  suiteTempCreated.add(directory);

  return directory;
}

function cleanupSuiteTempDirs() {
  const result = { attempted: 0, removed: 0, failed: [] };

  for (const directory of [...suiteTempCreated]) {
    result.attempted += 1;

    if (!existsSync(directory)) {
      suiteTempCreated.delete(directory);
      result.removed += 1;
      continue;
    }

    try {
      rmSync(directory, { recursive: true, force: true });
      result.removed += 1;
    } catch (error) {
      result.failed.push({ directory, reason: String(error?.code ?? error?.message ?? error) });
    }

    suiteTempCreated.delete(directory);
  }

  return result;
}

function sweepStaleSuiteTempDirs({ now = Date.now(), staleMs = SUITE_TEMP_STALE_MS, prefixes = SUITE_TEMP_PREFIXES } = {}) {
  const result = { scanned: false, considered: 0, removed: 0, refused_too_young: 0, failed: [] };
  let names;

  try {
    names = readdirSync(tmpdir());
  } catch {
    return result;
  }

  result.scanned = true;

  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }

    const directory = join(tmpdir(), name);

    result.considered += 1;

    let mtimeMs;

    try {
      mtimeMs = statSync(directory).mtimeMs;
    } catch (error) {
      result.failed.push({ directory, reason: String(error?.code ?? error?.message ?? error) });
      continue;
    }

    // A root this very process owns is never swept, whatever its age: the exit handler is the authority on it.
    if (suiteTempCreated.has(directory) || now - mtimeMs < staleMs) {
      result.refused_too_young += 1;
      continue;
    }

    try {
      rmSync(directory, { recursive: true, force: true });
      result.removed += 1;
    } catch (error) {
      result.failed.push({ directory, reason: String(error?.code ?? error?.message ?? error) });
    }
  }

  return result;
}

// `process.on('exit')` is synchronous by contract, which is why this uses `rmSync`: an async cleanup would be cut off
// exactly when it is most needed. It cannot run on SIGKILL, which is what the sweep is for, and that asymmetry is the
// reason both exist.
function installSuiteTempDiscipline() {
  process.on('exit', () => {
    cleanupSuiteTempDirs();
  });
}

installSuiteTempDiscipline();

import {
  boundarySummary,
  criterionBoundary,
  deriveAcceptance,
  evaluateCheck,
  predicateWarnings,
  runAcceptanceChecks,
  validateAcceptanceBoundaries,
  validateAcceptanceChecks,
  validateHumanAcceptance,
} from '../runtime/acceptance.mjs';
import { handoffTemplate, validateHandoff, validateHandoffText } from '../runtime/handoff.mjs';
import {
  classifyLedgerStatus as classifyLedgerStatusCurrent,
  compactVerifier,
  deriveBlockers,
  hasUnresolvedIntegrityBlocker,
  integrityClearance,
  isCoverageIncomplete,
} from '../runtime/verification-state.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(TESTS_DIR, '../runtime');
const REAL_REPO_ROOT = resolve(TESTS_DIR, '../..');

/** Translate the pre-S4 fixture vocabulary to the narrowed current-fact API. */
function classifyLedgerStatus({
  runGate,
  gateIncompatible = false,
  mechanicallyVerified = false,
  acceptance,
  acceptanceCoverage = null,
  verifier = null,
  ledger = null,
}) {
  const integrityVeto =
    ledger === null || !(ledger.blockers ?? []).some((blocker) => blocker.kind === 'artifact_integrity_changed')
      ? 'none'
      : verifier?.artifact_integrity === 'UNCHANGED'
        ? 'cleared_by_current_unchanged'
        : 'unresolved';

  return classifyLedgerStatusCurrent({
    gateResult: !runGate ? 'not_run' : gateIncompatible ? 'incompatible' : mechanicallyVerified ? 'pass' : 'fail',
    acceptance,
    acceptanceCoverage,
    verifier,
    integrityVeto,
  });
}

const results = [];
const record = (invariant, name, passed, detail) => results.push({ invariant, name, passed, detail });
const check = (invariant, name, condition, detail) => record(invariant, name, condition === true, detail);

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Prose with every run of whitespace collapsed to a single space. A documentation assertion is about the SENTENCE,
 * not about where the renderer broke the line: prettier reflows markdown, so an `includes()` on a multi-word phrase
 * is otherwise a test of the formatter as much as of the docs.
 */
function flattenProse(text) {
  return String(text).replace(/\s+/g, ' ');
}

function runHarness(repoRoot, args, harnessHome) {
  const result = spawnSync(process.execPath, [join(RUNTIME_DIR, 'harness.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome ?? join(repoRoot, '.harness') },
  });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Read a ledger through the CLI rather than by guessing its file name: ledger files are
 * `ledger-<run-id>.json`, so only the command knows which one is current.
 */
function ledgerJson(repoRoot, taskId, runId) {
  const args = ['ledger', 'show', '--task=' + taskId, '--json'];

  if (runId !== undefined) {
    args.push('--run-id=' + runId);
  }

  const result = runHarness(repoRoot, args);

  if (result.status !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout).ledger;
  } catch {
    return null;
  }
}

function lastRunEvent(repoRoot, runId) {
  const path = join(repoRoot, '.harness', 'state', 'runs', `${runId}.jsonl`);

  if (!existsSync(path)) {
    return null;
  }

  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((event) => event.event === 'run_finished');
}

function runtimeSourceManifest() {
  const root = join(REAL_REPO_ROOT, '.harness/runtime');
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const entry = lstatSync(absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        files.push({
          path: relative(REAL_REPO_ROOT, absolute).split(sep).join('/'),
          mode: (entry.mode & 0o777).toString(8).padStart(3, '0'),
          digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        });
      } else {
        throw new Error(`RUNTIME_SOURCE_UNEXPECTED_ENTRY: ${relative(REAL_REPO_ROOT, absolute)}`);
      }
    }
  };
  visit(root);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (files.length === 0) throw new Error('RUNTIME_SOURCE_EMPTY');
  const manifest = `${files.map(({ path, mode, digest }) => `${path}\0${mode}\0${digest}\n`).join('')}`;
  return { digest: createHash('sha256').update(manifest).digest('hex'), files: files.length };
}

function buildFixtureRepo(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export function searchTasks() {}\n// keep me\n');
  writeFileSync(join(root, 'data', 'a.json'), '{}');
  writeFileSync(join(root, 'other', 'unrelated.ts'), 'export const nothing = 1;\n');
  git(['init', '-q'], root);
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'add', '.'], root);
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'commit', '-qm', 'initial'], root);
  const sourceCommit = git(['rev-parse', 'HEAD'], root).stdout.trim();

  // A second commit that removes the CODE occurrence but leaves a COMMENT mentioning the symbol — the exact
  // shape that cost Structural behavior two predicates, so the validation path can be tested against it.
  writeFileSync(join(root, 'src', 'app.ts'), 'export function listTasks() {}\n// searchTasks was removed here\n');
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'add', '.'], root);
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'commit', '-qm', 'solve'], root);

  return { sourceCommit, solvingCommit: git(['rev-parse', 'HEAD'], root).stdout.trim() };
}

function writeContract(harnessHome, id, sourceCommit, acceptance, checks) {
  mkdirSync(join(harnessHome, 'state/tasks'), { recursive: true });
  writeFileSync(
    join(harnessHome, 'state/tasks', `${id}.json`),
    JSON.stringify(
      {
        id,
        title: 'Self-test fixture',
        category: 'test-infra',
        source_commit: sourceCommit,
        acceptance,
        workspace: { paths: ['src'] },
        ...(checks === undefined ? {} : { acceptance_checks: checks }),
      },
      null,
      2,
    ),
  );
}

export function runSelfTest(s2 = {}) {
  const runtimeSourceBefore = runtimeSourceManifest();
  check(
    'I10',
    'SOURCE-INTEGRITY-runtime-manifest-is-non-empty-before-self-test',
    runtimeSourceBefore.files > 0,
    `files=${runtimeSourceBefore.files}`,
  );
  const root = suiteTempDir('harness-self-test-');
  const repo = join(root, 'repo');
  const harnessHome = join(repo, '.harness');
  mkdirSync(harnessHome, { recursive: true });
  const { sourceCommit, solvingCommit } = buildFixtureRepo(repo);
  const ctx = { workspace: repo, sourceCommit };
  writeContract(
    harnessHome,
    'P6T',
    sourceCommit,
    ['criterion one'],
    [
      {
        id: 'k1',
        criterion: 1,
        kind: 'absent_pattern',
        pattern: 'searchTasks',
        paths: ['src'],
        exclude_comments: true,
      },
    ],
  );

  // ---- S4 D6: the classifier accepts exactly five current facts and cannot inspect a persisted object.
  const classifierSource = classifyLedgerStatusCurrent.toString();
  const parameterStart = classifierSource.indexOf('(');
  let parameterEnd = -1;
  let parameterDepth = 0;
  for (let index = parameterStart; index < classifierSource.length; index += 1) {
    if (classifierSource[index] === '(') parameterDepth += 1;
    if (classifierSource[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parameterEnd = index + 1;
        break;
      }
    }
  }
  const classifierParameterText = classifierSource.slice(parameterStart, parameterEnd).replace(/\s/g, '');
  const classifierParameters =
    classifierParameterText.startsWith('({') && classifierParameterText.endsWith('})')
      ? classifierParameterText.slice(1, -1)
      : classifierParameterText;
  check(
    'S4',
    'TERM-classifier-parameter-clause',
    classifierParameters === '{gateResult,acceptance,acceptanceCoverage,verifier,integrityVeto}',
    classifierParameters,
  );

  const classifierReads = [];
  const expectedClassifierReads = new Set([
    'gateResult',
    'acceptance',
    'acceptanceCoverage',
    'verifier',
    'integrityVeto',
  ]);
  const poisonFacts = new Proxy(
    { gateResult: 'pass', acceptance: 'pass', acceptanceCoverage: null, verifier: null, integrityVeto: 'none' },
    {
      get(target, property, receiver) {
        const key = String(property);
        classifierReads.push(key);
        if (!expectedClassifierReads.has(key)) throw new Error(`unexpected classifier property read: ${key}`);
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const poisonResult = classifyLedgerStatusCurrent(poisonFacts);
  check(
    'S4',
    'TERM-classifier-poison-no-unexpected-read',
    poisonResult === 'verified' &&
      classifierReads.length === 5 &&
      classifierReads.every((key) => expectedClassifierReads.has(key)),
    `result=${poisonResult} reads=${JSON.stringify(classifierReads)}`,
  );

  const s4CurrentFacts = {
    gateResult: 'pass',
    acceptance: 'pass',
    acceptanceCoverage: null,
    verifier: null,
    integrityVeto: 'none',
  };
  check(
    'S4',
    'TERM-status-pending-perturbation',
    classifyLedgerStatusCurrent(s4CurrentFacts) === 'verified' &&
      classifyLedgerStatusCurrent({ ...s4CurrentFacts, status: 'pending', pending: ['loaded work'] }) === 'verified',
  );
  check(
    'S4',
    'TERM-snapshot-perturbation',
    classifyLedgerStatusCurrent(s4CurrentFacts) === 'verified' &&
      classifyLedgerStatusCurrent({
        ...s4CurrentFacts,
        acceptance_verdict: 'fail',
        verifier_snapshot: { verdict: 'FAIL' },
      }) === 'verified',
  );
  check(
    'S4',
    'TERM-selection-perturbation',
    classifyLedgerStatusCurrent(s4CurrentFacts) === 'verified' &&
      classifyLedgerStatusCurrent({ ...s4CurrentFacts, updated_at: '2099-01-01T00:00:00.000Z', report: [] }) ===
        'verified',
  );
  check(
    'S4',
    'TERM-standing-veto',
    classifyLedgerStatusCurrent({ ...s4CurrentFacts, integrityVeto: 'unresolved' }) === 'blocked',
  );
  check(
    'S4',
    'TERM-omission-blocks',
    classifyLedgerStatusCurrent({ ...s4CurrentFacts, integrityVeto: 'unresolved', verifier: null }) === 'blocked',
  );
  check(
    'S4',
    'NOGATE-ordinary-exit-1',
    (() => {
      const result = runHarness(repo, ['evaluate', '--task=P6T', '--no-gate', '--run-id=s4-api-no-gate', '--quiet']);
      return result.status === 1;
    })(),
  );
  check('S4', 'NOGATE-no-terminal-field', !Object.hasOwn(lastRunEvent(repo, 's4-api-no-gate') ?? {}, 'ledger_status'));
  check(
    'S4',
    'NOGATE-byte-stable',
    (() => {
      const id = 's4-api-byte-stable';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      const path = join(harnessHome, 'state/ledgers', `${id}.json`);
      const before = readFileSync(path);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--ledger=' + id,
        '--run-id=s4-api-byte-stable',
        '--quiet',
      ]);
      return result.status === 1 && readFileSync(path).equals(before);
    })(),
  );
  check(
    'S4',
    'NOGATE-FAIL-failed',
    (() => {
      const id = 's4-api-fail';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--verifier-verdict=FAIL',
        '--ledger=' + id,
        '--run-id=s4-api-fail-run',
        '--quiet',
      ]);
      return result.status === 1 && ledgerJson(repo, 'P6T', id)?.status === 'failed';
    })(),
  );
  check(
    'S4',
    'NOGATE-CHANGED-blocked',
    (() => {
      const id = 's4-api-changed';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--verifier-verdict=PASS',
        '--artifact-integrity=CHANGED',
        '--artifact-integrity-basis=selftest current observation',
        '--ledger=' + id,
        '--run-id=s4-api-changed-run',
        '--quiet',
      ]);
      return result.status === 1 && ledgerJson(repo, 'P6T', id)?.status === 'blocked';
    })(),
  );
  check(
    'S4',
    'NOGATE-UNCHANGED-no-clear',
    (() => {
      const id = 's4-api-unchanged';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--verifier-verdict=PASS',
        '--artifact-integrity=CHANGED',
        '--artifact-integrity-basis=selftest current observation',
        '--ledger=' + id,
        '--run-id=s4-api-unchanged-block',
        '--quiet',
      ]);
      const path = join(harnessHome, 'state/ledgers', `${id}.json`);
      const before = readFileSync(path);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--verifier-verdict=PASS',
        '--artifact-integrity=UNCHANGED',
        '--artifact-integrity-basis=selftest current declaration',
        '--ledger=' + id,
        '--run-id=s4-api-unchanged-run',
        '--quiet',
      ]);
      return (
        result.status === 1 && ledgerJson(repo, 'P6T', id)?.status === 'blocked' && readFileSync(path).equals(before)
      );
    })(),
  );
  check(
    'S4',
    'NOGATE-PASS-nonmutating',
    (() => {
      const id = 's4-api-pass';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      const path = join(harnessHome, 'state/ledgers', `${id}.json`);
      const before = readFileSync(path);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--verifier-verdict=PASS',
        '--artifact-integrity=UNCHANGED',
        '--artifact-integrity-basis=selftest current declaration',
        '--ledger=' + id,
        '--run-id=s4-api-pass-run',
        '--quiet',
      ]);
      return result.status === 1 && readFileSync(path).equals(before);
    })(),
  );
  check(
    'S4',
    'E1-forged-stopped',
    (() => {
      const id = 's4-api-forged';
      runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + id]);
      const path = join(harnessHome, 'state/ledgers', `${id}.json`);
      const forged = JSON.parse(readFileSync(path));
      forged.status = 'verified';
      const before = Buffer.from(`${JSON.stringify(forged, null, 2)}\n`);
      writeFileSync(path, before);
      const result = runHarness(repo, [
        'evaluate',
        '--task=P6T',
        '--no-gate',
        '--ledger=' + id,
        '--run-id=s4-api-forged-run',
        '--quiet',
      ]);
      const event = lastRunEvent(repo, 's4-api-forged-run');
      return result.status === 1 && !Object.hasOwn(event ?? {}, 'ledger_status') && readFileSync(path).equals(before);
    })(),
  );

  // ---- I6: acceptance predicates are tied to real execution state
  writeFileSync(join(repo, 'src', 'app.ts'), 'export function listTasks() {}\n// searchTasks removed\n');
  const absentPass = evaluateCheck(
    { id: 'c1', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks', paths: ['src'], exclude_comments: true },
    ctx,
  );
  check(
    'I6',
    'absent_pattern passes only when no non-comment match remains',
    absentPass.status === 'pass',
    absentPass.detail,
  );

  const absentFail = evaluateCheck(
    { id: 'c2', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks', paths: ['src'] },
    ctx,
  );
  check(
    'I6',
    'absent_pattern fails while a comment still mentions the symbol',
    absentFail.status === 'fail',
    absentFail.detail,
  );

  const presentComment = evaluateCheck(
    { id: 'c3', criterion: 1, kind: 'present_pattern', pattern: 'searchTasks', paths: ['src'], comments_only: true },
    ctx,
  );
  check(
    'I6',
    'present_pattern(comments_only) finds the explanatory comment',
    presentComment.status === 'pass',
    presentComment.detail,
  );

  const fileExists = evaluateCheck({ id: 'c4', criterion: 1, kind: 'file_exists', path: 'src/app.ts' }, ctx);
  const fileMissing = evaluateCheck({ id: 'c5', criterion: 1, kind: 'file_exists', path: 'src/nope.ts' }, ctx);
  check(
    'I6',
    'file_exists distinguishes present and absent paths',
    fileExists.status === 'pass' && fileMissing.status === 'fail',
  );

  // keyset_equal covers EVERY .json under the path by design (fail-closed), so the fixture must not share a
  // directory with unrelated JSON files — otherwise three distinct key sets is the correct answer.
  mkdirSync(join(repo, 'locales'), { recursive: true });
  writeFileSync(join(repo, 'locales', 'en.json'), JSON.stringify({ x: 1, y: { z: 2 } }));
  writeFileSync(join(repo, 'locales', 'de.json'), JSON.stringify({ x: 1, y: { z: 2 } }));
  const keysEqual = evaluateCheck({ id: 'c6', criterion: 1, kind: 'keyset_equal', path: 'locales' }, ctx);
  writeFileSync(join(repo, 'locales', 'de.json'), JSON.stringify({ x: 1, y: { z: 2 }, extra: 3 }));
  const keysDiffer = evaluateCheck({ id: 'c7', criterion: 1, kind: 'keyset_equal', path: 'locales' }, ctx);
  check(
    'I6',
    'keyset_equal detects divergent key sets',
    keysEqual.status === 'pass' && keysDiffer.status === 'fail',
    keysDiffer.detail,
  );

  const outOfScope = evaluateCheck(
    { id: 'c8', criterion: 1, kind: 'diff_scope', file: 'src/app.ts', pattern: 'searchTasks' },
    ctx,
  );
  check('I6', 'diff_scope fails when a changed line is out of scope', outOfScope.status === 'fail', outOfScope.detail);

  const badRevision = evaluateCheck(
    { id: 'c9', criterion: 1, kind: 'diff_scope', file: 'src/app.ts', pattern: 'x' },
    { workspace: repo, sourceCommit: '0000000' },
  );
  check(
    'I6',
    'a predicate that cannot decide returns error (fail-closed)',
    badRevision.status === 'error',
    badRevision.detail,
  );

  // gate_passed must never stand in for a gate that did not run.
  const gateNotRun = evaluateCheck({ id: 'c10', criterion: 1, kind: 'gate_passed' }, ctx);
  const gateFailed = evaluateCheck(
    { id: 'c11', criterion: 1, kind: 'gate_passed' },
    { ...ctx, gate: { ran: true, exitCode: 1, name: 'check' } },
  );
  const gatePassed = evaluateCheck(
    { id: 'c12', criterion: 1, kind: 'gate_passed' },
    { ...ctx, gate: { ran: true, exitCode: 0, name: 'check' } },
  );
  check('I2', 'gate_passed cannot decide when the gate did not run', gateNotRun.status === 'error', gateNotRun.detail);
  check(
    'I2',
    'gate_passed tracks the real gate exit code',
    gateFailed.status === 'fail' && gatePassed.status === 'pass',
    `${gateFailed.detail} | ${gatePassed.detail}`,
  );

  // ---- I2: verdict derivation
  const uncovered = deriveAcceptance(['a', 'b'], [{ id: 'x', criterion: 1, status: 'pass', detail: '' }]);
  check(
    'I2',
    'uncovered criteria yield unresolved, never pass',
    uncovered.verdict === 'unresolved',
    `coverage=${uncovered.coverage}`,
  );

  const failedWins = deriveAcceptance(
    ['a', 'b'],
    [
      { id: 'x', criterion: 1, status: 'fail', detail: '' },
      { id: 'y', criterion: 2, status: 'pass', detail: '' },
    ],
  );
  check('I2', 'a failed criterion outranks coverage gaps', failedWins.verdict === 'fail');

  const fullPass = deriveAcceptance(['a'], [{ id: 'x', criterion: 1, status: 'pass', detail: '' }]);
  check('I2', 'full coverage with all checks passing yields pass', fullPass.verdict === 'pass');

  const errored = deriveAcceptance(['a'], [{ id: 'x', criterion: 1, status: 'error', detail: '' }]);
  check('I2', 'an undecidable check yields unresolved', errored.verdict === 'unresolved');

  // ---- I9: handoff contract
  const template = handoffTemplate();
  const templateCheck = validateHandoff(template);
  check('I9', 'the handoff template itself validates', templateCheck.ok, templateCheck.problems.join('; '));

  const transcript = validateHandoff({ ...template, transcript: '...' });
  check('I9', 'a handoff carrying a transcript field is rejected', !transcript.ok);

  const tooMany = validateHandoff({ ...template, findings: Array.from({ length: 11 }, (_, i) => `finding ${i}`) });
  check('I9', 'a handoff with more than 10 findings is rejected', !tooMany.ok);

  const badVerdict = validateHandoff({ ...template, role: 'executor', status: 'DEFECTIVE' });
  check('I9', 'a verifier-only status on a non-verifier handoff is rejected', !badVerdict.ok);

  const emptyDefective = validateHandoff({ ...template, role: 'verifier', status: 'DEFECTIVE' });
  check('I9', 'a DEFECTIVE verdict without findings is rejected', !emptyDefective.ok);

  const oversize = validateHandoffText(JSON.stringify({ ...template, claims: ['x'.repeat(9000)] }));
  check('I9', 'an oversized handoff is rejected', !oversize.ok);

  // ---- I3/I4: state transitions through the CLI, in the throwaway HARNESS_HOME
  const init = runHarness(repo, ['ledger', 'init', '--task=P6T']);
  check('I3', 'ledger init succeeds for a valid contract', init.status === 0, init.stderr.trim().slice(0, 120));

  const forged = runHarness(repo, ['ledger', 'set', '--task=P6T', '--status=verified']);
  const ledgerAfterForge = ledgerJson(repo, 'P6T');
  check(
    'I3',
    'an agent cannot set a terminal state, and the attempt is recorded',
    forged.status === 2 &&
      ledgerAfterForge?.status === 'pending' &&
      (ledgerAfterForge?.invalid_transitions ?? []).length === 1,
    `status=${ledgerAfterForge?.status} invalid_transitions=${(ledgerAfterForge?.invalid_transitions ?? []).length}`,
  );

  const forgedFailed = runHarness(repo, ['ledger', 'set', '--task=P6T', '--status=failed']);
  check('I3', 'the failed terminal state is refused as well', forgedFailed.status === 2);

  const blocked = runHarness(repo, ['ledger', 'set', '--task=P6T', '--status=blocked', '--blocker=outside dependency']);
  const ledgerBlocked = ledgerJson(repo, 'P6T');
  check(
    'I4',
    'an unfinishable task can be recorded as blocked with a reason',
    blocked.status === 0 && ledgerBlocked?.status === 'blocked' && (ledgerBlocked?.blockers ?? []).length === 1,
    `status=${ledgerBlocked?.status} blockers=${(ledgerBlocked?.blockers ?? []).length}`,
  );

  const interrupted = runHarness(repo, ['ledger', 'set', '--task=P6T', '--status=interrupted']);
  const ledgerInterrupted = ledgerJson(repo, 'P6T');
  check(
    'I4',
    'interrupted is representable and resumable',
    interrupted.status === 0 && ledgerInterrupted?.status === 'interrupted',
  );

  runHarness(repo, ['ledger', 'set', '--task=P6T', '--status=aborted']);
  const ledgerAborted = ledgerJson(repo, 'P6T');
  check('I4', 'aborted is representable', ledgerAborted?.status === 'aborted');

  // ---- I1/I2/I5: a claim plus a passing mechanical acceptance, with no gate run
  const claimOnly = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--claim-done',
    '--acceptance=auto',
    '--run-id=selftest-claim',
    '--quiet',
  ]);
  const ledgerAfterClaim = ledgerJson(repo, 'P6T');
  const claimEvent = lastRunEvent(repo, 'selftest-claim');
  check(
    'I1',
    'a claim plus a passing acceptance cannot create verification evidence',
    (ledgerAfterClaim?.verification ?? []).length === 0 && claimEvent?.mechanically_verified === false,
    `verification=${(ledgerAfterClaim?.verification ?? []).length} mechanically_verified=${claimEvent?.mechanically_verified}`,
  );
  check(
    'I2',
    'a green mechanical acceptance alone does not verify the task',
    ledgerAfterClaim?.status !== 'verified',
    String(ledgerAfterClaim?.status),
  );
  check(
    'I5',
    'the run is still inside the non-terminal pipeline',
    ['pending', 'in_progress', 'verification_pending', 'blocked', 'aborted', 'interrupted'].includes(
      ledgerAfterClaim?.status,
    ),
    String(ledgerAfterClaim?.status),
  );
  check(
    'I2',
    'false_done is derived from the claim, not from the acceptance verdict',
    claimEvent?.false_done === true && claimEvent?.acceptance_verdict === 'pass',
    `false_done=${claimEvent?.false_done} acceptance=${claimEvent?.acceptance_verdict}`,
  );
  check(
    'I2',
    'the evaluator exits non-zero rather than reporting success',
    claimOnly.status !== 0,
    `exit=${claimOnly.status}`,
  );

  // ---- I2 (coverage gap): an uncovered criterion cannot become a pass
  writeContract(
    harnessHome,
    'P6U',
    sourceCommit,
    ['criterion one', 'criterion two'],
    [
      {
        id: 'k1',
        criterion: 1,
        kind: 'absent_pattern',
        pattern: 'searchTasks',
        paths: ['src'],
        exclude_comments: true,
      },
    ],
  );
  runHarness(repo, ['ledger', 'init', '--task=P6U']);
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=auto',
    '--run-id=selftest-uncovered',
    '--quiet',
  ]);
  const uncoveredEvent = lastRunEvent(repo, 'selftest-uncovered');
  check(
    'I2',
    'an uncovered acceptance criterion yields unresolved, not pass',
    uncoveredEvent?.acceptance_verdict === 'unresolved' && uncoveredEvent?.acceptance_strict_ok === false,
    `verdict=${uncoveredEvent?.acceptance_verdict} coverage=${uncoveredEvent?.acceptance_coverage}`,
  );

  // ---- I7: telemetry failures are missing data, never zeroes
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--run-id=selftest-telemetry-missing',
    '--telemetry-store=' + join(root, 'nonexistent-store'),
    '--quiet',
  ]);
  const missingTelemetry = lastRunEvent(repo, 'selftest-telemetry-missing');
  check(
    'I7',
    'a missing telemetry store reports unavailable with a reason and no fabricated counts',
    missingTelemetry?.telemetry?.status === 'unavailable' &&
      typeof missingTelemetry?.telemetry?.reason === 'string' &&
      !Object.keys(missingTelemetry?.telemetry ?? {}).some((key) => ['tokens_in', 'cost', 'tool_calls'].includes(key)),
    JSON.stringify(missingTelemetry?.telemetry),
  );

  const mismatched = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--run-id=selftest-telemetry-mismatch',
    '--telemetry-store=' + join(root, 'nonexistent-store'),
    '--store-task-id=someone-elses-task',
    '--quiet',
  ]);
  const mismatchedEvent = lastRunEvent(repo, 'selftest-telemetry-mismatch');
  check(
    'I7',
    'a telemetry snapshot that cannot be matched reports a reason',
    mismatchedEvent?.telemetry?.status === 'unavailable' && typeof mismatchedEvent?.telemetry?.reason === 'string',
    JSON.stringify(mismatchedEvent?.telemetry),
  );
  check('I7', 'the mismatched-store probe exits non-zero rather than claiming success', mismatched.status !== 0);

  // ---- I7: schema-2 telemetry preserves four reader-derived leaf states
  const telemetryStore = join(root, 'telemetry-store');
  const telemetryTask = join(telemetryStore, 'TELEMETRY-T4');
  mkdirSync(telemetryTask, { recursive: true });
  writeFileSync(
    join(telemetryTask, 'ui_messages.json'),
    JSON.stringify([
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 0, tokensOut: -2, cacheReads: null, cacheWrites: 'UNKNOWN' }),
        ts: 1,
      },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 5, cacheReads: -3, cacheWrites: null, cost: 1.5 }),
        ts: 2,
      },
      { type: 'say', say: 'api_req_started', text: '{bad', ts: 3 },
    ]),
  );
  const telemetryTaskOut = join(root, 'telemetry-task.json');
  const telemetryTaskRun = runHarness(repo, [
    'telemetry',
    `--store=${telemetryStore}`,
    '--task-dir=TELEMETRY-T4',
    `--out=${telemetryTaskOut}`,
  ]);
  const telemetryTaskJson = JSON.parse(readFileSync(telemetryTaskOut));
  const telemetryRequests = telemetryTaskJson.observed.messages.api_requests;
  const telemetryCounts = (name) => telemetryRequests.metrics[name].source_metric_counts;
  check(
    'I7',
    'TELEMETRY-observed-zero retains finite zero as an observed value',
    telemetryCounts('tokens_in').values_observed === 2 && telemetryRequests.metrics.tokens_in.total === 5,
  );
  check(
    'I7',
    'TELEMETRY-source-null distinguishes explicit null',
    telemetryCounts('cache_reads').values_source_null === 1,
  );
  check(
    'I7',
    'TELEMETRY-absent distinguishes an own key that is not recorded',
    telemetryCounts('tokens_out').values_not_recorded === 1,
  );
  check(
    'I7',
    'TELEMETRY-malformed marks a wrong-type leaf invalid',
    telemetryCounts('cache_writes').values_invalid === 1,
  );
  check(
    'I7',
    'TELEMETRY-unknown-string is invalid rather than observed',
    telemetryCounts('cache_writes').values_invalid === 1,
  );
  check('I7', 'TELEMETRY-negative-finite remains observed', telemetryCounts('tokens_out').values_observed === 1);
  check(
    'I7',
    'TELEMETRY-five-metric-count-identity holds for every reader-enumerated slot',
    telemetryRequests.request_envelopes_parsed === 2 &&
      Object.values(telemetryRequests.metrics).every(
        ({ source_metric_counts: counts }) =>
          counts.records_enumerated === 2 &&
          counts.values_observed + counts.values_source_null + counts.values_not_recorded + counts.values_invalid === 2,
      ),
  );
  check(
    'I7',
    'TELEMETRY-observed-only-total excludes every non-observed leaf',
    telemetryRequests.metrics.cost.total === 1.5,
  );
  check(
    'I7',
    'TELEMETRY-observed-only-mean divides by observed leaves',
    telemetryRequests.metrics.tokens_in.mean === 2.5,
  );
  check('I7', 'TELEMETRY-observed-only-max ignores non-observed leaves', telemetryRequests.metrics.tokens_in.max === 5);
  check(
    'I7',
    'TELEMETRY-malformed-envelope is counted without creating metric slots',
    telemetryRequests.request_envelopes_enumerated === 3 &&
      telemetryRequests.request_envelopes_parsed === 2 &&
      telemetryRequests.request_envelopes_malformed === 1,
  );
  check(
    'I7',
    'TELEMETRY-schema-v2-task uses the versioned acquisition shape',
    telemetryTaskRun.status === 0 &&
      telemetryTaskJson.schema_version === 2 &&
      telemetryTaskJson.acquisition.status === 'available' &&
      telemetryTaskJson.derived.mean_cost_per_observed_cost_leaf === 1.5,
  );
  const telemetryScanOut = join(root, 'telemetry-scan.json');
  const telemetryScanRun = runHarness(repo, [
    'telemetry',
    `--store=${telemetryStore}`,
    '--scan',
    `--out=${telemetryScanOut}`,
  ]);
  const telemetryScanJson = JSON.parse(readFileSync(telemetryScanOut));
  check(
    'I7',
    'TELEMETRY-schema-v2-scan preserves acquisition and metric state counts',
    telemetryScanRun.status === 0 &&
      telemetryScanJson.schema_version === 2 &&
      telemetryScanJson.tasks[0].acquisition.status === 'available' &&
      telemetryScanJson.tasks[0].metric_state_counts.tokens_in.values_observed === 2,
  );

  const unavailableTask = join(telemetryStore, 'TELEMETRY-EMPTY');
  mkdirSync(unavailableTask, { recursive: true });
  const unavailableTaskOut = join(root, 'telemetry-unavailable.json');
  runHarness(repo, [
    'telemetry',
    `--store=${telemetryStore}`,
    '--task-dir=TELEMETRY-EMPTY',
    `--out=${unavailableTaskOut}`,
  ]);
  const unavailableTaskJson = JSON.parse(readFileSync(unavailableTaskOut));
  check(
    'I7',
    'TELEMETRY-store-unavailable-no-zeros has no observed or derived slots',
    unavailableTaskJson.acquisition.status === 'unavailable' &&
      unavailableTaskJson.observed === null &&
      unavailableTaskJson.derived === null &&
      unavailableTaskJson.unavailable_metrics === null,
  );

  const historicalRunPath = join(repo, '.harness/state/runs/selftest-historical-telemetry.jsonl');
  writeFileSync(
    historicalRunPath,
    `${JSON.stringify({ seq: 1, event: 'run_started', run_id: 'selftest-historical-telemetry', task_id: 'P6T', gate: null, gate_exit_code: null })}\n${JSON.stringify({ seq: 2, event: 'run_finished', run_id: 'selftest-historical-telemetry', task_id: 'P6T', self_test: false, gate_incompatible: false, duration_ms: 1, telemetry: { status: 'observed', reason: null, observed: { api_requests: { tokens_in: 0 } }, derived: {}, unavailable_metrics: {} } })}\n`,
  );
  const historicalReportOut = join(root, 'historical-telemetry-report.json');
  const historicalReportRun = runHarness(repo, ['report', `--out=${historicalReportOut}`]);
  const historicalReport = JSON.parse(readFileSync(historicalReportOut));
  check(
    'I7',
    'TELEMETRY-historical-schema-v1-readable remains separate and uninterpreted',
    historicalReportRun.status === 0 &&
      historicalReport.historical_v1_records_uninterpreted >= 1 &&
      Object.values(historicalReport.telemetry.metrics).every((metric) => metric.records_enumerated === 0),
  );

  // ---- I8/I9: mode configuration is validated; isolation is never claimed on an invalid file
  const modesDir = join(root, 'modes');
  mkdirSync(modesDir, { recursive: true });

  const validModes = join(modesDir, 'valid.roomodes');
  writeFileSync(
    validModes,
    [
      'customModes:',
      '  - slug: exec',
      '    name: Exec',
      '    roleDefinition: |',
      '      You implement.',
      '    groups:',
      '      - read',
      '      - edit',
      '    source: project',
      '  - slug: ver',
      '    name: Ver',
      '    roleDefinition: |',
      '      You verify.',
      '    groups:',
      '      - read',
      '      - command',
      '    allowedMcpServers: []',
      '    source: project',
      '',
    ].join('\n'),
  );
  const validRun = runHarness(repo, ['modes', '--file=' + validModes]);
  check(
    'I8',
    'a valid mode file reports the enforceable surfaces',
    validRun.status === 0 && /mode_file: VALID/.test(validRun.stdout),
    validRun.stdout.trim().split('\n').slice(-2).join(' | '),
  );

  const mappingModes = join(modesDir, 'mapping.roomodes');
  writeFileSync(
    mappingModes,
    [
      'customModes:',
      '  - slug: bad',
      '    name: Bad',
      '    roleDefinition: |',
      '      x',
      '    groups:',
      '      - read:',
      "          fileRegex: '\\.md$'",
      '',
    ].join('\n'),
  );
  const mappingRun = runHarness(repo, ['modes', '--file=' + mappingModes]);
  check(
    'I8',
    'a schema-invalid group form is reported as invalid and the mode file is NOT reported valid',
    mappingRun.status === 1 && /mode_file: INVALID/.test(mappingRun.stdout),
    mappingRun.stdout.trim().split('\n').slice(-2).join(' | '),
  );

  const mcpWarn = join(modesDir, 'mcp.roomodes');
  writeFileSync(
    mcpWarn,
    [
      'customModes:',
      '  - slug: broad',
      '    name: Broad',
      '    roleDefinition: |',
      '      x',
      '    groups:',
      '      - read',
      '      - mcp',
      '',
    ].join('\n'),
  );
  const mcpRun = runHarness(repo, ['modes', '--file=' + mcpWarn]);
  check(
    'I9',
    'a mode with the mcp group but no allow-list is warned about',
    /WARN/.test(mcpRun.stdout) && /allowedMcpServers/.test(mcpRun.stdout),
  );

  const inertAllow = join(modesDir, 'inert.roomodes');
  writeFileSync(
    inertAllow,
    [
      'customModes:',
      '  - slug: inert',
      '    name: Inert',
      '    roleDefinition: |',
      '      x',
      '    groups:',
      '      - read',
      '    allowedMcpServers:',
      '      - context7',
      '',
    ].join('\n'),
  );
  const inertRun = runHarness(repo, ['modes', '--file=' + inertAllow]);
  check('I9', 'an allow-list without the mcp group is reported as inert', /inert/.test(inertRun.stdout.toLowerCase()));

  // Acceptance coverage, verifier evidence, and fail-closed invariants are exercised directly and through the CLI.

  // A — an uncovered criterion is a named state, and it can never produce a pass.
  const partialCoverage = deriveAcceptance(
    ['covered criterion', 'uncovered criterion'],
    [{ id: 'k1', criterion: 1, kind: 'absent_pattern', status: 'pass', detail: 'matches=0' }],
  );
  check(
    'I2',
    'per-criterion coverage names the uncovered criterion instead of omitting it',
    partialCoverage.verdict === 'unresolved' &&
      partialCoverage.criteria.length === 2 &&
      partialCoverage.criteria[0].state === 'covered_pass' &&
      partialCoverage.criteria[1].state === 'uncovered' &&
      partialCoverage.coverage_state === 'partial',
    `${partialCoverage.verdict} ${JSON.stringify(partialCoverage.criteria)}`,
  );
  check(
    'I2',
    'an uncovered criterion marks the coverage incomplete; full coverage does not',
    isCoverageIncomplete(partialCoverage) === true &&
      isCoverageIncomplete(deriveAcceptance(['only'], [{ id: 'k', criterion: 1, status: 'pass', detail: '' }])) ===
        false,
    `partial=${isCoverageIncomplete(partialCoverage)}`,
  );

  const blockedLedger = { status: 'verification_pending', pending: [] };
  const blockedByCoverage = classifyLedgerStatus({
    runGate: true,
    gateIncompatible: false,
    mechanicallyVerified: true,
    acceptance: 'unresolved',
    acceptanceCoverage: partialCoverage,
    verifier: null,
    ledger: blockedLedger,
  });
  check(
    'I2',
    'INVARIANT A: a green gate with incomplete coverage lands in blocked, never verified',
    blockedByCoverage === 'blocked',
    blockedByCoverage,
  );
  check(
    'I2',
    'a green gate with a non-pass acceptance and no coverage record keeps its previous non-terminal state',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'unresolved',
      acceptanceCoverage: null,
      verifier: null,
      ledger: blockedLedger,
    }) === 'verification_pending',
  );

  const coverageBlockers = deriveBlockers({
    status: 'blocked',
    acceptanceCoverage: partialCoverage,
    verifier: null,
    at: '2026-01-01T00:00:00.000Z',
    runId: 'selftest',
  });
  check(
    'I2',
    'the blocked state carries a concrete reason naming the uncovered criterion',
    coverageBlockers.length === 1 &&
      coverageBlockers[0].kind === 'acceptance_coverage_incomplete' &&
      coverageBlockers[0].text.includes('2'),
    JSON.stringify(coverageBlockers),
  );

  // Recorded-block persistence — a recorded integrity block stands until evidence clears it: it cannot be lifted by omission.
  const blockedWithIntegrityBlock = {
    status: 'blocked',
    pending: [],
    blockers: [{ at: 'T', kind: 'artifact_integrity_changed', source: 'evaluator', text: 'the artifact changed' }],
  };
  const promoteArgs = (verifierOverride) => ({
    runGate: true,
    gateIncompatible: false,
    mechanicallyVerified: true,
    acceptance: 'pass',
    acceptanceCoverage: null,
    verifier: verifierOverride,
    ledger: blockedWithIntegrityBlock,
  });
  check(
    'I11',
    'a recorded artifact-integrity block is not lifted by a run that supplies no verifier evidence',
    classifyLedgerStatus(promoteArgs(null)) === 'blocked' &&
      classifyLedgerStatus(promoteArgs(compactVerifier({ verdict: 'PASS', artifactIntegrity: 'UNKNOWN' }))) ===
        'blocked',
    `no-evidence=${classifyLedgerStatus(promoteArgs(null))} unknown=${classifyLedgerStatus(promoteArgs(compactVerifier({ verdict: 'PASS', artifactIntegrity: 'UNKNOWN' })))}`,
  );
  check(
    'I11',
    'the block is cleared by evidence: a fresh UNCHANGED observation lets the same run be verified',
    classifyLedgerStatus(promoteArgs(compactVerifier({ verdict: 'PASS', artifactIntegrity: 'UNCHANGED' }))) ===
      'verified',
  );
  check(
    'I11',
    'a ledger without an integrity block is unaffected by the stickiness rule',
    classifyLedgerStatus({ ...promoteArgs(null), ledger: blockedLedger }) === 'verified',
  );

  // B/C/D/H — verifier evidence is advisory: PASS cannot promote, FAIL cannot be ignored, CHANGED is unusable.
  const passVerifier = compactVerifier({
    verdict: 'PASS',
    artifactIntegrity: 'UNCHANGED',
    criteriaChecked: ['A1'],
    evidence: ['ran node --test'],
    runId: 'selftest',
  });
  check(
    'I11',
    'INVARIANT B: a verifier PASS with no acceptance evidence does not verify the task',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'unknown',
      acceptanceCoverage: null,
      verifier: passVerifier,
      ledger: blockedLedger,
    }) === 'verification_pending',
  );
  check(
    'I11',
    'a verifier PASS on a run whose acceptance is unresolved stays blocked',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'unresolved',
      acceptanceCoverage: partialCoverage,
      verifier: passVerifier,
      ledger: blockedLedger,
    }) === 'blocked',
  );
  check(
    'I11',
    'a verifier FAIL forces failed even with a green gate and a passing acceptance',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'pass',
      acceptanceCoverage: null,
      verifier: compactVerifier({ verdict: 'FAIL', artifactIntegrity: 'UNCHANGED' }),
      ledger: blockedLedger,
    }) === 'failed',
  );
  const changedIntegrityVerifier = compactVerifier({ verdict: 'PASS', artifactIntegrity: 'CHANGED' });
  check(
    'I11',
    'a verdict about a changed artifact is not usable — the run blocks and the reason is recorded',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'pass',
      acceptanceCoverage: null,
      verifier: changedIntegrityVerifier,
      ledger: blockedLedger,
    }) === 'blocked' &&
      deriveBlockers({
        status: 'blocked',
        verifier: changedIntegrityVerifier,
        at: '2026-01-01T00:00:00.000Z',
        runId: 'selftest',
      })[0]?.kind === 'artifact_integrity_changed',
  );
  // Integrity and human-acceptance behavior (COVERAGE-FAIL-CLOSED): promotion requires a coverage object that agrees with the verdict. A PARTIAL coverage
  // object is no longer a promotion case; a complete one is.
  const completeCoverage = deriveAcceptance(
    ['criterion one', 'criterion two'],
    [
      { id: 'k1', criterion: 1, kind: 'absent_pattern', status: 'pass', detail: 'matches=0' },
      { id: 'k2', criterion: 2, kind: 'absent_pattern', status: 'pass', detail: 'matches=0' },
    ],
  );
  const failedGateStatus = classifyLedgerStatus({
    runGate: true,
    gateIncompatible: false,
    mechanicallyVerified: false,
    acceptance: 'pass',
    acceptanceCoverage: completeCoverage,
    verifier: null,
    ledger: blockedLedger,
  });
  check(
    'I11',
    'case 2: a failed gate is never a terminal success',
    failedGateStatus === 'failed' && failedGateStatus !== 'verified',
    failedGateStatus,
  );
  check(
    'I11',
    'the one path that may reach verified is gate pass + acceptance pass + COMPLETE coverage + usable verifier evidence',
    completeCoverage.coverage_state === 'covered' &&
      classifyLedgerStatus({
        runGate: true,
        gateIncompatible: false,
        mechanicallyVerified: true,
        acceptance: 'pass',
        acceptanceCoverage: completeCoverage,
        verifier: passVerifier,
        ledger: blockedLedger,
      }) === 'verified',
  );
  check(
    'I11',
    'COVERAGE-FAIL-CLOSED: an acceptance pass contradicted by an incomplete coverage object is blocked, never verified',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'pass',
      acceptanceCoverage: partialCoverage,
      verifier: passVerifier,
      ledger: blockedLedger,
    }) === 'blocked',
  );
  check(
    'I11',
    'COVERAGE-FAIL-CLOSED: the human-acceptance path (no coverage object at all) still reaches verified on a green gate',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'pass',
      acceptanceCoverage: null,
      verifier: passVerifier,
      ledger: blockedLedger,
    }) === 'verified',
  );
  check(
    'I11',
    'COVERAGE-FAIL-CLOSED: a failing criterion still outranks a coverage gap — a failure is evidence, not a coverage question',
    classifyLedgerStatus({
      runGate: true,
      gateIncompatible: false,
      mechanicallyVerified: true,
      acceptance: 'fail',
      acceptanceCoverage: partialCoverage,
      verifier: null,
      ledger: blockedLedger,
    }) === 'failed',
  );
  check(
    'I11',
    'VERIFIER-FAIL: a verifier FAIL is not lost when the gate is skipped — the run ends failed, not unchanged',
    classifyLedgerStatus({
      runGate: false,
      gateIncompatible: false,
      mechanicallyVerified: false,
      acceptance: 'unknown',
      acceptanceCoverage: null,
      verifier: compactVerifier({ verdict: 'FAIL', artifactIntegrity: 'UNCHANGED' }),
      ledger: blockedLedger,
    }) === 'failed',
  );
  check(
    'I11',
    'VERIFIER-FAIL: a verdict about a changed artifact is not lost when the gate is skipped',
    classifyLedgerStatus({
      runGate: false,
      gateIncompatible: false,
      mechanicallyVerified: false,
      acceptance: 'unknown',
      acceptanceCoverage: null,
      verifier: compactVerifier({ verdict: 'PASS', artifactIntegrity: 'CHANGED' }),
      ledger: blockedLedger,
    }) === 'blocked',
  );
  check(
    'I11',
    'INTEGRITY-PROVENANCE: integrity provenance defaults to a declaration and never claims computed evidence on its own',
    compactVerifier({ verdict: 'PASS' }).artifact_integrity_kind === 'declared' &&
      compactVerifier({ verdict: 'PASS' }).artifact_integrity_basis === null &&
      compactVerifier({ verdict: 'PASS', artifactIntegrityKind: 'computed' }).artifact_integrity_kind === 'computed',
  );
  check(
    'I11',
    'INTEGRITY-PROVENANCE: an integrity clearance needs a standing block plus a fresh UNCHANGED observation, and records its kind',
    integrityClearance({ ledger: blockedLedger, verifier: null, at: 'T', runId: 'r' }) === null &&
      integrityClearance({ ledger: blockedWithIntegrityBlock, verifier: null, at: 'T', runId: 'r' }) === null &&
      integrityClearance({
        ledger: blockedWithIntegrityBlock,
        verifier: compactVerifier({ verdict: 'PASS', artifactIntegrity: 'UNKNOWN' }),
        at: 'T',
        runId: 'r',
      }) === null &&
      (() => {
        const entry = integrityClearance({
          ledger: blockedWithIntegrityBlock,
          verifier: compactVerifier({
            verdict: 'PASS',
            artifactIntegrity: 'UNCHANGED',
            artifactIntegrityKind: 'computed',
            artifactIntegrityBasis: 'pre-post sha256 manifest',
          }),
          at: 'T',
          runId: 'r',
        });

        return entry?.cleared_by === 'computed' && entry?.basis === 'pre-post sha256 manifest';
      })(),
  );
  check(
    'I11',
    'HUMAN-ACCEPTANCE: a human acceptance record needs authority, a non-empty in-range scope and a basis — fail-closed',
    validateHumanAcceptance({ criteria: ['a', 'b'], record: null }).length === 0 &&
      validateHumanAcceptance({
        criteria: ['a', 'b'],
        record: {
          mechanism: 'human',
          authority: 'alice',
          covered_criteria: [1, 2],
          basis: 'read the diff',
          recorded_at: '2026-01-01T00:00:00.000Z',
        },
      }).length === 0 &&
      validateHumanAcceptance({ criteria: ['a', 'b'], record: { mechanism: 'human' } }).length > 0 &&
      validateHumanAcceptance({
        criteria: ['a', 'b'],
        record: { mechanism: 'human', authority: 'a', covered_criteria: [9], basis: 'x', recorded_at: 'T' },
      }).some((problem) => problem.includes('not an index into acceptance[]')) &&
      validateHumanAcceptance({
        criteria: ['a', 'b'],
        record: { mechanism: 'human', authority: 'a', covered_criteria: [1, 1], basis: 'x', recorded_at: 'T' },
      }).some((problem) => problem.includes('duplicate')) &&
      validateHumanAcceptance({
        criteria: ['a', 'b'],
        record: {
          mechanism: 'human',
          authority: 'a',
          covered_criteria: [1],
          basis: 'x',
          recorded_at: 'T',
          risk: 'HIGH',
        },
      }).some((problem) => problem.includes('unknown field')),
  );
  check(
    'I11',
    'artifact integrity UNKNOWN is preserved as UNKNOWN, never upgraded to a clean observation',
    compactVerifier({ verdict: 'PASS' }).artifact_integrity === 'UNKNOWN' &&
      changedIntegrityVerifier.artifact_integrity === 'CHANGED',
  );
  check(
    'I11',
    'compact verifier evidence caps its lists, truncates long entries and carries no transcript field',
    (() => {
      const compact = compactVerifier({
        verdict: 'FAIL',
        findings: Array.from({ length: 25 }, (_, index) => `finding ${index}`),
        evidence: ['x'.repeat(2000)],
      });

      return compact.findings.length === 10 && compact.evidence[0].length === 400 && !('transcript' in compact);
    })(),
  );
  check(
    'I11',
    'a verifier handoff must carry verdict and artifact_integrity; an executor handoff need not',
    validateHandoff({ task_id: 'T', role: 'verifier', status: 'SATISFIES' }).problems.some((problem) =>
      problem.includes('verdict'),
    ) &&
      validateHandoff({
        task_id: 'T',
        role: 'verifier',
        status: 'SATISFIES',
        verdict: 'PASS',
        artifact_integrity: 'UNCHANGED',
      }).ok === true &&
      validateHandoff({ task_id: 'T', role: 'executor', status: 'WORK_COMPLETE' }).problems.length === 0,
  );

  // STATE-EVALUATION end-to-end exit-contract matrix. The throwaway repository gets a compatible, deliberately trivial gate so
  // exit-code assertions exercise the public evaluate contract without running the application suite.
  const writeGateFixture = (root, { lintExit = 0, uiTypecheck = true } = {}) => {
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'ui'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'harness-selftest-fixture',
        private: true,
        workspaces: ['server', 'ui'],
        scripts: {
          lint: `node -e "process.exit(${lintExit})"`,
          typecheck: 'node -e "process.exit(0)"',
        },
      }),
    );
    writeFileSync(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: '@task-board/server', scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    writeFileSync(
      join(root, 'ui', 'package.json'),
      JSON.stringify({
        name: '@task-board/ui',
        scripts: {
          ...(uiTypecheck ? { typecheck: 'node -e "process.exit(0)"' } : {}),
          test: 'node -e "process.exit(0)"',
        },
      }),
    );
  };

  writeGateFixture(repo);

  // ---- STATE-MODEL: append-only status-transition observability. The history records decisions after they are made and
  // is never an input to classification, blocker derivation or acceptance.
  const stateModelEvaluatorLedger = 'stateModel-evaluator-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateModelEvaluatorLedger]);
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--ledger=' + stateModelEvaluatorLedger,
    '--run-id=stateModel-evaluator-transition',
    '--quiet',
  ]);
  const stateModelEvaluatorAfter = ledgerJson(repo, 'P6T', stateModelEvaluatorLedger);
  check(
    'S4',
    'STATE-MODEL ordinary no-gate writes no evaluator transition or status',
    stateModelEvaluatorAfter?.status === 'pending' && (stateModelEvaluatorAfter?.transitions ?? []).length === 0,
    JSON.stringify({ status: stateModelEvaluatorAfter?.status, transitions: stateModelEvaluatorAfter?.transitions ?? null }),
  );

  const stateModelOperatorLedger = 'stateModel-operator-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateModelOperatorLedger]);
  runHarness(repo, ['ledger', 'set', '--task=P6T', '--run-id=' + stateModelOperatorLedger, '--status=interrupted']);
  const stateModelOperatorAfter = ledgerJson(repo, 'P6T', stateModelOperatorLedger);
  check(
    'I11',
    'STATE-MODEL ledger set appends one operator-attributed transition and no evaluator run id',
    stateModelOperatorAfter?.transitions?.length === 1 &&
      stateModelOperatorAfter.transitions[0].from === 'pending' &&
      stateModelOperatorAfter.transitions[0].to === 'interrupted' &&
      stateModelOperatorAfter.transitions[0].source === 'agent' &&
      stateModelOperatorAfter.transitions[0].cause === 'harness ledger set' &&
      stateModelOperatorAfter.transitions[0].run_id === null,
    JSON.stringify(stateModelOperatorAfter?.transitions),
  );

  const stateModelNoChangeLedger = 'stateModel-no-change-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateModelNoChangeLedger]);
  runHarness(repo, ['ledger', 'set', '--task=P6T', '--run-id=' + stateModelNoChangeLedger, '--status=in_progress']);
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--ledger=' + stateModelNoChangeLedger,
    '--run-id=stateModel-no-status-change',
    '--quiet',
  ]);
  const stateModelNoChangeAfter = ledgerJson(repo, 'P6T', stateModelNoChangeLedger);
  check(
    'I11',
    'STATE-MODEL an evaluation that does not change status appends no transition',
    stateModelNoChangeAfter?.status === 'in_progress' && stateModelNoChangeAfter?.transitions?.length === 1,
    `status=${stateModelNoChangeAfter?.status} transitions=${stateModelNoChangeAfter?.transitions?.length}`,
  );

  const stateModelHistoryLedger = {
    status: 'verification_pending',
    pending: [],
    transitions: [
      {
        at: '2026-01-01T00:00:00.000Z',
        from: 'pending',
        to: 'verification_pending',
        source: 'evaluator',
        cause: 'harness evaluate',
        run_id: 'history-run',
        reason: 'recorded, not governing',
      },
    ],
  };
  const { transitions: ignoredHistory, ...stateModelLedgerWithoutHistory } = stateModelHistoryLedger;
  const stateModelClassificationInput = {
    runGate: true,
    gateIncompatible: false,
    mechanicallyVerified: true,
    acceptance: 'unresolved',
    acceptanceCoverage: partialCoverage,
    verifier: null,
  };
  const stateModelHistoryStatus = classifyLedgerStatus({ ...stateModelClassificationInput, ledger: stateModelHistoryLedger });
  const stateModelNoHistoryStatus = classifyLedgerStatus({ ...stateModelClassificationInput, ledger: stateModelLedgerWithoutHistory });
  const stateModelHistoryBlockers = deriveBlockers({
    status: 'blocked',
    acceptanceCoverage: partialCoverage,
    verifier: null,
    at: '2026-01-01T00:00:00.000Z',
    runId: 'history-run',
    ledger: stateModelHistoryLedger,
  });
  const stateModelNoHistoryBlockers = deriveBlockers({
    status: 'blocked',
    acceptanceCoverage: partialCoverage,
    verifier: null,
    at: '2026-01-01T00:00:00.000Z',
    runId: 'history-run',
    ledger: stateModelLedgerWithoutHistory,
  });
  check(
    'I11',
    'STATE-MODEL NON-CAUSALITY: transition history does not change classifyLedgerStatus or deriveBlockers output',
    stateModelHistoryStatus === stateModelNoHistoryStatus &&
      JSON.stringify(stateModelHistoryBlockers) === JSON.stringify(stateModelNoHistoryBlockers),
    `with=${stateModelHistoryStatus}/${JSON.stringify(stateModelHistoryBlockers)} without=${stateModelNoHistoryStatus}/${JSON.stringify(stateModelNoHistoryBlockers)}`,
  );

  const stateModelStandingBlockLedger = {
    ...stateModelLedgerWithoutHistory,
    status: 'blocked',
    blockers: [{ at: 'T', kind: 'artifact_integrity_changed', source: 'evaluator', text: 'the artifact changed' }],
  };
  const stateModelStandingBlockWithHistory = {
    ...stateModelStandingBlockLedger,
    transitions: stateModelHistoryLedger.transitions,
  };
  const stateModelStandingBlockClassification = (ledger) =>
    classifyLedgerStatus({ ...stateModelClassificationInput, acceptance: 'pass', verifier: null, ledger });
  check(
    'I11',
    'STATE-MODEL NON-CAUSALITY: a standing artifact_integrity_changed blocker stands with or without transition history',
    stateModelStandingBlockClassification(stateModelStandingBlockWithHistory) === 'blocked' &&
      stateModelStandingBlockClassification(stateModelStandingBlockLedger) === 'blocked' &&
      hasUnresolvedIntegrityBlocker(stateModelStandingBlockWithHistory) === true &&
      hasUnresolvedIntegrityBlocker(stateModelStandingBlockLedger) === true,
    `with=${stateModelStandingBlockClassification(stateModelStandingBlockWithHistory)} without=${stateModelStandingBlockClassification(stateModelStandingBlockLedger)}`,
  );

  const stateModelResumeLedger = 'stateModel-resume-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateModelResumeLedger]);
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--ledger=' + stateModelResumeLedger,
    '--run-id=stateModel-resume-pending',
    '--quiet',
  ]);
  runHarness(repo, ['ledger', 'set', '--task=P6T', '--run-id=' + stateModelResumeLedger, '--status=interrupted']);
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--acceptance=pass',
    '--ledger=' + stateModelResumeLedger,
    '--run-id=stateModel-resume-complete',
    '--quiet',
  ]);
  const stateModelResumeAfter = ledgerJson(repo, 'P6T', stateModelResumeLedger);
  const stateModelResumeSequence = [
    stateModelResumeAfter?.transitions?.[0]?.from,
    ...(stateModelResumeAfter?.transitions ?? []).map((transition) => transition.to),
  ];
  check(
    'I11',
    'STATE-MODEL acceptance payoff: the final ledger alone reconstructs pending → verification_pending → interrupted → resumed verified',
    JSON.stringify(stateModelResumeSequence) ===
      JSON.stringify(['pending', 'verification_pending', 'interrupted', 'verified']) &&
      stateModelResumeAfter?.transitions?.[1]?.source === 'agent' &&
      stateModelResumeAfter?.transitions?.[2]?.run_id === 'stateModel-resume-complete',
    JSON.stringify(stateModelResumeSequence),
  );

  const stateModelBoundedLedger = 'stateModel-bounded-ledger';
  const stateModelBoundedRunId = `stateModel-${'r'.repeat(220)}`;
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateModelBoundedLedger]);
  const stateModelBoundedRun = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--ledger=' + stateModelBoundedLedger,
    '--run-id=' + stateModelBoundedRunId,
    '--notes=' + 'n'.repeat(600),
    '--quiet',
  ]);
  check(
    'I11',
    'S2 bounded run ids reject overlong tokens before publication or ledger mutation',
    stateModelBoundedRun.status === 2 &&
      stateModelBoundedRun.stderr.includes('invalid run id') &&
      !existsSync(join(harnessHome, 'state/runs', `${stateModelBoundedRunId}.jsonl`)) &&
      (ledgerJson(repo, 'P6T', stateModelBoundedLedger)?.transitions?.length ?? 0) === 0,
    JSON.stringify({
      exit: stateModelBoundedRun.status,
      stderr: stateModelBoundedRun.stderr.trim(),
      transitions: ledgerJson(repo, 'P6T', stateModelBoundedLedger)?.transitions?.length ?? 0,
    }),
  );

  const stateEvaluationVerifiedLedger = 'stateEvaluation-verified-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateEvaluationVerifiedLedger]);
  const stateEvaluationVerified = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--acceptance=auto',
    '--verifier-verdict=PASS',
    '--artifact-integrity=UNCHANGED',
    '--artifact-integrity-basis=selftest fixture comparison',
    '--ledger=' + stateEvaluationVerifiedLedger,
    '--run-id=stateEvaluation-verified',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached verified exits 0',
    stateEvaluationVerified.status === 0 && ledgerJson(repo, 'P6T', stateEvaluationVerifiedLedger)?.status === 'verified',
    `exit=${stateEvaluationVerified.status} status=${ledgerJson(repo, 'P6T', stateEvaluationVerifiedLedger)?.status}`,
  );

  const stateEvaluationIncompleteLedger = 'stateEvaluation-incomplete-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6U', '--run-id=' + stateEvaluationIncompleteLedger]);
  const stateEvaluationIncomplete = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--acceptance=auto',
    '--verifier-verdict=PASS',
    '--artifact-integrity=UNCHANGED',
    '--artifact-integrity-basis=selftest fixture comparison',
    '--ledger=' + stateEvaluationIncompleteLedger,
    '--run-id=stateEvaluation-incomplete',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached incomplete coverage exits 1 instead of reporting the green gate as success',
    stateEvaluationIncomplete.status === 1 && ledgerJson(repo, 'P6U', stateEvaluationIncompleteLedger)?.status === 'blocked',
    `exit=${stateEvaluationIncomplete.status} status=${ledgerJson(repo, 'P6U', stateEvaluationIncompleteLedger)?.status}`,
  );

  const stateEvaluationPendingLedger = 'stateEvaluation-pending-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateEvaluationPendingLedger]);
  const stateEvaluationPending = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--ledger=' + stateEvaluationPendingLedger,
    '--run-id=stateEvaluation-pending',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached acceptance not judged exits 1 for verification_pending',
    stateEvaluationPending.status === 1 && ledgerJson(repo, 'P6T', stateEvaluationPendingLedger)?.status === 'verification_pending',
    `exit=${stateEvaluationPending.status} status=${ledgerJson(repo, 'P6T', stateEvaluationPendingLedger)?.status}`,
  );

  const stateEvaluationFailLedger = 'stateEvaluation-fail-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateEvaluationFailLedger]);
  const stateEvaluationFail = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--acceptance=auto',
    '--verifier-verdict=FAIL',
    '--ledger=' + stateEvaluationFailLedger,
    '--run-id=stateEvaluation-fail',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached verifier FAIL remains a non-zero failed evaluation',
    stateEvaluationFail.status === 1 && ledgerJson(repo, 'P6T', stateEvaluationFailLedger)?.status === 'failed',
    `exit=${stateEvaluationFail.status} status=${ledgerJson(repo, 'P6T', stateEvaluationFailLedger)?.status}`,
  );

  const stateEvaluationIncompatibleLedger = 'stateEvaluation-incompatible-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateEvaluationIncompatibleLedger]);
  writeGateFixture(repo, { uiTypecheck: false });
  const stateEvaluationIncompatible = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--ledger=' + stateEvaluationIncompatibleLedger,
    '--run-id=stateEvaluation-incompatible',
    '--quiet',
  ]);
  writeGateFixture(repo);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached incompatible gate keeps the exit-3 setup-failure signal',
    stateEvaluationIncompatible.status === 3 && ledgerJson(repo, 'P6T', stateEvaluationIncompatibleLedger)?.status === 'blocked',
    `exit=${stateEvaluationIncompatible.status} status=${ledgerJson(repo, 'P6T', stateEvaluationIncompatibleLedger)?.status}`,
  );

  const stateEvaluationIntegrityLedger = 'stateEvaluation-integrity-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=' + stateEvaluationIntegrityLedger]);
  runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--verifier-verdict=PASS',
    '--artifact-integrity=CHANGED',
    '--artifact-integrity-basis=selftest fixture observation',
    '--ledger=' + stateEvaluationIntegrityLedger,
    '--run-id=stateEvaluation-integrity-blocked',
    '--quiet',
  ]);
  const stateEvaluationIntegrity = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--acceptance=auto',
    '--ledger=' + stateEvaluationIntegrityLedger,
    '--run-id=stateEvaluation-integrity',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION ledger-attached standing integrity block exits 1 while remaining uncleared',
    stateEvaluationIntegrity.status === 1 && ledgerJson(repo, 'P6T', stateEvaluationIntegrityLedger)?.status === 'blocked',
    `exit=${stateEvaluationIntegrity.status} status=${ledgerJson(repo, 'P6T', stateEvaluationIntegrityLedger)?.status}`,
  );

  const stateEvaluationNoLedgerGreen = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--acceptance=auto',
    '--run-id=stateEvaluation-no-ledger-green',
    '--quiet',
  ]);
  check(
    'I11',
    'STATE-EVALUATION no-ledger green gate retains exit 0',
    stateEvaluationNoLedgerGreen.status === 0,
    `exit=${stateEvaluationNoLedgerGreen.status}`,
  );

  const stateEvaluationNoLedgerHuman = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--no-gate',
    '--acceptance=pass',
    '--acceptance-authority=selftest',
    '--acceptance-criteria=1',
    '--acceptance-basis=explicit fixture acceptance',
    '--run-id=stateEvaluation-no-ledger-human',
    '--quiet',
  ]);
  check(
    'S4',
    'STATE-EVALUATION no-ledger recorded human acceptance pass under no-gate returns exit 1',
    stateEvaluationNoLedgerHuman.status === 1,
    `exit=${stateEvaluationNoLedgerHuman.status}`,
  );

  writeGateFixture(repo, { lintExit: 1 });
  const stateEvaluationNoLedgerGateFailure = runHarness(repo, [
    'evaluate',
    '--task=P6T',
    '--run-id=stateEvaluation-no-ledger-failure',
    '--quiet',
  ]);
  writeGateFixture(repo);
  check(
    'I11',
    'STATE-EVALUATION no-ledger gate failure retains exit 1',
    stateEvaluationNoLedgerGateFailure.status === 1,
    `exit=${stateEvaluationNoLedgerGateFailure.status}`,
  );

  const stateEvaluationUsage = runHarness(repo, ['evaluate', '--task=P6T', '--acceptance=invalid']);
  check('I11', 'STATE-EVALUATION usage validation error retains exit 2', stateEvaluationUsage.status === 2, `exit=${stateEvaluationUsage.status}`);

  const stateEvaluationIncompleteEvent = lastRunEvent(repo, 'stateEvaluation-incomplete');
  const stateEvaluationIncompleteAfter = ledgerJson(repo, 'P6U', stateEvaluationIncompleteLedger);
  check(
    'I11',
    'STATE-EVALUATION exit code reports the classified state without feeding back into it',
    stateEvaluationIncompleteEvent?.ledger_status === 'blocked' &&
      stateEvaluationIncompleteAfter?.status === 'blocked' &&
      stateEvaluationIncomplete.status === 1,
    `event=${stateEvaluationIncompleteEvent?.ledger_status} ledger=${stateEvaluationIncompleteAfter?.status} exit=${stateEvaluationIncomplete.status}`,
  );

  // End-to-end: evidence lands in the ledger and the event stream, and a claim stays a claim.
  const verifierLedgerId = 'selftest-verifier-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6U', '--run-id=' + verifierLedgerId]);
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=auto',
    '--verifier-verdict=PASS',
    '--claim-done',
    '--ledger=' + verifierLedgerId,
    '--run-id=selftest-verifier',
    '--quiet',
  ]);
  const verifierLedger = ledgerJson(repo, 'P6U', verifierLedgerId);
  const verifierEvent = lastRunEvent(repo, 'selftest-verifier');
  check(
    'S4',
    'ordinary no-gate verifier and acceptance evidence stays in the run event and does not mutate the ledger',
    verifierEvent?.verifier?.verdict === 'PASS' &&
      verifierEvent?.verifier?.artifact_integrity === 'UNKNOWN' &&
      Array.isArray(verifierEvent?.acceptance_uncovered_criteria) &&
      verifierLedger?.verifier === null &&
      verifierLedger?.acceptance_checks === undefined,
    JSON.stringify({
      verifier: verifierEvent?.verifier?.verdict,
      uncovered: verifierEvent?.acceptance_uncovered_criteria,
      ledgerVerifier: verifierLedger?.verifier,
    }),
  );
  check(
    'I11',
    'the run event carries the verifier record, the coverage states and the blocked-reason field',
    verifierEvent?.verifier?.verdict === 'PASS' &&
      verifierEvent?.acceptance_coverage_incomplete === true &&
      Array.isArray(verifierEvent?.acceptance_uncovered_criteria) &&
      'blocked_reason' in (verifierEvent ?? {}),
    JSON.stringify({
      verdict: verifierEvent?.verifier?.verdict,
      incomplete: verifierEvent?.acceptance_coverage_incomplete,
      uncovered: verifierEvent?.acceptance_uncovered_criteria,
    }),
  );
  check(
    'S4',
    'ordinary no-gate records a claim in the run event without adding it to the ledger',
    verifierEvent?.agent_claimed_done === true &&
      verifierLedger?.status === 'pending' &&
      (verifierLedger?.claims ?? []).length === 0,
    `event=${verifierEvent?.agent_claimed_done} status=${verifierLedger?.status} claims=${(verifierLedger?.claims ?? []).length}`,
  );

  const verifierFailRun = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-verdict=FAIL',
    '--run-id=selftest-verifier-fail',
    '--quiet',
  ]);
  check(
    'I11',
    'a recorded verifier FAIL makes the evaluator exit non-zero instead of reporting success',
    verifierFailRun.status === 1,
    `exit=${verifierFailRun.status}`,
  );

  // ---- Human-acceptance and evidence paths: the CLI surface for INTEGRITY-PROVENANCE, HANDOFF and HUMAN-ACCEPTANCE
  const humanLedgerId = 'selftest-human-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6U', '--run-id=' + humanLedgerId]);
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=pass',
    '--acceptance-authority=alice',
    '--acceptance-criteria=2',
    '--acceptance-basis=read the diff and the SPEC',
    '--ledger=' + humanLedgerId,
    '--run-id=selftest-human-attributed',
    '--quiet',
  ]);
  const humanAttributed = ledgerJson(repo, 'P6U', humanLedgerId);
  const humanAttributedEvent = lastRunEvent(repo, 'selftest-human-attributed');
  check(
    'S4',
    'HUMAN-ACCEPTANCE: no-gate records a complete human acceptance record in the run event without mutating the ledger',
    humanAttributedEvent?.acceptance_record?.mechanism === 'human' &&
      humanAttributedEvent?.acceptance_record?.authority === 'alice' &&
      JSON.stringify(humanAttributedEvent?.acceptance_record?.covered_criteria) === '[2]' &&
      humanAttributed?.acceptance_record === undefined,
    JSON.stringify(humanAttributedEvent?.acceptance_record ?? null),
  );
  const humanBare = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=pass',
    '--run-id=selftest-human-bare',
    '--quiet',
  ]);
  const humanBareEvent = lastRunEvent(repo, 'selftest-human-bare');
  check(
    'S4',
    'HUMAN-ACCEPTANCE: a no-gate human pass with no record is labelled operator trust in the run event and exits 1',
    humanBare.status === 1 &&
      humanBareEvent?.acceptance_record === null &&
      humanBareEvent?.acceptance_record_classification === 'operator_trust',
    JSON.stringify({ exit: humanBare.status, classification: humanBareEvent?.acceptance_record_classification }),
  );
  const humanBadScope = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=pass',
    '--acceptance-authority=alice',
    '--acceptance-criteria=9',
    '--acceptance-basis=out of range',
    '--run-id=selftest-human-bad-scope',
    '--quiet',
  ]);
  check(
    'I11',
    'HUMAN-ACCEPTANCE: an out-of-range human scope is refused fail-closed, not normalised',
    humanBadScope.status === 2 && humanBadScope.stderr.includes('not an index into acceptance[]'),
    humanBadScope.stderr.trim().slice(0, 140),
  );
  const humanWrongMode = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--acceptance=auto',
    '--acceptance-authority=alice',
    '--acceptance-criteria=1',
    '--acceptance-basis=wrong mechanism',
    '--run-id=selftest-human-wrong-mode',
    '--quiet',
  ]);
  check(
    'I11',
    'HUMAN-ACCEPTANCE: a human acceptance record attached to a non-human acceptance value is refused',
    humanWrongMode.status === 2 && humanWrongMode.stderr.includes('require --acceptance=pass'),
    humanWrongMode.stderr.trim().slice(0, 140),
  );

  const integrityNoBasis = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-verdict=PASS',
    '--artifact-integrity=UNCHANGED',
    '--run-id=selftest-integrity-no-basis',
    '--quiet',
  ]);
  check(
    'I11',
    'INTEGRITY-PROVENANCE: an artifact-integrity observation without a basis is refused — no basis, no observation',
    integrityNoBasis.status === 2 && integrityNoBasis.stderr.includes('--artifact-integrity-basis'),
    integrityNoBasis.stderr.trim().slice(0, 140),
  );

  const integrityLedgerId = 'selftest-integrity-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6U', '--run-id=' + integrityLedgerId]);
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-verdict=PASS',
    '--artifact-integrity=CHANGED',
    '--artifact-integrity-basis=declared by the verifier, no digest computed',
    '--ledger=' + integrityLedgerId,
    '--run-id=selftest-integrity-changed',
    '--quiet',
  ]);
  const afterChanged = ledgerJson(repo, 'P6U', integrityLedgerId);
  check(
    'I11',
    'INTEGRITY-PROVENANCE: a declared observation is stored with its kind defaulting to declared, never to computed',
    afterChanged?.verifier?.artifact_integrity === 'CHANGED' &&
      afterChanged?.verifier?.artifact_integrity_kind === 'declared' &&
      afterChanged?.verifier?.artifact_integrity_basis === 'declared by the verifier, no digest computed',
    JSON.stringify(afterChanged?.verifier ?? null),
  );
  check(
    'I11',
    'VERIFIER-FAIL: with the gate skipped, a CHANGED observation still leaves the durable state blocked',
    afterChanged?.status === 'blocked' &&
      (afterChanged?.blockers ?? []).some((entry) => entry.kind === 'artifact_integrity_changed'),
    'status=' + afterChanged?.status,
  );
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-verdict=PASS',
    '--artifact-integrity=UNCHANGED',
    '--artifact-integrity-basis=pre-post sha256 manifest',
    '--artifact-integrity-kind=computed',
    '--ledger=' + integrityLedgerId,
    '--run-id=selftest-integrity-cleared',
    '--quiet',
  ]);
  const afterCleared = ledgerJson(repo, 'P6U', integrityLedgerId);
  const unchangedNoGateEvent = lastRunEvent(repo, 'selftest-integrity-cleared');
  check(
    'S4',
    'INTEGRITY-PROVENANCE: no-gate UNCHANGED cannot clear a standing integrity block or mutate the ledger',
    afterCleared?.status === 'blocked' &&
      (afterCleared?.integrity_clearances ?? []).length === 0 &&
      !Object.hasOwn(unchangedNoGateEvent ?? {}, 'ledger_status'),
    JSON.stringify(afterCleared?.integrity_clearances ?? null),
  );

  const handoffReportPath = join(repo, 'selftest-verifier-handoff.json');
  writeFileSync(
    handoffReportPath,
    JSON.stringify({
      task_id: 'P6U',
      role: 'verifier',
      status: 'SATISFIES',
      verdict: 'PASS',
      artifact_integrity: 'UNCHANGED',
      criteria_checked: ['1'],
      findings: [],
    }) + '\n',
  );
  const handoffLedgerId = 'selftest-handoff-ledger';
  runHarness(repo, ['ledger', 'init', '--task=P6U', '--run-id=' + handoffLedgerId]);
  runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-report=' + handoffReportPath,
    '--artifact-integrity-basis=declared in the handoff report',
    '--ledger=' + handoffLedgerId,
    '--run-id=selftest-handoff',
    '--quiet',
  ]);
  const handoffLedger = ledgerJson(repo, 'P6U', handoffLedgerId);
  const handoffEvent = lastRunEvent(repo, 'selftest-handoff');
  check(
    'S4',
    'HANDOFF: no-gate handoff evidence is recorded in the run event with source=handoff and leaves the ledger unchanged',
    handoffEvent?.verifier?.source === 'handoff' &&
      handoffEvent?.verifier?.verdict === 'PASS' &&
      handoffLedger?.verifier === null,
    JSON.stringify({ source: handoffEvent?.verifier?.source, verdict: handoffEvent?.verifier?.verdict }),
  );

  const badIntegrity = runHarness(repo, [
    'evaluate',
    '--task=P6U',
    '--no-gate',
    '--verifier-verdict=PASS',
    '--artifact-integrity=NONSENSE',
    '--run-id=selftest-verifier-invalid',
    '--quiet',
  ]);
  check(
    'I11',
    'an invalid artifact-integrity value is refused rather than coerced',
    badIntegrity.status === 2 && badIntegrity.stderr.includes('--artifact-integrity'),
    badIntegrity.stderr.trim().slice(0, 140),
  );

  // Historical compatibility: a ledger written before Durable-state behavior has neither new field and must still be usable.
  writeContract(
    harnessHome,
    'P6H',
    sourceCommit,
    ['a criterion'],
    [{ id: 'h1', criterion: 1, kind: 'file_exists', path: 'src/app.ts' }],
  );
  const historicalIds = ['ledger-P6H-historical'];
  const historicalPath = join(harnessHome, 'state/ledgers', `${historicalIds[0]}.json`);
  mkdirSync(join(harnessHome, 'state/ledgers'), { recursive: true });
  writeFileSync(
    historicalPath,
    `${JSON.stringify(
      {
        version: 1,
        run_id: historicalIds[0],
        task_id: 'P6H',
        arm: null,
        title: 'Self-test fixture',
        source_commit: sourceCommit,
        workspace: '.',
        gate: { name: 'check', compatibility: null, checked_at: null, problems: [] },
        status: 'verification_pending',
        acceptance: ['a criterion'],
        completed: [],
        pending: [],
        claims: [],
        verification: [
          {
            at: '2026-01-01T00:00:00.000Z',
            run_id: 'selftest-historical-verification',
            gate: 'check',
            command: 'npm run check',
            exit_code: 0,
            duration_ms: 1,
            mechanism: 'evaluator',
            steps: [],
          },
        ],
        failures: [],
        invalid_transitions: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
  const historicalShow = runHarness(repo, ['ledger', 'show', '--task=P6H', '--run-id=' + historicalIds[0], '--json']);
  const historicalHumanShow = runHarness(repo, ['ledger', 'show', '--task=P6H', '--run-id=' + historicalIds[0]]);
  const historicalRawLedger = JSON.parse(readFileSync(historicalPath, 'utf8'));
  const historicalEvaluate = runHarness(repo, [
    'evaluate',
    '--task=P6H',
    '--no-gate',
    '--ledger=' + historicalIds[0],
    '--run-id=selftest-historical',
    '--quiet',
  ]);
  const historicalAfter = runHarness(repo, ['ledger', 'show', '--task=P6H', '--run-id=' + historicalIds[0], '--json']);
  const historicalLedger = (() => {
    try {
      return JSON.parse(historicalAfter.stdout).ledger;
    } catch {
      return null;
    }
  })();
  // `evaluate --no-gate` exits 1 by Initial schema semantics (nothing was mechanically verified); what matters here is that the
  // old ledger neither crashes the evaluator (exit 2) nor becomes unreadable.
  check(
    'I12',
    'a historical ledger without the Durable-state behavior fields is readable and evaluable without an error exit',
    historicalShow.status === 0 &&
      historicalEvaluate.status !== 2 &&
      !historicalEvaluate.stderr.includes('error:') &&
      historicalLedger !== null,
    `show=${historicalShow.status} evaluate=${historicalEvaluate.status} stderr=${historicalEvaluate.stderr.trim().slice(0, 80)}`,
  );
  check(
    'I12',
    'reading a historical ledger does not fabricate verifier evidence or coverage',
    historicalLedger !== null &&
      (historicalLedger.verifier === null || historicalLedger.verifier === undefined) &&
      (historicalLedger.acceptance_checks === undefined || historicalLedger.acceptance_checks === null) &&
      (historicalLedger.blockers === undefined || historicalLedger.blockers.length === 0),
    JSON.stringify({
      verifier: historicalLedger?.verifier ?? null,
      acceptance_checks: historicalLedger?.acceptance_checks ?? null,
      blockers: historicalLedger?.blockers ?? null,
    }),
  );

  check(
    'I11',
    'STATE-MODEL backward compatibility: a ledger without transitions loads, displays and classifies as not recorded',
    historicalHumanShow.status === 0 &&
      historicalHumanShow.stdout.includes('status transitions (not recorded)') &&
      !Object.hasOwn(historicalRawLedger, 'transitions') &&
      historicalLedger.transitions === null &&
      classifyLedgerStatus({
        runGate: true,
        gateIncompatible: false,
        mechanicallyVerified: true,
        acceptance: 'pass',
        acceptanceCoverage: null,
        verifier: null,
        ledger: historicalRawLedger,
      }) === 'verified',
    `human=${historicalHumanShow.status} raw=${Object.hasOwn(historicalRawLedger, 'transitions')} displayed=${JSON.stringify(historicalLedger?.transitions)}`,
  );

  // ---- Criterion-boundary behavior: declared criterion boundaries and acceptance-evidence sources
  //
  // The invariant under test is the fail-closed one: a missing datum stays missing. A predicate being declared is not
  // evidence that it can witness the criterion, and a contract without the field is not "mechanically safe".
  const boundaryFixture = {
    acceptance: ['a mechanical criterion', 'a human criterion', 'an unwitnessed criterion'],
    acceptance_checks: [{ id: 'b1', criterion: 1, kind: 'present_pattern', pattern: 'x', paths: ['src'] }],
  };
  const unannotated = criterionBoundary(boundaryFixture, 2);
  check(
    'I13',
    'a criterion with no boundary entry reports null — missing is never inferred to be mechanical',
    unannotated.boundary === null && unannotated.evidence_source === null && unannotated.declared === false,
    JSON.stringify(unannotated),
  );

  const explicitMissingSource = criterionBoundary(
    { ...boundaryFixture, acceptance_boundaries: [{ criterion: 2, boundary: 'HUMAN_OR_HYBRID' }] },
    2,
  );
  check(
    'I13',
    'a declared boundary with no evidence source keeps the source unknown — missing is never inferred to be automated',
    explicitMissingSource.boundary === 'HUMAN_OR_HYBRID' &&
      explicitMissingSource.evidence_source === null &&
      explicitMissingSource.declared === true,
    JSON.stringify(explicitMissingSource),
  );

  check(
    'I13',
    'a contract without the field is valid (historical contracts keep an unknown boundary)',
    validateAcceptanceBoundaries(boundaryFixture).length === 0 &&
      JSON.stringify(boundarySummary(boundaryFixture)) ===
        JSON.stringify({
          criteria: 3,
          declared_entries: 0,
          criteria_with_a_boundary: 0,
          criteria_unknown: 3,
          automated_boundaries: 0,
          by_boundary: {},
          by_evidence_source: {},
        }),
    JSON.stringify(boundarySummary(boundaryFixture)),
  );

  const validBoundary = {
    ...boundaryFixture,
    acceptance_boundaries: [
      { criterion: 1, boundary: 'AUTOMATED_SAFE', evidence_source: 'AUTOMATED' },
      { criterion: 2, boundary: 'HUMAN_OR_HYBRID', evidence_source: 'HUMAN' },
      { criterion: 3, boundary: 'NOT_AUTOMATABLE_WITH_CURRENT_OBSERVABLES', evidence_source: 'UNAVAILABLE' },
    ],
  };
  check(
    'I13',
    'a fully annotated contract validates and summarises its boundaries',
    validateAcceptanceBoundaries(validBoundary).length === 0 &&
      boundarySummary(validBoundary).criteria_with_a_boundary === 3 &&
      boundarySummary(validBoundary).criteria_unknown === 0 &&
      boundarySummary(validBoundary).automated_boundaries === 1 &&
      boundarySummary(validBoundary).by_evidence_source.AUTOMATED === 1,
    JSON.stringify(boundarySummary(validBoundary)),
  );

  const boundaryProblem = (task) => validateAcceptanceBoundaries(task).join(' | ');
  check(
    'I13',
    'an out-of-vocabulary boundary is refused, never normalised',
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 1, boundary: 'MECHANICAL' }] }).includes(
      '"boundary" must be one of',
    ),
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 1, boundary: 'MECHANICAL' }] }),
  );
  check(
    'I13',
    'an out-of-vocabulary evidence source is refused',
    boundaryProblem({
      ...boundaryFixture,
      acceptance_boundaries: [{ criterion: 2, evidence_source: 'HIGH' }],
    }).includes('"evidence_source" must be one of'),
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 2, evidence_source: 'HIGH' }] }),
  );
  check(
    'I13',
    'an out-of-range or duplicated criterion is refused',
    boundaryProblem({
      ...boundaryFixture,
      acceptance_boundaries: [{ criterion: 9, boundary: 'HUMAN_OR_HYBRID' }],
    }).includes('must be an index into acceptance[]') &&
      boundaryProblem({
        ...boundaryFixture,
        acceptance_boundaries: [
          { criterion: 2, boundary: 'HUMAN_OR_HYBRID' },
          { criterion: 2, boundary: 'AUTOMATED_SAFE' },
        ],
      }).includes('duplicate acceptance boundary'),
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 9, boundary: 'HUMAN_OR_HYBRID' }] }),
  );
  check(
    'I13',
    'an empty entry and an unknown key are refused',
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 2 }] }).includes(
      'must declare "boundary" and/or "evidence_source"',
    ) &&
      boundaryProblem({
        ...boundaryFixture,
        acceptance_boundaries: [{ criterion: 2, boundary: 'HUMAN_OR_HYBRID', risk: 'HIGH' }],
      }).includes('unknown field(s) risk'),
    boundaryProblem({
      ...boundaryFixture,
      acceptance_boundaries: [{ criterion: 2, boundary: 'HUMAN_OR_HYBRID', risk: 'HIGH' }],
    }),
  );
  check(
    'I13',
    'AUTOMATED_SAFE with no declared witness is refused, while AUTOMATED_PENDING_VALIDATION is allowed without one',
    boundaryProblem({
      ...boundaryFixture,
      acceptance_boundaries: [{ criterion: 3, boundary: 'AUTOMATED_SAFE' }],
    }).includes('claims a mechanical witness but no acceptance check is declared') &&
      validateAcceptanceBoundaries({
        ...boundaryFixture,
        acceptance_boundaries: [{ criterion: 3, boundary: 'AUTOMATED_PENDING_VALIDATION' }],
      }).length === 0,
    boundaryProblem({ ...boundaryFixture, acceptance_boundaries: [{ criterion: 3, boundary: 'AUTOMATED_SAFE' }] }),
  );

  // Paired perturbation: the boundary data must not move a Durable-state behavior verdict or a Recorded-block persistence status. The
  // execution and classification inputs are identical; acceptance_boundaries is the only difference.
  const boundaryWithout = { ...validBoundary };
  delete boundaryWithout.acceptance_boundaries;
  const executeBoundaryPerturbation = (task) => {
    const { acceptance } = runAcceptanceChecks(task, { workspace: repo, sourceCommit });
    return {
      acceptance,
      status: classifyLedgerStatus({
        runGate: true,
        gateIncompatible: false,
        mechanicallyVerified: true,
        acceptance: acceptance.verdict,
        acceptanceCoverage: acceptance,
        verifier: { verdict: 'PASS', artifact_integrity: 'UNCHANGED' },
        ledger: { status: 'in_progress', pending: [], blockers: [] },
      }),
    };
  };
  const withoutAnnotation = executeBoundaryPerturbation(boundaryWithout);
  const withAnnotation = executeBoundaryPerturbation(validBoundary);
  check(
    'I13',
    'case 11 paired perturbation: boundary annotations do not change acceptance or ledger classification',
    JSON.stringify(withAnnotation) === JSON.stringify(withoutAnnotation),
    `without=${JSON.stringify(withoutAnnotation)} with=${JSON.stringify(withAnnotation)}`,
  );

  // ---- Threshold validation: the predicate validation gate must reject, and must mark non-discriminating
  const adversarialHome = join(repo, '.harness-p61a');

  writeContract(
    adversarialHome,
    'P61A',
    sourceCommit,
    ['the removed API leaves no code reference'],
    [
      { id: 'a1-comment-sensitive', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks', paths: ['src'] },
      {
        id: 'a2-comment-excluded',
        criterion: 1,
        kind: 'absent_pattern',
        pattern: 'searchTasks',
        paths: ['src'],
        exclude_comments: true,
      },
      { id: 'a3-wrong-scope', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks', paths: ['other'] },
      { id: 'a4-always-true', criterion: 1, kind: 'present_pattern', pattern: 'searchTasks', paths: ['src'] },
      {
        id: 'a5-bad-rev',
        criterion: 1,
        kind: 'absent_pattern',
        pattern: 'searchTasks',
        paths: ['src'],
        rev: 'deadbeef',
      },
    ],
  );

  const adversarialContractPath = join(adversarialHome, 'state/tasks', 'P61A.json');
  const adversarialContract = JSON.parse(readFileSync(adversarialContractPath, 'utf8'));

  adversarialContract.history = { evidence: `git show ${solvingCommit} --stat` };
  writeFileSync(adversarialContractPath, `${JSON.stringify(adversarialContract, null, 2)}\n`);
  writeFileSync(join(repo, 'src', 'app.ts'), 'export function listTasks() {}\n// searchTasks was removed here\n');

  const adversarial = runHarness(repo, ['predicates', '--validate', '--json'], adversarialHome);
  const adversarialRows = (() => {
    try {
      return JSON.parse(adversarial.stdout).rows;
    } catch {
      return [];
    }
  })();
  const statusOf = (id) => adversarialRows.find((row) => row.check === id)?.status ?? 'MISSING';

  check(
    'I6',
    'a comment-sensitive predicate is NON_DISCRIMINATING, not blindly trusted',
    statusOf('a1-comment-sensitive') === 'NON_DISCRIMINATING',
    statusOf('a1-comment-sensitive'),
  );
  check(
    'I6',
    'the same predicate with exclude_comments discriminates (source fails, solving passes)',
    statusOf('a2-comment-excluded') === 'VALIDATED',
    statusOf('a2-comment-excluded'),
  );
  check(
    'I6',
    'a predicate scoped away from the work already passes at source, so it is REJECTED',
    statusOf('a3-wrong-scope') === 'REJECTED',
    statusOf('a3-wrong-scope'),
  );
  check(
    'I6',
    'an always-true predicate is REJECTED because it already passes at the source commit',
    statusOf('a4-always-true') === 'REJECTED',
    statusOf('a4-always-true'),
  );
  check(
    'I6',
    'a predicate pinning its own revision is reported UNVALIDATED, never silently re-pointed',
    statusOf('a5-bad-rev') === 'UNVALIDATED',
    statusOf('a5-bad-rev'),
  );
  check(
    'I6',
    'the validation command exits non-zero when any predicate is rejected or undecided',
    adversarial.status !== 0,
    `exit=${adversarial.status}`,
  );

  const broadWarnings = predicateWarnings({ id: 'w1', kind: 'absent_pattern', pattern: 'task', paths: ['src'] });
  check(
    'I6',
    'a short bare-word pattern raises a broad-match warning',
    broadWarnings.some((warning) => warning.includes('broad-match')),
    broadWarnings.join(' | '),
  );
  const commentWarnings = predicateWarnings({
    id: 'w2',
    kind: 'absent_pattern',
    pattern: 'someIdentifier',
    paths: ['src'],
  });
  check(
    'I6',
    'unset comment semantics raise a warning',
    commentWarnings.some((warning) => warning.includes('comment semantics')),
    commentWarnings.join(' | '),
  );

  const forbiddenCheckout = suiteTempDir('task-board-acceptance-other-checkout-');
  const forbiddenCheckoutFixture = join(forbiddenCheckout, '.harness', 'state', 'worktrees', 'partial', 'src');
  mkdirSync(forbiddenCheckoutFixture, { recursive: true });
  const forbiddenPath = validateAcceptanceChecks({
    acceptance: ['x'],
    acceptance_checks: [
      { id: 'f1', criterion: 1, kind: 'absent_pattern', pattern: 'x', paths: [forbiddenCheckoutFixture] },
    ],
  });
  check(
    'I6',
    'a predicate scoped into another checkout or generated tree is an error',
    forbiddenPath.some((problem) => problem.includes('generated, ignored or another checkout')),
    forbiddenPath.join(' | '),
  );
  rmSync(forbiddenCheckout, { recursive: true, force: true });

  const missingParam = validateAcceptanceChecks({
    acceptance: ['x'],
    acceptance_checks: [{ id: 'f2', criterion: 1, kind: 'keyset_equal' }],
  });
  check(
    'I6',
    'a structural predicate missing its parameter is an error',
    missingParam.length > 0,
    missingParam.join(' | '),
  );

  // ---- S2: contained paths, external exports, descriptors, and ledger publication
  const s2Root = join(root, 's2');
  const s2Control = join(s2Root, 'control');
  const s2External = suiteTempDir('task-board-s2-export-');
  const s2Io = { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync };
  mkdirSync(s2Control, { recursive: true });

  check(
    'S2',
    'PATH-bounded-run-and-ledger-grammar accepts local tokens and refuses traversal, absolute, and overlong ids',
    s2.runToken('run.valid_1-2') &&
      !s2.runToken('../escape') &&
      !s2.runToken('/tmp/escape') &&
      !s2.runToken(`r${'x'.repeat(120)}`),
    'bounded local-token grammar',
  );
  check(
    'S2',
    'PATH-contained-control-publication resolves only directly beneath the fixed root',
    s2.resolveControlPath(s2Control, 'record.jsonl') === join(s2Control, 'record.jsonl'),
    s2Control,
  );
  const s2TraversalRun = runHarness(repo, ['evaluate', '--task=P6T', '--no-gate', '--run-id=../escape', '--quiet']);
  const s2AbsoluteLedgerTarget = join(tmpdir(), `task-board-s2-absolute-escape-${process.pid}.json`);
  const s2TraversalLedger = runHarness(repo, ['ledger', 'init', '--task=P6T', `--run-id=${s2AbsoluteLedgerTarget}`]);
  check(
    'S2',
    'PATH-run-and-ledger-identifiers-refuse-traversal-and-absolute-escapes-before-publication',
    s2TraversalRun.status === 2 &&
      s2TraversalLedger.status === 2 &&
      !existsSync(join(harnessHome, 'escape.jsonl')) &&
      !existsSync(s2AbsoluteLedgerTarget),
  );

  const s2SymlinkParent = join(s2Root, 'symlink-parent');
  const s2SymlinkTarget = join(s2Root, 'real-parent');
  mkdirSync(s2SymlinkTarget, { recursive: true });
  symlinkSync(s2SymlinkTarget, s2SymlinkParent);
  let s2SymlinkRefused = false;
  try {
    s2.resolveExternalOutputPath(join(s2SymlinkParent, 'export.json'));
  } catch {
    s2SymlinkRefused = true;
  }
  check('S2', 'EXPORT-symlink-parent-refused', s2SymlinkRefused);

  const s2ExternalTarget = join(s2External, 'new-report.json');
  s2.writeNewFileExclusive(s2.resolveExternalOutputPath(s2ExternalTarget), '{}\n');
  check('S2', 'EXPORT-absolute-new-target-succeeds', readFileSync(s2ExternalTarget, 'utf8') === '{}\n');

  let s2RelativeRefused = false;
  try {
    s2.resolveExternalOutputPath('../relative.json');
  } catch {
    s2RelativeRefused = true;
  }
  check('S2', 'EXPORT-relative-out-refused', s2RelativeRefused);

  let s2MissingParentRefused = false;
  try {
    s2.resolveExternalOutputPath(join(s2External, 'missing', 'export.json'));
  } catch {
    s2MissingParentRefused = true;
  }
  check('S2', 'EXPORT-missing-parent-refused', s2MissingParentRefused);

  let s2ExistingRefused = false;
  try {
    s2.resolveExternalOutputPath(s2ExternalTarget);
  } catch {
    s2ExistingRefused = true;
  }
  check(
    'S2',
    'EXPORT-existing-target-preserved-and-refused',
    s2ExistingRefused && readFileSync(s2ExternalTarget, 'utf8') === '{}\n',
  );

  const s2RunPath = join(s2Control, 'writer.jsonl');
  const s2Writer = s2.createWriter(s2RunPath, s2Io);
  s2Writer.emit('run_started', { run_id: 'writer' });
  s2Writer.close();
  const s2RunEvents = readFileSync(s2RunPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  check(
    'S2',
    'WRITE-run-descriptor-close-success',
    s2Writer.state === 'closed' && s2RunEvents.length === 1 && s2RunEvents[0].event === 'run_started',
  );

  const s2FaultPath = join(s2Control, 'fault.jsonl');
  let s2CloseCalls = 0;
  const s2FaultIo = {
    ...s2Io,
    openSync: (path, flags) => s2Io.openSync(path, flags),
    writeSync: () => {
      throw new Error('injected write failure');
    },
    closeSync: (fd) => {
      s2CloseCalls += 1;
      s2Io.closeSync(fd);
    },
  };
  const s2FaultWriter = s2.createWriter(s2FaultPath, s2FaultIo);
  let s2FirstWriteFailed = false;
  let s2PostFailureRefused = false;
  try {
    s2FaultWriter.emit('run_started', {});
  } catch {
    s2FirstWriteFailed = true;
  }
  try {
    s2FaultWriter.emit('run_started', {});
  } catch (error) {
    s2PostFailureRefused = error.code === 'WRITER_FAILED';
  }
  check(
    'S2',
    'WRITE-run-descriptor-first-failure-closes-once-and-blocks-later-emit',
    s2FirstWriteFailed && s2PostFailureRefused && s2FaultWriter.state === 'failed' && s2CloseCalls === 1,
  );

  const s2GatePath = join(s2Control, 'writer.gate.log');
  const s2GateWriter = s2.createGateLogWriter(s2GatePath, s2Io);
  const s2ExpectedSteps = [{ step: 'lint', command: 'npm run lint' }];
  s2GateWriter.emitBlock(1, 'lint', 'npm run lint', 'output\n');
  s2GateWriter.close();
  const s2GateText = readFileSync(s2GatePath, 'utf8');
  check(
    'S2',
    'WRITE-gate-log-begin-end-full-buffer',
    s2GateWriter.state === 'closed' && s2.classifyGateLog(s2GateText, s2ExpectedSteps).valid,
  );
  check(
    'S2',
    'GATE-LOG-empty-partial-and-mismatched-are-invalid',
    s2.classifyGateLog('', s2ExpectedSteps).reason === 'empty' &&
      s2.classifyGateLog(s2GateText.slice(0, -3), s2ExpectedSteps).reason.startsWith('partial_block') &&
      s2
        .classifyGateLog(s2GateText.replace('npm run lint', 'npm run typecheck'), s2ExpectedSteps)
        .reason.startsWith('order_or_command_mismatch'),
  );

  const s2LedgerId = 's2-ledger';
  const s2LedgerPath = join(harnessHome, 'state/ledgers', `${s2LedgerId}.json`);
  const s2LedgerInit = runHarness(repo, ['ledger', 'init', '--task=P6T', `--run-id=${s2LedgerId}`]);
  const s2Initialized = JSON.parse(readFileSync(s2LedgerPath, 'utf8'));
  check(
    'S2',
    'WRITE-ledger-initialization-is-exclusive-fsynced-and-closed',
    s2LedgerInit.status === 0 && s2Initialized.run_id === s2LedgerId,
  );
  const s2LedgerInitRetry = runHarness(repo, ['ledger', 'init', '--task=P6T', `--run-id=${s2LedgerId}`]);
  check('S2', 'WRITE-ledger-initialization-retry-is-refused', s2LedgerInitRetry.status === 2);

  const s2LedgerMutation = runHarness(repo, [
    'ledger',
    'set',
    '--task=P6T',
    `--run-id=${s2LedgerId}`,
    '--status=in_progress',
  ]);
  const s2Mutated = JSON.parse(readFileSync(s2LedgerPath, 'utf8'));
  check(
    'S2',
    'WRITE-ledger-mutation-atomically-replaces-the-final-path',
    s2LedgerMutation.status === 0 &&
      s2Mutated.status === 'in_progress' &&
      !readdirSync(join(harnessHome, 'state/ledgers')).some((name) => name.endsWith('.tmp')),
  );

  const s2DanglingRun = join(s2Control, 'dangling.jsonl');
  const s2DanglingTarget = join(s2Control, 'dangling-target.jsonl');
  symlinkSync(s2DanglingTarget, s2DanglingRun);
  let s2DanglingRefused = false;
  try {
    s2.createWriter(s2DanglingRun, s2Io);
  } catch (error) {
    s2DanglingRefused = error.code === 'RUN_WRITER_FAILED';
  }
  check(
    'S2',
    'RUN-exclusive-writer-refuses-dangling-final-symlink-without-following-it',
    s2DanglingRefused && !existsSync(s2DanglingTarget) && lstatSync(s2DanglingRun).isSymbolicLink(),
  );

  const s2DefaultReport = runHarness(repo, ['report']);
  const s2DefaultReportPath = s2DefaultReport.stdout.match(/written:\s+(.+)/)?.[1]?.trim() ?? '';
  check(
    'S2',
    'DEFAULT-report-is-a-new-contained-timestamped-target',
    s2DefaultReport.status === 0 &&
      s2DefaultReportPath.startsWith('.harness/state/reports/report-') &&
      existsSync(join(repo, s2DefaultReportPath)),
  );

  const s2DefaultTelemetryRun = runHarness(repo, ['telemetry', `--store=${join(root, 'telemetry-store')}`, '--scan']);
  const s2DefaultTelemetryPath = s2DefaultTelemetryRun.stdout.match(/written:\s+(.+)/)?.[1]?.trim() ?? '';
  check(
    'S2',
    'DEFAULT-telemetry-is-a-new-contained-timestamped-target',
    s2DefaultTelemetryRun.status === 0 &&
      s2DefaultTelemetryPath.startsWith('.harness/state/telemetry/scan-') &&
      existsSync(join(repo, s2DefaultTelemetryPath)),
  );

  const s2ExternalCli = join(s2External, 'cli-report.json');
  const s2ExternalCliRun = runHarness(repo, ['report', `--out=${s2ExternalCli}`]);
  check(
    'S2',
    'EXPORT-external-report-new-absolute-target-works',
    s2ExternalCliRun.status === 0 &&
      existsSync(s2ExternalCli) &&
      JSON.parse(readFileSync(s2ExternalCli)).schema_version !== 2,
  );

  const s2ExternalTelemetry = join(s2External, 'cli-telemetry.json');
  const s2ExternalTelemetryRun = runHarness(repo, [
    'telemetry',
    `--store=${join(root, 'telemetry-store')}`,
    '--scan',
    `--out=${s2ExternalTelemetry}`,
  ]);
  check(
    'S2',
    'EXPORT-external-telemetry-new-absolute-target-works',
    s2ExternalTelemetryRun.status === 0 && existsSync(s2ExternalTelemetry),
  );

  rmSync(s2External, { recursive: true, force: true });

  // ---- S3: strict operational parsing, identity, compound inventory, and non-causal forensic access
  const s3Root = join(root, 's3');
  const s3LedgerDir = join(s3Root, 'control', 'state', 'ledgers');
  const s3RunDir = join(s3Root, 'control', 'state', 'runs');
  mkdirSync(s3LedgerDir, { recursive: true });
  mkdirSync(s3RunDir, { recursive: true });
  writeContract(join(s3Root, 'control'), 'S3T', sourceCommit, ['criterion one']);
  const s3Base = (id, taskId = 'S3T') => ({
    version: 1,
    run_id: id,
    task_id: taskId,
    title: 'strict ledger fixture',
    source_commit: sourceCommit,
    workspace: '.',
    gate: { name: 'benchmark', compatibility: null, checked_at: null, problems: [] },
    status: 'pending',
    acceptance: ['criterion one'],
    completed: [],
    pending: [],
    claims: [],
    verification: [],
    failures: [],
    invalid_transitions: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const s3Put = (id, value) => {
    const path = join(s3LedgerDir, `${id}.json`);
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`;
    writeFileSync(path, bytes);
    return path;
  };
  const s3Run = (args) => runHarness(s3Root, args, join(s3Root, 'control'));

  check(
    'S3',
    'STRICT-parser-enforces-byte-depth-utf8-json-duplicate-and-root-classes',
    s2.parseStrictJson(Buffer.alloc(1_048_577)).code === 'LEDGER_TOO_LARGE' &&
      s2.parseStrictJson(Buffer.from([0xff])).code === 'LEDGER_INVALID_UTF8' &&
      s2.parseStrictJson('{bad').code === 'LEDGER_INVALID_JSON' &&
      s2.parseStrictJson('{"x":1,"x":2}').code === 'LEDGER_DUPLICATE_KEY' &&
      s2.parseStrictJson(`{"x":${'['.repeat(33)}${']'.repeat(33)}}`).code === 'LEDGER_TOO_DEEP' &&
      s2.parseStrictJson('[]').code === 'LEDGER_NOT_OBJECT',
  );
  const s3DeepResult = s2.parseStrictJson(`{"deep":${'['.repeat(10_000)}${']'.repeat(10_000)}}`);
  check(
    'S8',
    'STRICT-deep-nesting-returns-bounded-diagnostic',
    s3DeepResult.ok === false && s3DeepResult.code === 'LEDGER_TOO_DEEP' && s3DeepResult.detail === '33 exceeds 32',
  );

  const s3Unknown = s3Base('s3-valid', 'S3T');
  s3Unknown.unknown_sibling = { retained: true };
  s3Put('s3-valid', s3Unknown);
  const s3NullTelemetry = { ...s3Unknown, telemetry: null };
  check(
    'S8',
    'STRICT-null-telemetry-returns-shape-diagnostic',
    s2.validateOperationalLedger(s3NullTelemetry).includes('$.telemetry must be an object'),
  );
  check(
    'S3',
    'STRICT-unknown-keys-are-tolerated-and-not-interpreted',
    s2.validateOperationalLedger(s3Unknown).length === 0,
  );
  const s3ShapeCases = [
    ['missing-field', (ledger) => delete ledger.status],
    [
      'wrong-type',
      (ledger) => {
        ledger.verification = {};
      },
    ],
    [
      'bad-enum',
      (ledger) => {
        ledger.status = 'unknown-status';
      },
    ],
    [
      'out-of-bounds',
      (ledger) => {
        ledger.acceptance_coverage = 2;
      },
    ],
    [
      'bad-timestamp',
      (ledger) => {
        ledger.updated_at = '2026-02-30T00:00:00Z';
      },
    ],
  ];
  check(
    'S3',
    'STRICT-schema-refuses-missing-wrong-enum-bound-and-timestamp-classes',
    s3ShapeCases.every(([, mutate]) => {
      const ledger = s3Base('s3-shape');
      mutate(ledger);
      return s2.validateOperationalLedger(ledger).length > 0;
    }),
  );

  const s3RejectedShape = s3Base('s3-reject');
  s3RejectedShape.status = 7;
  s3Put('s3-reject', s3RejectedShape);
  const s3Mismatch = s3Base('s3-mismatch', 'S3T');
  s3Mismatch.run_id = 'embedded-other';
  s3Mismatch.status = 7;
  s3Mismatch.updated_at = '2099-01-01T00:00:00.000Z';
  const s3MismatchPath = s3Put('s3-mismatch', s3Mismatch);
  const s3Oversize = s3Base('s3-oversize');
  s3Oversize.padding = 'x'.repeat(1_048_577);
  s3Put('s3-oversize', s3Oversize);
  const s3Deep = s3Base('s3-deep');
  s3Deep.deep = JSON.parse(`{"x":${'['.repeat(33)}${']'.repeat(33)}}`);
  s3Put('s3-deep', s3Deep);
  const s3Inventory = s2.inspectLedgerInventory(s3LedgerDir);
  const s3Class = (id) => s3Inventory.find((entry) => entry.run_id === id);
  check(
    'S3',
    'STRICT-report-inventory-precedence',
    s3Class('s3-reject')?.classification === 'rejected' &&
      s3Class('s3-mismatch')?.classification === 'forensic_only' &&
      s3Class('s3-valid')?.classification === 'operational_valid' &&
      s3Class('s3-oversize')?.code === 'LEDGER_TOO_LARGE' &&
      s3Class('s3-deep')?.code === 'LEDGER_TOO_DEEP',
    JSON.stringify(s3Inventory.map(({ run_id, classification, code }) => [run_id, classification, code])),
  );
  const s3ReportOut = join(s3Root, 'report.json');
  const s3ReportRun = s3Run(['report', `--out=${s3ReportOut}`]);
  const s3Report = JSON.parse(readFileSync(s3ReportOut));
  check(
    'S3',
    'STRICT-report-keeps-rejected-and-forensic-inventory-without-state-quality',
    s3ReportRun.status === 0 &&
      s3Report.ledger_inventory.some((entry) => entry.classification === 'forensic_only') &&
      s3Report.ledger_inventory.some((entry) => entry.classification === 'rejected') &&
      s3Report.ledger_state_quality.every((entry) => entry.run_id !== 's3-mismatch'),
  );

  const s3BytesBefore = readFileSync(s3MismatchPath);
  const s3Json = s3Run(['ledger', 'forensic', '--run-id=s3-mismatch', '--json']);
  const s3JsonValue = JSON.parse(s3Json.stdout);
  const s3Raw = s3Run(['ledger', 'forensic', '--run-id=s3-mismatch', '--raw']);
  check(
    'S3',
    'FORENSIC-json-and-raw-are-byte-preserving-and-non-causal',
    s3Json.status === 0 &&
      s3JsonValue.mode === 'forensic_observation' &&
      s3JsonValue.causal === false &&
      ['ledger_status', 'status', 'operational_suitability', 'terminal', 'verified'].every(
        (key) => !Object.hasOwn(s3JsonValue, key),
      ) &&
      s3Raw.status === 0 &&
      Buffer.from(s3Raw.stdout).equals(s3BytesBefore) &&
      readFileSync(s3MismatchPath).equals(s3BytesBefore),
  );
  const s3DefaultShow = s3Run(['ledger', 'show', '--task=S3T', '--json']);
  check(
    'S3',
    'STRICT-default-selection-excludes-forensic-and-rejected-and-breaks-ties-by-run-id',
    s3DefaultShow.status === 0 && JSON.parse(s3DefaultShow.stdout).ledger.run_id === 's3-valid',
    s3DefaultShow.stdout.trim().slice(0, 160),
  );
  const s3Attach = s3Run([
    'evaluate',
    '--task=S3T',
    '--workspace=.',
    '--no-gate',
    '--run-id=s3-refused',
    '--ledger=s3-mismatch',
  ]);
  const s3Set = s3Run(['ledger', 'set', '--task=S3T', '--run-id=s3-mismatch', '--status=in_progress']);
  check(
    'S3',
    'FORENSIC-mismatch-cannot-attach-mutate-or-select-terminal-state',
    s3Attach.status === 2 &&
      s3Set.status === 2 &&
      !existsSync(join(s3RunDir, 's3-refused.jsonl')) &&
      readFileSync(s3MismatchPath).equals(s3BytesBefore),
  );
  check(
    'S3',
    'FORENSIC-dispatch-forbids-task-and-does-not-call-state-quality-or-mutator',
    s3Run(['ledger', 'forensic', '--run-id=s3-valid', '--task=S3T']).status === 2,
  );

  const s3CapRoot = join(root, 's3-cap');
  mkdirSync(join(s3CapRoot, 'state/ledgers'), { recursive: true });
  writeFileSync(join(s3CapRoot, 'tasks-placeholder'), '');
  const s3Cap16 = join(s3CapRoot, 'state/ledgers', 's3-cap-16.json');
  const s3Cap17 = join(s3CapRoot, 'state/ledgers', 's3-cap-17.json');
  writeFileSync(s3Cap16, Buffer.alloc(16_777_216, 0x61));
  writeFileSync(s3Cap17, Buffer.alloc(16_777_217, 0x61));
  const s3Cap16Output = join(s3CapRoot, 'cap-16.raw');
  const s3Cap16Fd = openSync(s3Cap16Output, 'wx');
  const s3Cap16Run = spawnSync(
    process.execPath,
    [join(RUNTIME_DIR, 'harness.mjs'), 'ledger', 'forensic', '--run-id=s3-cap-16', '--raw'],
    {
      stdio: ['ignore', s3Cap16Fd, 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: s3CapRoot },
    },
  );
  closeSync(s3Cap16Fd);
  const s3Cap17Run = runHarness(s3CapRoot, ['ledger', 'forensic', '--run-id=s3-cap-17', '--raw'], s3CapRoot);
  check(
    'S3',
    'FORENSIC-cap-boundaries',
    s3Cap16Run.status === 0 &&
      lstatSync(s3Cap16Output).size === 16_777_216 &&
      readFileSync(s3Cap16Output).equals(readFileSync(s3Cap16)) &&
      s3Cap17Run.status === 2 &&
      s3Cap17Run.stdout === '' &&
      s3Cap17Run.stderr === 'error: FORENSIC_INPUT_TOO_LARGE: forensic input exceeds 16777216 bytes\n',
    `16=${s3Cap16Run.status}/${lstatSync(s3Cap16Output).size}/${s3Cap16Run.stderr?.length} 17=${s3Cap17Run.status}/${s3Cap17Run.stdout.length}/${JSON.stringify(s3Cap17Run.stderr)}`,
  );

  const s3ValidCorpusCases = [
    ['compatibility-observation', 'verification_pending'],
    ['treatment-pending', 'verification_pending'],
    ['resumed-verification', 'verification_pending'],
    ['treatment-complete', 'verified'],
    ['ab-treatment-pending', 'verification_pending'],
    ['failed-verification', 'failed'],
    ['partial-work', 'in_progress'],
    ['unstarted-work', 'pending'],
    ['coverage-blocked', 'blocked'],
    ['treatment-failure', 'failed'],
    ['user-work-pending', 'verification_pending'],
    ['recovery-pending', 'verification_pending'],
    ['workspace-prepared', 'in_progress'],
    ['policy-enforcement-pending', 'verification_pending'],
    ['acceptance-reviewed', 'verified'],
    ['telemetry-collected', 'in_progress'],
  ];
  const s3ValidCorpus = s3ValidCorpusCases.map(([behavior, status], index) => {
    const id = `s3-valid-${index + 1}`;
    const raw = `${JSON.stringify({ ...s3Base(id), status })}\n`;
    s3Put(id, raw);
    return { behavior, raw };
  });
  check(
    'S3',
    'LEDGER-generated-valid-corpus-preserves-sixteen-behavior-cases',
    s3ValidCorpus.length === 16 &&
      s3ValidCorpus.every(({ behavior, raw }) => {
        const parsed = s2.parseStrictJson(raw);
        return (
          behavior.length > 0 && parsed.ok && s2.validateOperationalLedger(parsed.value).length === 0
        );
      }),
  );
  const s3MismatchCases = [
    ['s3-mismatch-workspace', 's3-embedded-workspace'],
    ['s3-mismatch-user', 's3-embedded-user'],
    ['s3-mismatch-compatibility', 's3-embedded-compatibility'],
  ];
  const s3MismatchedRaw = s3MismatchCases.map(([filenameId, embeddedId]) => {
    const path = s3Put(filenameId, `${JSON.stringify({ ...s3Base(embeddedId) })}\n`);
    return { path, result: s3Run(['ledger', 'forensic', `--run-id=${filenameId}`, '--raw']) };
  });
  check(
    'S3',
    'LEDGER-generated-filename-mismatch-forensic-round-trips-exactly',
    s3MismatchedRaw.length === 3 &&
      s3MismatchedRaw.every(({ path, result }) =>
        result.status === 0 && Buffer.from(result.stdout).equals(readFileSync(path)),
      ),
  );

  // ---- S5: report populations, terminal-only denominators, and explicit historical unknowns
  const s5Started = (id, gate = 'benchmark') => ({
    event: 'run_started',
    run_id: id,
    task_id: 'S5T',
    gate,
  });
  const s5Finished = (id, gate, exitCode, verified, overrides = {}) => ({
    event: 'run_finished',
    run_id: id,
    task_id: 'S5T',
    gate,
    gate_exit_code: exitCode,
    mechanically_verified: verified,
    self_test: false,
    agent_claimed_done: false,
    acceptance_verified: false,
    duration_ms: 1,
    ...overrides,
  });
  const s5Record = (id, started, finished, gateClassification = { valid: true }, structuralValid = true) => ({
    runId: id,
    started,
    finished,
    gateClassification,
    structuralValid,
  });
  const s5Terminal = s5Record(
    's5-unit-terminal',
    s5Started('s5-unit-terminal'),
    s5Finished('s5-unit-terminal', 'benchmark', 0, true),
  );
  const s5NoGate = s5Record(
    's5-unit-no-gate',
    s5Started('s5-unit-no-gate', null),
    s5Finished('s5-unit-no-gate', null, null, false),
  );
  const s5Vocabulary = new Set([
    'terminal_evaluation',
    'no_gate_observation',
    'self_test',
    'gate_incompatible',
    'unfinished',
    'invalid_run_stream',
  ]);
  check(
    'S5',
    'REPORT-population-exact-six-value-vocabulary',
    [...s5Vocabulary].every((value) =>
      [
        s5Terminal,
        s5NoGate,
        s5Record(
          's5-unit-self',
          s5Started('s5-unit-self'),
          s5Finished('s5-unit-self', 'benchmark', 0, true, {
            self_test: true,
            gate: 'different-gate',
          }),
          { valid: true },
        ),
        s5Record(
          's5-unit-incompatible',
          s5Started('s5-unit-incompatible'),
          s5Finished('s5-unit-incompatible', 'benchmark', 0, false, { gate_incompatible: true }),
        ),
        s5Record('s5-unit-unfinished', s5Started('s5-unit-unfinished'), null),
        s5Record('s5-unit-invalid', s5Started('s5-unit-invalid'), null, { valid: true }, false),
      ].some((record) => s2.classifyReportPopulation(record) === value),
    ) && s5Vocabulary.size === 6,
  );
  check(
    'S5',
    'REPORT-terminal-gate-bearing-classification',
    s2.classifyReportPopulation(s5Terminal) === 'terminal_evaluation',
  );
  check(
    'S8',
    'REPORT-terminal-failure-not-demoted-by-self-test-claim',
    s2.classifyReportPopulation(
      s5Record(
        's5-unit-failed-self-claim',
        s5Started('s5-unit-failed-self-claim'),
        s5Finished('s5-unit-failed-self-claim', 'benchmark', 1, false, {
          self_test: true,
          failure_category: 'gate_failed',
        }),
      ),
    ) === 'terminal_evaluation',
  );
  check(
    'S5',
    'REPORT-no-gate-exact-fields-classification',
    s2.classifyReportPopulation(s5NoGate) === 'no_gate_observation',
  );
  check(
    'S5',
    'REPORT-unfinished-valid-stream-without-finish',
    s2.classifyReportPopulation(s5Record('s5-unit-unfinished', s5Started('s5-unit-unfinished'), null)) === 'unfinished',
  );
  check(
    'S5',
    'REPORT-malformed-or-duplicate-structure-is-invalid',
    s2.classifyReportPopulation(
      s5Record('s5-unit-invalid', s5Started('s5-unit-invalid'), null, { valid: true }, false),
    ) === 'invalid_run_stream',
  );
  check(
    'S5',
    'REPORT-missing-no-gate-fields-are-invalid-not-inferred',
    s2.classifyReportPopulation(
      s5Record('s5-unit-missing', s5Started('s5-unit-missing', null), {
        event: 'run_finished',
        run_id: 's5-unit-missing',
        task_id: 'S5T',
        duration_ms: 1,
      }),
    ) === 'invalid_run_stream',
  );
  check(
    'S5',
    'REPORT-contradictory-no-gate-fields-are-invalid',
    s2.classifyReportPopulation(
      s5Record(
        's5-unit-contradictory',
        s5Started('s5-unit-contradictory', null),
        s5Finished('s5-unit-contradictory', null, 0, false),
      ),
    ) === 'invalid_run_stream',
  );
  check(
    'S5',
    'REPORT-partial-gate-log-invalidates-gate-bearing-run',
    s2.classifyReportPopulation(
      s5Record(
        's5-unit-partial-gate',
        s5Started('s5-unit-partial-gate'),
        s5Finished('s5-unit-partial-gate', 'benchmark', 0, true, { steps: [] }),
        { valid: false, reason: 'partial_block:1' },
      ),
    ) === 'invalid_run_stream',
  );
  check(
    'S5',
    'REPORT-unexpected-gate-log-invalidates-no-gate-run',
    s2.classifyReportPopulation(
      s5Record(
        's5-unit-unexpected-gate-log',
        s5Started('s5-unit-unexpected-gate-log', null),
        s5Finished('s5-unit-unexpected-gate-log', null, null, false),
        { valid: false, reason: 'unexpected_gate_log' },
      ),
    ) === 'invalid_run_stream',
  );
  check(
    'S5',
    'REPORT-unlabelled-historical-record-is-invalid-and-uninterpreted-not-relabelled',
    s2.classifyReportPopulation(
      s5Record('s5-unit-unlabelled', s5Started('s5-unit-unlabelled'), {
        event: 'run_finished',
        run_id: 's5-unit-unlabelled',
        task_id: 'S5T',
        duration_ms: 1,
      }),
    ) === 'invalid_run_stream',
  );

  const s5WriteRun = (control, id, lines) => {
    const path = join(control, 'state/runs', `${id}.jsonl`);
    const bytes = `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
    writeFileSync(path, bytes);
    return { path, bytes: Buffer.from(bytes) };
  };
  const s5GateBlock =
    '=== gate-step 1 :: benchmark-suite :: npm test ===\noutput\n=== end gate-step 1 :: benchmark-suite :: npm test ===\n';
  const s5ReportRoot = join(root, 's5-three');
  const s5Control = join(s5ReportRoot, 'control');
  mkdirSync(join(s5Control, 'state/runs'), { recursive: true });
  mkdirSync(join(s5Control, 'state/ledgers'), { recursive: true });
  mkdirSync(join(s5Control, 'state/reports'), { recursive: true });
  const s5Step = { step: 'benchmark-suite', command: 'npm test', exit_code: 0, duration_ms: 1 };
  const s5TerminalRun = s5WriteRun(s5Control, 'terminal', [
    s5Started('terminal'),
    s5Finished('terminal', 'benchmark', 0, true, {
      steps: [s5Step],
      agent_claimed_done: true,
      acceptance_verified: true,
      failure_category: null,
      runtime_metrics: { turns: 3 },
      telemetry: {
        schema_version: 2,
        status: 'unavailable',
        reason: 'fixture',
        observed: null,
        derived: null,
        unavailable_metrics: {},
      },
    }),
  ]);
  writeFileSync(join(s5Control, 'state/runs', 'terminal.gate.log'), s5GateBlock);
  const s5OrdinaryRun = s5WriteRun(s5Control, 'ordinary', [
    s5Started('ordinary', null),
    s5Finished('ordinary', null, null, false, {
      agent_claimed_done: true,
      false_done: true,
      acceptance_verified: true,
    }),
  ]);
  const s5AdverseRun = s5WriteRun(s5Control, 'adverse', [
    s5Started('adverse', null),
    s5Finished('adverse', null, null, false, {
      verifier: { verdict: 'FAIL', artifact_integrity: 'UNCHANGED' },
    }),
  ]);
  const s5ReportOut = join(s5ReportRoot, 'report.json');
  const s5ReportRun = runHarness(s5ReportRoot, ['report', `--out=${s5ReportOut}`], s5Control);
  const s5Report = JSON.parse(readFileSync(s5ReportOut));
  check(
    'S5',
    'REPORT-three-run-populations-exact-counts',
    s5ReportRun.status === 0 &&
      s5Report.runs_total === 3 &&
      s5Report.runs_finished === 3 &&
      s5Report.terminal_evaluations === 1 &&
      s5Report.no_gate_observations === 2 &&
      s5Report.adverse_no_gate_observations === 1,
    JSON.stringify({
      total: s5Report.runs_total,
      finished: s5Report.runs_finished,
      terminal: s5Report.terminal_evaluations,
      noGate: s5Report.no_gate_observations,
      adverse: s5Report.adverse_no_gate_observations,
    }),
  );
  check(
    'S5',
    'REPORT-terminal-only-success-and-false-done-denominators',
    s5Report.verification_success_rate === 1 && s5Report.false_done_rate === 0 && s5Report.mechanically_verified === 1,
  );
  check(
    'S5',
    'REPORT-per-task-populations-and-terminal-runs-denominator',
    s5Report.per_task.length === 1 &&
      s5Report.per_task[0].runs === 1 &&
      s5Report.per_task[0].terminal_evaluations === 1 &&
      s5Report.per_task[0].no_gate_observations === 2 &&
      s5Report.per_task[0].adverse_no_gate_observations === 1,
  );
  check(
    'S5',
    'REPORT-telemetry-uses-terminal-population-only',
    s5Report.telemetry.schema_2_records_enumerated === 1 && s5Report.telemetry.schema_2_unavailable === 1,
  );
  const s8MetricCounts = {
    records_enumerated: 1,
    values_observed: 0,
    values_source_null: 0,
    values_not_recorded: 1,
    values_invalid: 0,
  };
  const s8Metric = { total: null, mean: null, max: null, source_metric_counts: s8MetricCounts };
  const s8ObservedMessages = {
    messages: {
      api_requests: {
        request_envelopes_enumerated: 1,
        request_envelopes_parsed: 1,
        request_envelopes_malformed: 0,
        metrics: {
          tokens_in: s8Metric,
          tokens_out: s8Metric,
          cache_reads: s8Metric,
          cache_writes: s8Metric,
          cost: s8Metric,
        },
      },
    },
  };
  const s8ZeroLeafRun = join(s5Control, 'state/runs', 'zero-leaf.jsonl');
  writeFileSync(
    s8ZeroLeafRun,
    `${[
      s5Started('zero-leaf'),
      s5Finished('zero-leaf', 'benchmark', 0, true, {
        steps: [s5Step],
        telemetry: {
          schema_version: 2,
          status: 'available',
          reason: null,
          store_task_id: 's5-zero-leaf',
          observed: s8ObservedMessages,
          derived: null,
          unavailable_metrics: {},
        },
      }),
    ]
      .map(JSON.stringify)
      .join('\n')}\n`,
  );
  writeFileSync(join(s5Control, 'state/runs', 'zero-leaf.gate.log'), s5GateBlock);
  const s8ZeroLeafOut = join(s5ReportRoot, 'zero-leaf-report.json');
  runHarness(s5ReportRoot, ['report', `--out=${s8ZeroLeafOut}`], s5Control);
  const s8ZeroLeafReport = JSON.parse(readFileSync(s8ZeroLeafOut));
  check(
    'S8',
    'REPORT-zero-observed-leaves-keep-null-total',
    ['tokens_in', 'tokens_out', 'cache_reads', 'cache_writes', 'cost'].every(
      (name) =>
        s8ZeroLeafReport.telemetry.metrics[name].values_observed === 0 &&
        s8ZeroLeafReport.telemetry.metrics[name].total === null &&
        s8ZeroLeafReport.telemetry.metrics[name].mean === null,
    ),
  );
  check(
    'S5',
    'REPORT-three-run-fixture-bytes-remain-unchanged',
    readFileSync(s5TerminalRun.path).equals(s5TerminalRun.bytes) &&
      readFileSync(s5OrdinaryRun.path).equals(s5OrdinaryRun.bytes) &&
      readFileSync(s5AdverseRun.path).equals(s5AdverseRun.bytes),
  );

  const s5InvalidRoot = join(root, 's5-invalid');
  const s5InvalidControl = join(s5InvalidRoot, 'control');
  mkdirSync(join(s5InvalidControl, 'state/runs'), { recursive: true });
  mkdirSync(join(s5InvalidControl, 'state/ledgers'), { recursive: true });
  mkdirSync(join(s5InvalidControl, 'state/reports'), { recursive: true });
  const s5UnfinishedRun = s5WriteRun(s5InvalidControl, 'unfinished', [s5Started('unfinished', null)]);
  const s5MalformedRun = s5WriteRun(s5InvalidControl, 'malformed', ['{bad']);
  const s5UnlabelledRun = s5WriteRun(s5InvalidControl, 'unlabelled', [
    s5Started('unlabelled'),
    { event: 'run_finished', run_id: 'unlabelled', task_id: 'S5T', duration_ms: 1 },
  ]);
  const s5PartialGateRun = s5WriteRun(s5InvalidControl, 'partial-gate', [
    s5Started('partial-gate'),
    s5Finished('partial-gate', 'benchmark', 0, true, { steps: [s5Step] }),
  ]);
  writeFileSync(join(s5InvalidControl, 'state/runs', 'partial-gate.gate.log'), s5GateBlock.slice(0, -3));
  const s5InvalidOut = join(s5InvalidRoot, 'report.json');
  const s5InvalidReportRun = runHarness(s5InvalidRoot, ['report', `--out=${s5InvalidOut}`], s5InvalidControl);
  const s5InvalidReport = JSON.parse(readFileSync(s5InvalidOut));
  check(
    'S5',
    'REPORT-unfinished-invalid-and-unlabelled-counts-are-explicit-not-silently-dropped',
    s5InvalidReportRun.status === 0 &&
      s5InvalidReport.runs_total === 4 &&
      s5InvalidReport.runs_finished === 0 &&
      s5InvalidReport.unfinished_runs === 1 &&
      s5InvalidReport.invalid_run_streams === 3 &&
      s5InvalidReport.historical_v1_records_uninterpreted === 1 &&
      s5InvalidReport.per_task.length === 0,
    JSON.stringify({
      total: s5InvalidReport.runs_total,
      finished: s5InvalidReport.runs_finished,
      unfinished: s5InvalidReport.unfinished_runs,
      invalid: s5InvalidReport.invalid_run_streams,
      historicalUnlabelled: s5InvalidReport.historical_v1_records_uninterpreted,
      perTask: s5InvalidReport.per_task.length,
    }),
  );
  check(
    'S5',
    'REPORT-unlabelled-and-partial-input-bytes-remain-unchanged',
    readFileSync(s5UnfinishedRun.path).equals(s5UnfinishedRun.bytes) &&
      readFileSync(s5MalformedRun.path).equals(s5MalformedRun.bytes) &&
      readFileSync(s5UnlabelledRun.path).equals(s5UnlabelledRun.bytes) &&
      readFileSync(s5PartialGateRun.path).equals(s5PartialGateRun.bytes),
  );

  // ---- S7: external exports cannot target the harness control plane; the guard supports an explicit fixture root.
  const s7ControlPlane = join(REAL_REPO_ROOT, '.harness/state/control');
  let s7ControlExportRefused = false;
  try {
    s2.resolveExternalOutputPath(join(s7ControlPlane, 's7-refused-export.json'));
  } catch {
    s7ControlExportRefused = true;
  }
  check(
    'S7',
    'EXPORT-harness-control-plane-target-refused',
    s7ControlExportRefused && !existsSync(join(s7ControlPlane, 's7-refused-export.json')),
  );

  const s7Home = harnessHome;
  const s7ControlRoot = join(root, 's7-control-root');
  const runRedirectedEntry = (args) =>
    spawnSync(process.execPath, [join(RUNTIME_DIR, 'terminal-evaluation.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: s7Home, HARNESS_CONTROL_ROOT: s7ControlRoot },
    });
  const s7Disable = runRedirectedEntry(['disable']);
  const s7DisabledEvaluate = runRedirectedEntry([
    'evaluate',
    '--task=P6T',
    '--run-id=s7-disabled',
    '--no-gate',
    '--quiet',
  ]);
  check(
    'S7',
    'GUARD-redirected-control-root-marker-blocks-child-without-real-marker',
    s7Disable.status === 0 &&
      existsSync(join(s7ControlRoot, 'terminal-evaluation.disabled')) &&
      s7DisabledEvaluate.status === 2 &&
      !existsSync(join(s7Home, 'state/runs', 's7-disabled.jsonl')) &&
      !existsSync(join(REAL_REPO_ROOT, '.harness/state/control/terminal-evaluation.disabled')),
  );
  const s7Enable = runRedirectedEntry(['enable']);
  const s7EnabledEvaluate = runRedirectedEntry([
    'evaluate',
    '--task=P6T',
    '--run-id=s7-enabled',
    '--no-gate',
    '--quiet',
  ]);
  check(
    'S7',
    'GUARD-redirected-control-root-enable-restores-child',
    s7Enable.status === 0 &&
      !existsSync(join(s7ControlRoot, 'terminal-evaluation.disabled')) &&
      s7EnabledEvaluate.status === 1 &&
      existsSync(join(s7Home, 'state/runs', 's7-enabled.jsonl')),
  );

  // ---- I14: commit-bound evaluation records. A result produced at commit A must not be readable as a result for
  // commit B, and the record must not claim more than one invocation observed.
  const i14LedgerBase = (id) => ({
    version: 1,
    run_id: id,
    task_id: 'P6T',
    title: 'commit-bound fixture',
    source_commit: sourceCommit,
    workspace: '.',
    gate: { name: 'benchmark', compatibility: 'gate_compatible', checked_at: '2026-01-01T00:00:00.000Z', problems: [] },
    status: 'verification_pending',
    acceptance: ['criterion one'],
    completed: [],
    pending: [],
    claims: [],
    verification: [],
    failures: [],
    invalid_transitions: [],
    verifier: null,
    blockers: [],
    transitions: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const i14Entry = (overrides = {}) => ({
    at: '2026-01-01T00:00:00.000Z',
    run_id: 'i14-run',
    declared_source_commit: sourceCommit,
    judged_commit_pre: null,
    judged_commit_post: null,
    judged_commit_basis: 'observed',
    judged_commit_scope: null,
    judged_cwd: null,
    status_hash_pre: null,
    status_hash_post: null,
    gate: 'benchmark',
    gate_definition_sha256: null,
    contract_digest: null,
    lockfile_digest: null,
    acceptance_contract_schema_version: null,
    ...overrides,
  });

  // A commit is recorded full or not at all: a prefix is what makes two commits confusable.
  const i14Full = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  check(
    'I14',
    'COMMIT-40-hex-accepted-and-every-shorter-or-other-form-rejected',
    s2.normalizeCommitSha(i14Full) === i14Full &&
      s2.normalizeCommitSha(i14Full.slice(0, 39)) === null &&
      s2.normalizeCommitSha(i14Full.slice(0, 7)) === null &&
      s2.normalizeCommitSha(i14Full.toUpperCase()) === null &&
      s2.normalizeCommitSha(`${i14Full}0`) === null &&
      s2.normalizeCommitSha('') === null &&
      s2.normalizeCommitSha('   ') === null &&
      s2.normalizeCommitSha(undefined) === null,
    `full=${s2.normalizeCommitSha(i14Full)} short=${s2.normalizeCommitSha(i14Full.slice(0, 7))}`,
  );

  // Three values, not two (C10): a linked worktree of THIS repo is a first-class target at a different commit.
  check(
    'I14',
    'SCOPE-three-way-primary-worktree-and-unrelated',
    s2.resolveJudgedScope({
      workspaceCommonDir: '/repo/.git',
      workspaceGitDir: '/repo/.git',
      ownCommonDir: '/repo/.git',
    }) === 'primary_repo' &&
      s2.resolveJudgedScope({
        workspaceCommonDir: '/repo/.git',
        workspaceGitDir: '/repo/.git/worktrees/T-alt',
        ownCommonDir: '/repo/.git',
      }) === 'linked_worktree_of_this_repo' &&
      s2.resolveJudgedScope({
        workspaceCommonDir: '/other/.git',
        workspaceGitDir: '/other/.git/worktrees/x',
        ownCommonDir: '/repo/.git',
      }) === 'unrelated_tree' &&
      s2.resolveJudgedScope({ workspaceCommonDir: null, workspaceGitDir: null, ownCommonDir: null }) === null,
  );

  // Canonical serialisation: key order must not move the digest.
  check(
    'I14',
    'CANONICAL-json-sorts-keys-recursively-and-keeps-array-order',
    s2.canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } }) === s2.canonicalJson({ a: { c: [{ e: 2, f: 1 }], d: 2 }, b: 1 }) &&
      s2.canonicalJson([1, 2]) !== s2.canonicalJson([2, 1]) &&
      s2.canonicalJson(undefined) === 'null',
  );

  // C3: the digest must cover what actually judges the run — all four inputs move it.
  const i14Task = {
    acceptance: ['criterion one'],
    acceptance_checks: [{ id: 'k1', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks' }],
    acceptance_boundaries: [{ criterion: 1, boundary: 'AUTOMATED_SAFE' }],
  };
  const i14Base = s2.contractDigest(i14Task, 'check');
  const i14Variants = [
    { ...i14Task, acceptance: ['criterion one', 'criterion two'] },
    { ...i14Task, acceptance_checks: [{ id: 'k2', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks' }] },
    { ...i14Task, acceptance_boundaries: [{ criterion: 1, boundary: 'HUMAN_OR_HYBRID' }] },
  ];
  check(
    'I14',
    'CONTRACT-DIGEST-binds-acceptance-checks-boundaries-and-the-resolved-gate',
    s2.contractDigest(i14Task, 'check:full') !== i14Base &&
      i14Variants.every((variant) => s2.contractDigest(variant, 'check') !== i14Base) &&
      s2.contractDigest(i14Task, 'check') === i14Base &&
      s2.contractDigest({ acceptance: ['criterion one'] }, 'check') !== i14Base,
    `base=${i14Base} gate-variant=${s2.contractDigest(i14Task, 'check:full')}`,
  );

  // C1: the writer normalises every optional observation to null, whatever the caller passed.
  const i14Normalised = s2.buildEvaluationEntry({
    at: '2026-01-01T00:00:00.000Z',
    runId: 'i14-run',
    task: { source_commit: sourceCommit },
    gateName: 'benchmark',
    workspacePath: join(root, 'i14-not-a-repo'),
    pre: { commit: 'deadbeef', scope: 'foreign_worktree', statusHash: 'not-hex' },
    post: undefined,
  });
  check(
    'I14',
    'C1-writer-normalises-every-optional-observation-to-null',
    i14Normalised.judged_commit_pre === null &&
      i14Normalised.judged_commit_post === null &&
      i14Normalised.judged_commit_scope === null &&
      i14Normalised.status_hash_pre === null &&
      i14Normalised.status_hash_post === null &&
      i14Normalised.lockfile_digest === null &&
      i14Normalised.acceptance_contract_schema_version === null &&
      i14Normalised.declared_source_commit === sourceCommit &&
      i14Normalised.judged_commit_basis === 'observed' &&
      i14Normalised.gate === 'benchmark' &&
      typeof i14Normalised.contract_digest === 'string',
    JSON.stringify(i14Normalised),
  );

  // C1, read side: an all-null entry is valid, survives a strict parse round-trip, and the ledger stays operational.
  const i14NullLedger = { ...i14LedgerBase('i14-null'), evaluations: [i14Entry()] };
  const i14NullBytes = `${JSON.stringify(i14NullLedger, null, 2)}\n`;
  const i14NullParsed = s2.parseStrictJson(i14NullBytes);
  check(
    'I14',
    'C1-null-observation-round-trips-strict-parse-and-stays-operational',
    s2.validateOperationalLedger(i14NullLedger).length === 0 &&
      i14NullParsed.ok === true &&
      s2.validateOperationalLedger(i14NullParsed.value).length === 0 &&
      i14NullParsed.value.evaluations[0].judged_commit_pre === null &&
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-pre-phase') }).length === 0,
  );

  // C1, read side: the reader accepts null but refuses a prefix, a relabelled basis, and an unknown scope.
  const i14Rejected = [
    { judged_commit_pre: 'abc1234' },
    { judged_commit_post: i14Full.toUpperCase() },
    { judged_commit_basis: 'declared' },
    { judged_commit_scope: 'foreign_worktree' },
    { status_hash_pre: 'zz' },
    { contract_digest: 'nope' },
    { declared_source_commit: 'nothex!' },
  ];
  check(
    'I14',
    'C1-reader-accepts-null-and-refuses-prefix-declared-basis-unknown-scope-and-bad-digests',
    i14Rejected.every((overrides) =>
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-reject'), evaluations: [i14Entry(overrides)] }).length > 0,
    ) &&
      s2.validateOperationalLedger({
        ...i14LedgerBase('i14-accept'),
        evaluations: [i14Entry({ judged_commit_pre: i14Full, judged_commit_scope: 'unrelated_tree' })],
      }).length === 0,
  );

  // F3, writer/reader agreement: the writer normalises an over-long gate name to `null`, so the strict reader must
  // accept `null` there. When it demanded text it would refuse a ledger this evaluator itself wrote, and
  // `loadLedger` fails closed, so the disagreement would brick the ledger on the NEXT read instead of at write time.
  const i14GateNullEntry = s2.buildEvaluationEntry({
    at: '2026-01-01T00:00:00.000Z',
    runId: 'i14-gate-null',
    task: { source_commit: sourceCommit },
    gateName: 'g'.repeat(200),
    workspacePath: join(root, 'i14-not-a-repo'),
    pre: { commit: i14Full, scope: 'unrelated_tree', statusHash: null },
    post: undefined,
  });
  const i14GateNullLedger = { ...i14LedgerBase('i14-gate-null'), evaluations: [i14GateNullEntry] };
  const i14GateNullParsed = s2.parseStrictJson(`${JSON.stringify(i14GateNullLedger, null, 2)}\n`);
  check(
    'I14',
    'F3-writer-gate-null-round-trips-the-strict-reader-and-stays-operational',
    i14GateNullEntry.gate === null &&
      s2.validateOperationalLedger(i14GateNullLedger).length === 0 &&
      i14GateNullParsed.ok === true &&
      s2.validateOperationalLedger(i14GateNullParsed.value).length === 0 &&
      i14GateNullParsed.value.evaluations[0].gate === null &&
      // a gate that is neither `null` nor bounded text is still refused
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-gate-number'), evaluations: [i14Entry({ gate: 42 })] })
        .length > 0 &&
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-gate-long'), evaluations: [i14Entry({ gate: 'g'.repeat(121) })] })
        .length > 0 &&
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-gate-empty'), evaluations: [i14Entry({ gate: '' })] }).length > 0,
    JSON.stringify({ gate: i14GateNullEntry.gate, parsed: i14GateNullParsed.ok }),
  );

  // F8: a run id is a STRING token. `RegExp.test` coerces its argument, so `42`, `true` and `null` used to
  // validate in both arrays; the evaluator only ever writes string run ids, so the guard cannot refuse a ledger
  // it wrote.
  const i14BadRunIds = [42, true, null, ['run'], { run_id: 'run' }];
  const i14VerificationWith = (runId) => ({
    at: '2026-01-01T00:00:00.000Z',
    run_id: runId,
    gate: 'benchmark',
    command: 'npm run benchmark',
    exit_code: 0,
    duration_ms: 1,
    mechanism: 'evaluator',
    steps: [],
  });
  check(
    'I14',
    'F8-run-id-must-be-a-string-token-in-evaluations-and-in-its-verification-twin',
    i14BadRunIds.every(
      (value) =>
        s2.validateOperationalLedger({ ...i14LedgerBase('i14-runid-e'), evaluations: [i14Entry({ run_id: value })] })
          .length > 0 &&
        s2.validateOperationalLedger({
          ...i14LedgerBase('i14-runid-v'),
          verification: [i14VerificationWith(value)],
        }).length > 0,
    ) &&
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-runid-ok'), evaluations: [i14Entry()] }).length === 0 &&
      s2.validateOperationalLedger({
        ...i14LedgerBase('i14-runid-ok-v'),
        verification: [i14VerificationWith('run-1')],
      }).length === 0,
    JSON.stringify(i14BadRunIds),
  );

  // Cardinality: bounded on write (a write the reader would refuse does not fail until the next read).
  const i14FullLedger = { ...i14LedgerBase('i14-cap'), evaluations: Array.from({ length: 10_000 }, () => i14Entry()) };
  let i14CapRefused = false;
  try {
    s2.appendEvaluation(i14FullLedger, i14Entry());
  } catch (error) {
    i14CapRefused = String(error.message).startsWith('EVALUATIONS_CAPACITY_EXCEEDED');
  }
  const i14One = { ...i14LedgerBase('i14-cap-one'), evaluations: [i14Entry()] };
  s2.appendEvaluation(i14One, i14Entry({ run_id: 'i14-run-2' }));
  check(
    'I14',
    'CARDINALITY-evaluations-array-is-bounded-on-write-and-on-read',
    i14CapRefused &&
      i14One.evaluations.length === 2 &&
      s2.validateOperationalLedger({ ...i14LedgerBase('i14-cap-over'), evaluations: [...i14FullLedger.evaluations, i14Entry()] }).some(
        (problem) => problem.includes('$.evaluations must be an array with 0..10000 items'),
      ) &&
      s2.validateOperationalLedger(i14FullLedger).length === 0,
  );

  // The pre/post status-hash pair over a real disposable repository.
  const i14Repo = join(root, 'i14-repo');
  mkdirSync(i14Repo, { recursive: true });
  writeFileSync(join(i14Repo, 'file.txt'), 'one\n');
  git(['init', '-q'], i14Repo);
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'add', '.'], i14Repo);
  git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'commit', '-qm', 'i14'], i14Repo);
  const i14Pre = s2.observeJudgedTree(i14Repo);
  const i14PreAgain = s2.observeJudgedTree(i14Repo);
  writeFileSync(join(i14Repo, 'file.txt'), 'two\n');
  const i14AfterEdit = s2.observeJudgedTree(i14Repo);
  check(
    'I14',
    'STATUS-HASH-pre-post-pair-is-stable-until-the-tree-moves',
    i14Pre.commit === i14AfterEdit.commit &&
      i14Pre.statusHash === i14PreAgain.statusHash &&
      i14Pre.statusHash !== i14AfterEdit.statusHash &&
      /^[0-9a-f]{40}$/.test(i14Pre.commit) &&
      /^[0-9a-f]{12}$/.test(i14Pre.statusHash),
    JSON.stringify({ pre: i14Pre, afterEdit: i14AfterEdit }),
  );

  // The real writer output validates against the real reader: an observed entry from a real git tree.
  const i14ObservedEntry = s2.buildEvaluationEntry({
    at: '2026-01-01T00:00:00.000Z',
    runId: 'i14-observed',
    task: { ...i14Task, source_commit: sourceCommit, schema_version: 1 },
    gateName: 'benchmark',
    workspacePath: i14Repo,
    pre: i14Pre,
    post: i14AfterEdit,
  });
  check(
    'I14',
    'ENTRY-observed-record-validates-and-names-both-observations',
    s2.validateOperationalLedger({ ...i14LedgerBase('i14-observed'), evaluations: [i14ObservedEntry] }).length === 0 &&
      i14ObservedEntry.judged_commit_pre === i14ObservedEntry.judged_commit_post &&
      i14ObservedEntry.status_hash_pre !== i14ObservedEntry.status_hash_post &&
      i14ObservedEntry.judged_commit_basis === 'observed' &&
      i14ObservedEntry.acceptance_contract_schema_version === 1,
    JSON.stringify(i14ObservedEntry),
  );

  // C2: both new kinds are scoped to the newest entry that a run actually produced.
  const i14Kinds = (ledger, workspacePath) => s2.ledgerStateQuality(ledger, workspacePath).map((issue) => issue.kind);
  const i14Verdict = i14Entry({ run_id: 'i14-verdict', gate: 'benchmark' });
  const i14Moved = i14Entry({ run_id: 'i14-moved', judged_commit_pre: i14Full, judged_commit_post: i14Full });
  // An entry whose own declared value and own judged value AGREE: neither kind may fire.
  const i14Agreed = i14Entry({
    run_id: 'i14-agreed',
    judged_commit_pre: sourceCommit,
    judged_commit_post: sourceCommit,
  });
  check(
    'I14',
    'C2-no-gate-gate-incompatible-and-unledgered-runs-trigger-neither-new-kind',
    !i14Kinds(i14LedgerBase('i14-c2a')).includes('result_unbound') &&
      !i14Kinds(i14LedgerBase('i14-c2a')).includes('declared_not_judged') &&
      !i14Kinds(i14LedgerBase('i14-c2b'), repo).includes('result_unbound') &&
      !i14Kinds(i14LedgerBase('i14-c2b'), repo).includes('declared_not_judged'),
    JSON.stringify(i14Kinds(i14LedgerBase('i14-c2b'), repo)),
  );
  check(
    'I14',
    'C2-unbound-newest-entry-is-result_unbound-and-agreed-entry-is-neither',
    i14Kinds({ ...i14LedgerBase('i14-c2c'), evaluations: [i14Entry()] }).includes('result_unbound') &&
      !i14Kinds({ ...i14LedgerBase('i14-c2c'), evaluations: [i14Entry()] }).includes('declared_not_judged') &&
      !i14Kinds({ ...i14LedgerBase('i14-c2d'), evaluations: [i14Agreed] }).includes('result_unbound') &&
      !i14Kinds({ ...i14LedgerBase('i14-c2d'), evaluations: [i14Agreed] }).includes('declared_not_judged'),
  );
  check(
    'I14',
    'C2-declared-not-judged-is-entry-versus-entry-and-only-for-the-newest-entry',
    i14Kinds({ ...i14LedgerBase('i14-c2e'), evaluations: [i14Verdict, i14Moved] }).includes('declared_not_judged') &&
      i14Kinds({ ...i14LedgerBase('i14-c2f'), evaluations: [i14Moved, i14Verdict] }).includes('result_unbound') &&
      // a short declared sha that prefixes the judged commit is agreement, not a mismatch
      !i14Kinds({
        ...i14LedgerBase('i14-c2g'),
        evaluations: [i14Entry({ declared_source_commit: i14Full.slice(0, 8), judged_commit_pre: i14Full })],
      }).includes('declared_not_judged'),
  );
  check(
    'I14',
    'C2-stale_state-still-fires-only-when-nothing-was-ever-verified',
    i14Kinds(i14LedgerBase('i14-c2h'), repo).includes('stale_state') &&
      !i14Kinds({ ...i14LedgerBase('i14-c2i'), evaluations: [i14Moved] }, repo).includes('stale_state') &&
      !i14Kinds(
        {
          ...i14LedgerBase('i14-c2j'),
          verification: [{ at: '2026-01-01T00:00:00.000Z', run_id: 'x', gate: 'benchmark', command: 'npm test', exit_code: 0, duration_ms: 1, mechanism: 'evaluator', steps: [] }],
        },
        repo,
      ).includes('stale_state'),
  );

  // The classifier is untouched by any of this: same parameter clause, and it cannot read the new record.
  check(
    'I14',
    'TERM-classifier-cannot-read-commit-binding-records',
    !/evaluations|judged_commit|contract_digest|status_hash/.test(classifyLedgerStatusCurrent.toString()) &&
      !/evaluations|judged_commit|contract_digest|status_hash/.test(
        readFileSync(join(RUNTIME_DIR, 'verification-state.mjs'), 'utf8'),
      ) &&
      classifierParameters === '{gateResult,acceptance,acceptanceCoverage,verifier,integrityVeto}',
    classifierParameters,
  );

  // ---- I15: environment provenance (P2a) and historical workspace lifecycle (P1).
  //
  // The defect under test: `lockfile_digest` is a DECLARED value that was byte-identical for a contaminated run and a
  // correct one, and the string `node_modules` appeared 0 times in any record. Every assertion below is about making
  // that impossible — and about never claiming more than was looked at. Where execution correctness is the thing under
  // test it is NOT mocked: the ancestor scan, the symlink refusal and the resolver probe all run against real
  // directories under a `mkdtemp` root, and the resolver probe is a real Node child process.
  const i15Root = join(root, 'i15');
  const i15Dir = (...parts) => join(i15Root, ...parts);
  const i15File = (relativePath, content) => {
    const absolute = i15Dir(relativePath);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);

    return absolute;
  };
  mkdirSync(i15Root, { recursive: true });

  // C1, mechanical: a worktree root outside the repository is not enough on its own, because the root is derived from
  // operator-controlled variables and an out-of-repo root can inherit `$HOME/node_modules` through the same upward
  // resolution. So the guarantee is MEASURED: a `node_modules` in any strict ancestor refuses.
  const i15Below = i15Dir('above', 'below', 'deeper');
  mkdirSync(i15Below, { recursive: true });
  const i15AncestorClear = s2.ancestorNodeModulesRefusal(i15Below);
  mkdirSync(i15Dir('above', 'node_modules'), { recursive: true });
  const i15AncestorFound = s2.ancestorNodeModulesRefusal(i15Below);
  // A `node_modules` in the ROOT ITSELF is not an ancestor: the install creates it there, and that is the point. The
  // fixture gives the root a clean ancestor chain so the two conditions are genuinely distinguishable.
  const i15SelfRoot = i15Dir('clean', 'wt');
  mkdirSync(join(i15SelfRoot, 'node_modules'), { recursive: true });
  const i15SelfOnly = s2.ancestorNodeModulesRefusal(i15SelfRoot);
  check(
    'I15',
    'C1-ancestor-scan-refuses-a-root-with-node_modules-above-it-and-ignores-the-roots-own',
    i15AncestorClear === null &&
      i15AncestorFound !== null &&
      i15AncestorFound.path === i15Dir('above', 'node_modules') &&
      i15AncestorFound.kind === 'directory' &&
      i15SelfOnly === null,
    JSON.stringify({ clear: i15AncestorClear, found: i15AncestorFound, selfOnly: i15SelfOnly }),
  );
  check(
    'I15',
    'C1-containment-is-resolved-not-string-prefixed',
    s2.isContainedBy(i15Dir('above', 'below'), i15Dir('above')) === true &&
      s2.isContainedBy(i15Dir('above'), i15Dir('above')) === true &&
      // A string prefix is not containment: `ab` is not inside `a`.
      s2.isContainedBy(i15Dir('ab'), i15Dir('a')) === false,
  );
  check(
    'I15',
    'C1-worktree-root-is-derived-from-the-operator-variables-in-a-documented-order-and-never-falls-back-into-the-repository',
    s2.resolveWorkspaceRoot({ HARNESS_WORKTREE_ROOT: '/x/one', XDG_CACHE_HOME: '/x/two', HOME: '/x/three' }).source ===
      'env_override' &&
      s2.resolveWorkspaceRoot({ XDG_CACHE_HOME: '/x/two', HOME: '/x/three' }).source === 'xdg_cache_home' &&
      s2.resolveWorkspaceRoot({ HOME: '/x/three' }).source === 'home_cache' &&
      s2.resolveWorkspaceRoot({ HOME: '/x/three' }).path === '/x/three/.cache/task-board-harness/worktrees' &&
      // No variable at all is `null`, never a repository-internal guess: that topology is the defect.
      s2.resolveWorkspaceRoot({}) === null,
    JSON.stringify([
      s2.resolveWorkspaceRoot({ HARNESS_WORKTREE_ROOT: '/x/one', XDG_CACHE_HOME: '/x/two' }),
      s2.resolveWorkspaceRoot({ XDG_CACHE_HOME: '/x/two' }),
      s2.resolveWorkspaceRoot({ HOME: '/x/three' }),
      s2.resolveWorkspaceRoot({}),
    ]),
  );
  check(
    'I15',
    'C1-a-root-inside-the-repository-is-refused-before-anything-is-created',
    (() => {
      try {
        s2.assertWorkspaceRootRefusals(join(REAL_REPO_ROOT, '.harness', 'state', 'never-created'));
        return false;
      } catch (error) {
        return /WORKTREE_ROOT_INSIDE_REPOSITORY/.test(String(error.message));
      }
    })(),
  );

  // C2, read side: a `node_modules` SYMLINK is reported and never passed to npm, because `npm ci` destroys the target.
  const i15Victim = i15Dir('victim');
  mkdirSync(join(i15Victim, 'inside-victim'), { recursive: true });
  const i15LinkWorktree = i15Dir('link-worktree');
  mkdirSync(join(i15LinkWorktree, 'ui'), { recursive: true });
  symlinkSync(i15Victim, join(i15LinkWorktree, 'node_modules'));
  symlinkSync(i15Victim, join(i15LinkWorktree, 'ui', 'node_modules'));
  const i15NestedPaths = s2.workspaceNodeModulesPaths(i15LinkWorktree).sort();
  let i15SymlinkRefused = false;
  try {
    s2.assertNoSymlinkedNodeModules(i15LinkWorktree);
  } catch (error) {
    i15SymlinkRefused = /SYMLINKED_NODE_MODULES/.test(String(error.message));
  }
  check(
    'I15',
    'C2-a-symlinked-node_modules-is-found-at-any-depth-and-refused-not-unlinked',
    i15NestedPaths.length === 2 &&
      i15SymlinkRefused &&
      // Refused, so the victim's contents are still there: `npm ci` never got the chance to destroy them.
      existsSync(join(i15Victim, 'inside-victim')),
    JSON.stringify(i15NestedPaths),
  );

  // C8: both refusals happen before any process is spawned and before any directory is created.
  const i15Lockfile = (body) => Buffer.from(body);
  let i15NoLockfileRefused = false;
  let i15BadVersionRefused = false;
  let i15BadVersionAccepted = null;
  const i15Pm = { name: 'npm', version: '12.0.1', declared_field: null, declared_field_conflict: false };
  try {
    s2.assertHistoricalProject({ commit: 'a'.repeat(40), lockfileRaw: null, packageManager: i15Pm, acceptLockfileVersion: false, acceptPmMismatch: false });
  } catch (error) {
    i15NoLockfileRefused = /NO_LOCKFILE/.test(String(error.message));
  }
  try {
    s2.assertHistoricalProject({
      commit: 'a'.repeat(40),
      lockfileRaw: i15Lockfile('{"lockfileVersion":99}'),
      packageManager: i15Pm,
      acceptLockfileVersion: false,
      acceptPmMismatch: false,
    });
  } catch (error) {
    i15BadVersionRefused = /LOCKFILE_VERSION_UNSUPPORTED/.test(String(error.message));
  }
  i15BadVersionAccepted = s2.assertHistoricalProject({
    commit: 'a'.repeat(40),
    lockfileRaw: i15Lockfile('{"lockfileVersion":99}'),
    packageManager: i15Pm,
    acceptLockfileVersion: true,
    acceptPmMismatch: false,
  });
  const i15GoodVersion = s2.assertHistoricalProject({
    commit: 'a'.repeat(40),
    lockfileRaw: i15Lockfile('{"lockfileVersion":3}'),
    packageManager: i15Pm,
    acceptLockfileVersion: false,
    acceptPmMismatch: false,
  });
  check(
    'I15',
    'C8-no-lockfile-and-an-out-of-set-lockfileVersion-are-refused-before-the-spawn',
    i15NoLockfileRefused &&
      i15BadVersionRefused &&
      i15BadVersionAccepted.lockfile_version === 99 &&
      i15BadVersionAccepted.lockfile_version_supported === false &&
      i15GoodVersion.lockfile_version === 3 &&
      i15GoodVersion.lockfile_version_supported === true &&
      // npm >= 7 accepts v1 and v2 SILENTLY, so "the install exited 0" is not evidence: the version is checked first.
      s2.npmSupportedLockfileVersions('12.0.1').join(',') === '1,2,3' &&
      s2.npmSupportedLockfileVersions('6.14.0').join(',') === '1,2' &&
      s2.npmSupportedLockfileVersions(null).join(',') === '1,2',
  );
  check(
    'I15',
    'C8-a-packageManager-field-that-contradicts-the-probe-is-refused-unless-acknowledged',
    (() => {
      const conflicting = { name: 'npm', version: '12.0.1', declared_field: 'pnpm@9.0.0', declared_field_conflict: true };
      let refused = false;

      try {
        s2.assertHistoricalProject({
          commit: 'a'.repeat(40),
          lockfileRaw: i15Lockfile('{"lockfileVersion":3}'),
          packageManager: conflicting,
          acceptLockfileVersion: false,
          acceptPmMismatch: false,
        });
      } catch (error) {
        refused = /PACKAGE_MANAGER_CONFLICT/.test(String(error.message));
      }

      const accepted = s2.assertHistoricalProject({
        commit: 'a'.repeat(40),
        lockfileRaw: i15Lockfile('{"lockfileVersion":3}'),
        packageManager: conflicting,
        acceptLockfileVersion: false,
        acceptPmMismatch: true,
      });

      return refused && accepted.lockfile_version_supported === true;
    })(),
  );

  // C5: the reuse key must move for every input that changes the tree. Node MINOR and PATCH are covered because the
  // FULL version is in the key; the full package-manager version is there on exactly the grounds that made a
  // major-only key unsafe.
  const i15KeyInput = {
    commit: 'a'.repeat(40),
    lockfileDigest: '111111111111',
    nodeVersion: 'v24.18.0',
    packageManager: { name: 'npm', version: '12.0.1' },
    platform: { os: 'linux', arch: 'x64' },
    npmrcDigest: '2222222222222222',
    npmConfigDigest: '3333333333333333',
  };
  const i15Key = s2.computeWorkspaceKey(i15KeyInput);
  const i15KeyMoves = [
    { commit: 'b'.repeat(40) },
    { lockfileDigest: '999999999999' },
    { nodeVersion: 'v24.18.1' },
    { nodeVersion: 'v24.19.0' },
    { nodeVersion: 'v25.0.0' },
    { packageManager: { name: 'npm', version: '12.0.2' } },
    { packageManager: { name: 'npm', version: '9.9.9' } },
    { platform: { os: 'darwin', arch: 'x64' } },
    { platform: { os: 'linux', arch: 'arm64' } },
    { npmrcDigest: '4444444444444444' },
    { npmConfigDigest: '5555555555555555' },
  ];
  check(
    'I15',
    'C5-reuse-key-moves-for-commit-lockfile-node-minor-patch-pm-version-platform-npmrc-and-npm-config',
    /^[0-9a-f]{16}$/.test(i15Key) &&
      i15KeyMoves.every((override) => s2.computeWorkspaceKey({ ...i15KeyInput, ...override }) !== i15Key) &&
      // A different KEY ORDER cannot move it, and an identical input is stable.
      s2.computeWorkspaceKey({ npmConfigDigest: '3333333333333333', ...i15KeyInput }) === i15Key &&
      s2.computeWorkspaceKey(i15KeyInput) === i15Key,
    i15Key,
  );
  check(
    'I15',
    'C5-reuse-re-verifies-the-installed-state-digest-because-the-five-metadata-conditions-read-no-bytes',
    (() => {
      const i15Installed = i15Dir('reuse', 'node_modules');
      const i15Workspace = i15Dir('reuse');

      mkdirSync(i15Installed, { recursive: true });
      writeFileSync(join(i15Installed, '.package-lock.json'), '{"packages":{}}\n');
      const i15Observed = s2.observeInstalledState(i15Workspace);
      const i15Attestation = {
        schema_version: 1,
        workspace_key: 'a'.repeat(16),
        workspace_instance: 'default',
        judged_commit: 'a'.repeat(40),
        state: 'usable',
        installed_state_digest: i15Observed.state_digest,
        installed_package_count: i15Observed.entry_count,
      };
      const i15Args = { attestation: i15Attestation, directory: i15Workspace, commit: 'a'.repeat(40), key: 'a'.repeat(16), instance: 'default' };
      const i15BeforeTruncation = s2.verifyReusableWorkspace(i15Args);
      // A human-modified tree: the same directory, the same HEAD, the same attestation — and a DIFFERENT digest.
      writeFileSync(join(i15Installed, '.package-lock.json'), '{"packages":{"truncated":{}}}\n');
      const i15AfterTruncation = s2.verifyReusableWorkspace(i15Args);
      const i15NoAttestation = s2.verifyReusableWorkspace({ ...i15Args, attestation: null });
      const i15NotUsable = s2.verifyReusableWorkspace({ ...i15Args, attestation: { ...i15Attestation, state: 'preparing' } });
      const i15WrongCommit = s2.verifyReusableWorkspace({ ...i15Args, commit: 'c'.repeat(40) });

      return (
        i15BeforeTruncation.reusable === false &&
        // A non-git directory has no HEAD, so the HEAD condition alone refuses before the digest is even consulted.
        i15BeforeTruncation.reason === 'head_mismatch' &&
        i15AfterTruncation.reusable === false &&
        i15NoAttestation.reason === 'no_attestation' &&
        i15NotUsable.reason === 'attestation_state_preparing' &&
        i15WrongCommit.reason === 'commit_mismatch'
      );
    })(),
  );

  // C4: bounded by SERIALISED BYTES, not by a count. Ten thousand 1-2 KB entries are 10-20 MB, and a ledger over
  // `LEDGER_MAX_BYTES` is `rejected` on the next read and permanently invisible to every reader.
  const i15EnvEntry = (overrides = {}) => ({
    at: '2026-01-01T00:00:00.000Z',
    run_id: 'i15-env',
    schema_version: 1,
    gate_bearing: true,
    declared_source_commit: null,
    judged_commit: null,
    judged_commit_basis: 'observed',
    workspace_key: null,
    workspace_instance: null,
    workspace_root_source: null,
    workspace_root_digest: null,
    dependency_provisioning: 'present_unattested',
    dependency_provisioning_basis: 'observed',
    node_modules_topology: 'missing',
    node_modules_scope: 'none',
    node_modules_realpath: null,
    installed_package_count: null,
    installed_state_digest: null,
    installed_state_digest_source: null,
    // F1: the OBSERVED tree digest is a sibling of npm's DECLARED one, and it is `null` here — "not computed", never
    // "unchanged". Adding keys to this fixture is the only direction the schema may move.
    installed_tree_fingerprint: null,
    installed_tree_fingerprint_tier: null,
    installed_tree_fingerprint_limitation: null,
    installed_tree_fingerprint_basis: null,
    resolver_probe: null,
    resolver_probe_all_inside_workspace: null,
    // F3: `null` ("not observed") stays distinct from `[]` ("observed, and empty").
    resolver_probe_resolved_outside: null,
    resolver_probe_resolved_nothing: null,
    // F4: the sentinel is a field of its own, never an entry in `resolver_probe`.
    resolver_probe_negative_control: null,
    install: null,
    package_manager: null,
    node: null,
    platform: null,
    env: null,
    // F2: `null` and never `true` — npm does not report whether a lifecycle script ran.
    historical_install_executed_arbitrary_scripts: null,
    historical_install_script_execution_basis: null,
    historical_install_scripts_policy: null,
    historical_install_ignore_scripts: null,
    historical_install_output_showed_script_output: null,
    historical_install_output_basis: null,
    gate_env_policy: null,
    primary_git_config_hooks_path_before: null,
    primary_git_config_hooks_path_after: null,
    primary_git_config_changed: null,
    deviation: null,
    bounded_reason: null,
    ...overrides,
  });
  const i15LedgerBase = (id) => ({
    version: 1,
    run_id: id,
    task_id: 'P6T',
    title: 'environment fixture',
    source_commit: sourceCommit,
    workspace: '.',
    gate: { name: 'benchmark', compatibility: 'gate_compatible', checked_at: '2026-01-01T00:00:00.000Z', problems: [] },
    status: 'verification_pending',
    acceptance: ['criterion one'],
    completed: [],
    pending: [],
    claims: [],
    verification: [],
    failures: [],
    invalid_transitions: [],
    verifier: null,
    blockers: [],
    transitions: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const i15Bytes = (ledger) => Buffer.byteLength(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  const i15Filler = 'x'.repeat(2000);
  const i15BudgetLedger = { ...i15LedgerBase('i15-budget'), environments: [i15EnvEntry({ run_id: 'i15-a' })] };
  // A budget that fits ONE record comfortably and not two, so every append must evict the oldest. Ten thousand such
  // entries would be ~28 MB: a count-only bound would let the ledger past `LEDGER_MAX_BYTES`, and a ledger past that
  // is `rejected` on the next read and permanently invisible to every reader.
  const i15Budget = i15Bytes(i15BudgetLedger) + 2500;
  let i15ByteBoundRejected = null;
  for (let index = 1; index <= 8 && i15ByteBoundRejected === null; index += 1) {
    try {
      const i15Result = s2.appendEnvironment(
        i15BudgetLedger,
        i15EnvEntry({ run_id: `i15-${index}`, deviation: i15Filler }),
        { maxBytes: i15Budget },
      );

      if (i15Result.evicted > 0 && i15Bytes(i15BudgetLedger) > i15Budget) {
        i15ByteBoundRejected = 'OVER_BUDGET_AFTER_EVICTION';
      }
    } catch (error) {
      i15ByteBoundRejected = String(error.message);
    }
  }
  let i15SingleEntryRefused = null;
  try {
    s2.appendEnvironment({ ...i15LedgerBase('i15-single'), environments: [] }, i15EnvEntry({ deviation: 'y'.repeat(400) }), {
      maxBytes: 200,
    });
  } catch (error) {
    i15SingleEntryRefused = String(error.message);
  }
  check(
    'I15',
    'C4-environments-array-is-bounded-by-serialised-bytes-and-eviction-carries-a-recorded-reason',
    i15ByteBoundRejected === null &&
    i15Bytes(i15BudgetLedger) <= i15Budget &&
    i15BudgetLedger.environments.length === 1 &&
      i15BudgetLedger.environments.at(-1).bounded_reason !== null &&
      /evicted \d+ oldest environment record/.test(i15BudgetLedger.environments.at(-1).bounded_reason) &&
      i15BudgetLedger.environments.slice(0, -1).every((entry) => entry.bounded_reason === null) &&
      /^ENVIRONMENTS_BYTE_BUDGET_EXCEEDED/.test(String(i15SingleEntryRefused)),
    JSON.stringify({ bytes: i15Bytes(i15BudgetLedger), budget: i15Budget, single: i15SingleEntryRefused }),
  );
  check(
    'I15',
    'C4-environments-array-is-also-bounded-by-count-on-write-and-on-read',
    (() => {
      const i15Full = {
        ...i15LedgerBase('i15-cap'),
        environments: Array.from({ length: 10_000 }, () => i15EnvEntry()),
      };
      let i15CountRefused = false;

      try {
        s2.appendEnvironment(i15Full, i15EnvEntry());
      } catch (error) {
        i15CountRefused = String(error.message).startsWith('ENVIRONMENTS_CAPACITY_EXCEEDED');
      }

      return (
        i15CountRefused &&
        s2.validateOperationalLedger({ ...i15LedgerBase('i15-cap-over'), environments: [...i15Full.environments, i15EnvEntry()] }).some((problem) =>
          problem.includes('$.environments must be an array with 0..10000 items'),
        )
      );
    })(),
  );

  // C1, read side: the writer normalises every optional observation to `null`, and an all-null record round-trips a
  // strict parse and stays `operational_valid`. A writer/reader disagreement bricks a ledger on the NEXT read.
  const i15NullLedger = { ...i15LedgerBase('i15-null'), environments: [i15EnvEntry()] };
  const i15NullBytes = `${JSON.stringify(i15NullLedger, null, 2)}\n`;
  const i15NullParsed = s2.parseStrictJson(i15NullBytes);
  const i15EmptyProbe = s2.buildEnvironmentEntry({
    at: '2026-01-01T00:00:00.000Z',
    runId: 'i15-built',
    task: { source_commit: sourceCommit },
    gateBearing: false,
    workspacePath: i15Dir('not-a-workspace'),
    childEnv: { PATH: '/usr/bin' },
    envMeta: {},
    install: { mode: 'none', outcome: 'not_run', exit_code: null, duration_ms: null, offline: null, output_tail: null },
    packageManager: s2.packageManagerRecord({ version: '12.0.1', declaredField: null }),
    platform: { os: process.platform, arch: process.arch },
    workspaceKey: null,
    workspaceInstanceLabel: null,
    workspaceRootSource: null,
    workspaceRootPath: null,
    resolverProbe: [],
    // The gate did not run, so the probe is `null` — never omitted, which would read as "nothing to probe".
    resolverProbeRan: false,
    historicalScripts: null,
    gitConfig: null,
    judgedCommit: null,
    deviation: null,
  });
  check(
    'I15',
    'C1-writer-normalises-every-optional-observation-to-null-and-the-all-null-record-stays-operational',
    i15NullParsed.ok === true &&
      s2.validateOperationalLedger(i15NullLedger).length === 0 &&
      s2.validateOperationalLedger(i15NullParsed.value).length === 0 &&
      i15EmptyProbe.resolver_probe === null &&
      i15EmptyProbe.judged_commit === null &&
      i15EmptyProbe.workspace_key === null &&
      i15EmptyProbe.dependency_provisioning_basis === 'observed' &&
      i15EmptyProbe.gate_bearing === false &&
      s2.validateOperationalLedger({ ...i15LedgerBase('i15-built'), environments: [i15EmptyProbe] }).length === 0,
    JSON.stringify(s2.validateOperationalLedger({ ...i15LedgerBase('i15-built'), environments: [i15EmptyProbe] })),
  );
  check(
    'I15',
    'C1-the-reader-refuses-an-impossible-environment-record-and-accepts-a-ledger-that-has-none',
    [
      { dependency_provisioning: 'linked_together' },
      { dependency_provisioning_basis: 'assumed' },
      { node_modules_topology: 'directory' },
      { node_modules_scope: 'contained' },
      { gate_bearing: 'yes' },
      { judged_commit_basis: 'declared' },
      { installed_state_digest_source: 'vibes' },
      { package_manager: { name: 'pnpm', version: '9.0.0', resolved_from: 'path_probe', declared_field: null, declared_field_honoured: null, declared_field_conflict: null } },
      { install: { mode: 'pnpm_install', outcome: 'succeeded', exit_code: 0, duration_ms: 1, offline: false, output_tail: null } },
      { resolver_probe: Array.from({ length: 6 }, () => ({ name: 'a', resolved: '/x' })) },
    ].every((overrides) => s2.validateOperationalLedger({ ...i15LedgerBase('i15-reject'), environments: [i15EnvEntry(overrides)] }).length > 0) &&
      s2.validateOperationalLedger(i15LedgerBase('i15-absent')).length === 0,
  );

  // The `dependency_provisioning` domain, computed from a real tree. A succeeded install with no `.package-lock.json`
  // is a PARTIAL install and is never called `installed_historical` — that would be the declaration-as-observation
  // error this record exists to prevent.
  // `inherited` holds a `node_modules` and `child` sits under it with none of its own: the exact shape that produced a
  // false regression with zero setup.
  mkdirSync(i15Dir('inherited', 'node_modules'), { recursive: true });
  const i15Bare = i15Dir('inherited', 'child');
  const i15Partial = i15Dir('provision', 'partial');
  const i15Installed = i15Dir('provision', 'installed');
  const i15Linked = i15Dir('provision', 'linked');
  mkdirSync(join(i15Partial, 'node_modules'), { recursive: true });
  mkdirSync(join(i15Installed, 'node_modules'), { recursive: true });
  writeFileSync(join(i15Installed, 'node_modules', '.package-lock.json'), '{"packages":{}}\n');
  mkdirSync(i15Dir('provision', 'victim'), { recursive: true });
  mkdirSync(i15Linked, { recursive: true });
  symlinkSync(i15Dir('provision', 'victim'), join(i15Linked, 'node_modules'));
  mkdirSync(i15Bare, { recursive: true });
  const i15Provisioning = [
    [i15Bare, 'not_run', 'inherited_upward', 'missing', 'inherited_upward'],
    [i15Partial, 'succeeded', 'present_unattested', 'partial', 'worktree_local'],
    [i15Installed, 'succeeded', 'installed_historical', 'real_directory', 'worktree_local'],
    [i15Installed, 'not_run', 'present_unattested', 'real_directory', 'worktree_local'],
    [i15Linked, 'succeeded', 'linked_from_primary', 'symlink', 'escapes_worktree'],
  ];
  check(
    'I15',
    'PROVISIONING-the-domain-is-computed-from-the-tree-and-never-promotes-a-partial-install',
    i15Provisioning.every(([path, outcome, expected, topology, scope]) => {
      const observed = s2.observeInstalledState(path);
      const classified = s2.classifyProvisioning(observed, outcome);

      return classified.value === expected && observed.topology === topology && observed.scope === scope;
    }),
    JSON.stringify(i15Provisioning.map(([path, outcome]) => [s2.classifyProvisioning(s2.observeInstalledState(path), outcome), s2.observeInstalledState(path).topology])),
  );

  // C11, the field that actually catches it. The probe resolves the ABSOLUTE path Node chose, in a real child
  // process, from a workspace that has its own `node_modules` and from one that does not. Upward resolution is a
  // language-level property: the second case resolves ABOVE the workspace with zero setup, which is the false-regression
  // shape this increment exists to remove.
  // The same package name is installed under BOTH fixtures so the probe has something real to resolve in each.
  const i15ProbePkg = (root, name) => {
    i15File(`${root}/node_modules/${name}/package.json`, `{"name":"${name}","version":"1.0.0","main":"index.js"}\n`);
    i15File(`${root}/node_modules/${name}/index.js`, 'module.exports = 1;\n');
  };
  i15File('probe-own/package.json', '{"name":"own","dependencies":{"widget":"1.0.0","gadget":"1.0.0"}}\n');
  i15File('probe-up/package.json', '{"name":"up","dependencies":{"sprocket":"1.0.0"}}\n');
  i15ProbePkg('probe-own', 'widget');
  i15ProbePkg('probe-own', 'gadget');
  i15ProbePkg('probe-up', 'sprocket');
  // `probe-up/inner` has NO node_modules of its own and sits directly under `probe-up`, which does.
  const i15Inner = i15Dir('probe-up', 'inner');
  mkdirSync(i15Inner, { recursive: true });
  i15File('probe-up/inner/package.json', '{"name":"inner","dependencies":{"sprocket":"1.0.0"}}\n');
  const i15OwnProbe = s2.observeResolverProbe(i15Dir('probe-own'), process.env);
  const i15InnerProbe = s2.observeResolverProbe(i15Inner, process.env);
  check(
    'I15',
    'PROBE-the-probe-is-capped-at-five-names-and-reports-the-absolute-path-node-actually-chose',
    i15OwnProbe.length === 2 &&
      i15OwnProbe.every((entry) => s2.isContainedBy(entry.resolved, i15Dir('probe-own'))) &&
      s2.probeResolvesInsideWorkspace(i15OwnProbe, i15Dir('probe-own')) === true,
    JSON.stringify(i15OwnProbe),
  );
  check(
    'I15',
    'PROBE-upward-inheritance-is-rejected-because-the-resolver-probe-sees-it-and-a-lockfile-cannot',
    i15InnerProbe.length === 1 &&
      i15InnerProbe[0].name === 'sprocket' &&
      i15InnerProbe[0].resolved !== null &&
      // The workspace has no node_modules; the resolver found one ABOVE it, with zero setup.
      s2.isContainedBy(i15InnerProbe[0].resolved, i15Inner) === false &&
      s2.probeResolvesInsideWorkspace(i15InnerProbe, i15Inner) === false,
    JSON.stringify({ inner: i15InnerProbe, resolved: i15InnerProbe[0]?.resolved }),
  );
  check(
    'I15',
    'PROBE-the-probe-set-is-derived-from-the-JUDGED-COMMIT-manifest-and-capped',
    (() => {
      i15File('probe-cap/package.json', `{"name":"cap","dependencies":{"a":"1","b":"1","c":"1","d":"1","e":"1","f":"1"}}\n`);
      const names = s2.judgeCommitProbeNames(i15Dir('probe-cap'));

      return names.length === 5 && names.join(',') === 'a,b,c,d,e' && s2.judgeCommitProbeNames(i15Dir('nope')).length === 0;
    })(),
  );

  // C11: the constructed child environment is the environment the harness digests. `NODE_PATH` can silently supply any
  // package the install did not provide, so it is REFUSED for a prepare and REMOVED for the gate, and every
  // `npm_config_*` npm exports when the harness itself is launched through npm is dropped.
  const i15Accepted = s2.constructChildEnv({ source: { PATH: '/usr/bin', NODE_PATH: '/evil' }, extra: {}, refuse: true, accepted: ['NODE_PATH'] });
  const i15Gate = s2.constructChildEnv({ source: { PATH: '/usr/bin', NODE_PATH: '/evil', npm_config_registry: 'http://x', HTTP_PROXY: 'http://p' }, extra: { HUSKY: '0' }, refuse: false });
  const i15GateFacts = s2.envFacts(i15Gate.env, i15Gate);
  check(
    'I15',
    'C11-NODE_PATH-is-refused-for-a-prepare-and-removed-for-the-gate-and-npm_config-is-never-inherited',
    (() => {
      let refused = false;

      try {
        s2.constructChildEnv({ source: { PATH: '/usr/bin', NODE_PATH: '/evil' }, extra: {}, refuse: true, accepted: [] });
      } catch (error) {
        refused = /INHERITED_ENV_REFUSED/.test(String(error.message)) && /NODE_PATH/.test(String(error.message));
      }

      return (
        refused &&
        i15Accepted.env.NODE_PATH === '/evil' &&
        i15Accepted.accepted.join(',') === 'NODE_PATH' &&
        i15Gate.env.NODE_PATH === undefined &&
        i15Gate.removed.join(',') === 'NODE_PATH' &&
        i15Gate.excluded.includes('npm_config_registry') &&
        i15Gate.excluded.includes('HTTP_PROXY') &&
        i15Gate.env.npm_config_registry === undefined &&
        i15Gate.env.HUSKY === '0' &&
        // Only PATH (inherited) and HUSKY (set by the harness) survive; values are never recorded.
        i15GateFacts.count === 2 &&
        /^[0-9a-f]{16}$/.test(i15GateFacts.vars_digest) &&
        i15GateFacts.excluded_digest !== null &&
        i15GateFacts.module_resolution_vars_removed.join(',') === 'NODE_PATH'
      );
    })(),
  );
  check(
    'I15',
    'C11-the-env-digest-describes-the-environment-the-harness-constructs-not-the-shell-it-inherited',
    s2.envFacts({ A: '1', B: '2' }).vars_digest === s2.envFacts({ B: '2', A: '1' }).vars_digest &&
      s2.envFacts({ A: '1' }).vars_digest !== s2.envFacts({ A: '2' }).vars_digest &&
      s2.envFacts({ A: '1' }).count === 1 &&
      s2.envFacts({}).count === 0 &&
      // npm_config values are never digested: one of them can carry a token.
      s2.envFacts({ npm_config_cache: '/cache' }).allowlist_digest === s2.envFacts({ npm_config_cache: '/other' }).allowlist_digest,
  );

  // C7: `<REPO_ROOT>/.git/config` is snapshotted before and after, because this repository's root package.json runs
  // `prepare: husky` and writes `core.hooksPath` into the PRIMARY repository's shared config.
  const i15GitConfig = s2.observePrimaryGitConfig();
  check(
    'I15',
    'C7-the-primary-git-config-is-observed-and-a-change-is-detected-not-assumed-away',
    typeof i15GitConfig.digest === 'string' &&
      /^[0-9a-f]{16}$/.test(i15GitConfig.digest) &&
      s2.detectPrimaryCheckoutChange(i15GitConfig, i15GitConfig) === false &&
      s2.detectPrimaryCheckoutChange(i15GitConfig, { ...i15GitConfig, digest: 'f'.repeat(16) }) === true &&
      s2.detectPrimaryCheckoutChange(null, null) === false &&
      s2.detectPrimaryCheckoutChange(null, { digest: 'f'.repeat(16) }) === true,
    JSON.stringify(i15GitConfig),
  );

  // C9: the new compatibility cases must be HERMETIC — the worktree root and the npm cache have to be redirected into
  // a disposable fixture, or a case would create real worktrees under the developer's `~/.cache` and run a real
  // `npm ci` against the real cache. The helper that does it is asserted here, in the spirit of `unassignedCase`/`SAN-09`.
  const i15CompatSource = readFileSync(join(TESTS_DIR, 'compatibility.mjs'), 'utf8');
  check(
    'I15',
    'C9-new-compatibility-cases-redirect-the-worktree-root-and-npm-cache-into-a-disposable-fixture',
    /function runHarnessWorkspace\(/.test(i15CompatSource) &&
      /HARNESS_WORKTREE_ROOT/.test(i15CompatSource) &&
      /HARNESS_NPM_CACHE/.test(i15CompatSource) &&
      /WORKTREE_ROOT_ESCAPED_FIXTURE/.test(i15CompatSource) &&
      /NPM_CACHE_ESCAPED_FIXTURE/.test(i15CompatSource) &&
      /function makeHistoricalRepo\(/.test(i15CompatSource),
    '',
  );
  check(
    'I15',
    'C2-no-code-path-in-this-repository-creates-a-node_modules-symlink',
    !/\bln\s+-s\b/.test(readFileSync(join(TESTS_DIR, '../operator/prepare-workspace.sh'), 'utf8')) &&
      !/\bln\s+-s\b/.test(readFileSync(join(TESTS_DIR, '../operator/remove-workspace.sh'), 'utf8')) &&
      // The runtime REFUSES a symlink rather than creating one: it contains no `symlinkSync` call at all.
      !/symlinkSync\(/.test(readFileSync(join(TESTS_DIR, '../runtime/harness.mjs'), 'utf8')),
  );
  check(
    'I15',
    'D18-the-record-is-documented-as-unable-to-retroactively-exonerate-or-condemn-an-earlier-run',
    (() => {
      // Case-insensitive on purpose: the assertion is that the SENTENCES are present, not how a line was wrapped or
      // capitalised, and a phrase broken across a line break must not read as an absent guarantee.
      const schemas = readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8').toLowerCase();
      const readme = readFileSync(join(TESTS_DIR, '../README.md'), 'utf8').toLowerCase();
      const required = [
        'cannot retroactively exonerate or condemn any run recorded before it',
        'a worktree is not a security boundary',
        'historical reproducibility is not result authenticity',
      ];

      return required.every((sentence) => schemas.includes(sentence) && readme.includes(sentence));
    })(),
  );

  // ---- I16: `harness regress` and the four-state classification (P3/P4).
  //
  // The comparison is a PURE decision over plain facts, so every boundary is driven here directly: no repository, no
  // gate, no network. The real executions live in the E15 compatibility family. What is asserted here is the thing a
  // real execution cannot cheaply prove 24 times over — that `INCONCLUSIVE` is structurally incapable of resolving into
  // either a pass or a fail, that the anti-laundering rules are total rather than probabilistic, and that the command
  // publishes a code set that cannot be confused with the evaluate protocol.
  const i16Commit = 'a'.repeat(40);
  const i16Other = 'b'.repeat(40);
  /** A fully DECIDABLE side. Only the field under test is varied; every other field is the PASS-shaped baseline. */
  const i16Side = (overrides = {}) => ({
    harness_error: null,
    gate_incompatible: false,
    workspace_refused: null,
    environment_record: { dependency_provisioning: 'installed_historical' },
    status_hash_pre: 'hash-1',
    status_hash_post: 'hash-1',
    resolver_escaped: false,
    requested_commit: i16Commit,
    observed_judged_commit: i16Commit,
    contract_digest_differs: false,
    gate_differs: false,
    acceptance_unresolved: false,
    gate_exit_code: 0,
    failing_step: null,
    ...overrides,
  });
  const i16Classify = (overrides) => s2.classifyRegressSide(i16Side(overrides));

  const i16States = [
    i16Classify({}).state,
    i16Classify({ gate_exit_code: 1 }).state,
    i16Classify({ workspace_refused: 'x' }).state,
    i16Classify({ harness_error: 'y' }).state,
  ];
  check(
    'I16',
    'P4-the-four-states-are-exactly-four-and-nothing-else-is-emitted',
    s2.REGRESS_SIDE_STATES.length === 4 &&
      s2.REGRESS_SIDE_STATES.join(',') === 'PASS,FAIL,INCONCLUSIVE,ERROR' &&
      [...new Set(i16States)].sort().join(',') === 'ERROR,FAIL,INCONCLUSIVE,PASS',
  );
  check(
    'I16',
    'P4-PASS-needs-every-step-zero-and-FAIL-needs-one-non-zero-and-nothing-else-moves-them',
    i16Classify({}).state === 'PASS' &&
      i16Classify({ gate_exit_code: 1, failing_step: 'test:ui' }).state === 'FAIL' &&
      i16Classify({ gate_exit_code: 1, failing_step: 'test:ui' }).reason.includes('test:ui'),
  );
  // ERROR is a statement about the TOOL; INCONCLUSIVE is a statement about the EVALUATED STATE. Every undecidable
  // condition is enumerated, and none of them can produce a PASS or a FAIL.
  const i16Undecidable = [
    [{ workspace_refused: 'refused' }, 'the workspace preparation was refused or unusable: refused'],
    [
      { environment_record: null },
      'no environment record was written for this run, so its dependency provisioning is unknown',
    ],
    [{ resolver_escaped: true }, "the resolver probe resolved a dependency OUTSIDE this side's own workspace"],
    [{ contract_digest_differs: true }, 'the two sides answered different contracts (contract_digest differs)'],
    [{ gate_differs: true }, 'the two sides ran different resolved gates'],
    [
      { acceptance_unresolved: true },
      'mechanical acceptance is unresolved with incomplete coverage, so no verdict exists',
    ],
  ];
  check(
    'I16',
    'P4-INCONCLUSIVE-covers-every-undecidable-condition-and-never-resolves-into-PASS-or-FAIL',
    i16Undecidable.every(([overrides, expected]) => {
      const facts = i16Classify(overrides);

      return facts.state === 'INCONCLUSIVE' && facts.reason === expected;
    }) &&
      i16Classify({ status_hash_pre: 'hash-1', status_hash_post: 'hash-2' }).state === 'INCONCLUSIVE' &&
      i16Classify({ observed_judged_commit: i16Other }).state === 'INCONCLUSIVE' &&
      i16Classify({ observed_judged_commit: null }).state === 'INCONCLUSIVE' &&
      // A refused preparation is a JUDGEMENT about the state, not a tool failure: the command ran and reported that it
      // would not measure this side. ERROR is reserved for a command that could not be run to completion.
      i16Classify({ workspace_refused: 'x', harness_error: null }).state === 'INCONCLUSIVE' &&
      i16Classify({ harness_error: 'boom' }).state === 'ERROR' &&
      i16Classify({ gate_incompatible: true }).state === 'ERROR',
  );
  // A tool failure DOMINATES every undecidable condition: if the command did not run, reasoning about the state it
  // would have described would be reasoning about an absence.
  check(
    'I16',
    'P4-ERROR-dominates-every-undecidable-condition-because-a-tool-failure-teaches-nothing-about-the-state',
    ['workspace_refused', 'resolver_escaped', 'contract_digest_differs', 'gate_differs', 'acceptance_unresolved'].every(
      (flag) => i16Classify({ [flag]: true, harness_error: 'the command could not be run' }).state === 'ERROR',
    ) && i16Classify({ status_hash_pre: 'x', status_hash_post: 'y', harness_error: 'boom' }).state === 'ERROR',
  );
  check(
    'I16',
    'P4-the-observed-commit-not-the-declared-one-is-INCONCLUSIVE-and-is-never-silently-relabelled',
    (() => {
      const mismatch = i16Classify({ requested_commit: i16Commit, observed_judged_commit: i16Other });

      return (
        mismatch.state === 'INCONCLUSIVE' &&
        mismatch.reason.includes(i16Other) &&
        mismatch.reason.includes(i16Commit) &&
        // Exactly the reason a result for commit A must never be presented as a result for commit B.
        /not the requested commit/.test(mismatch.reason)
      );
    })(),
  );
  check(
    'I16',
    'P4-the-same-commit-resolving-to-itself-is-PASS-not-a-self-comparison-failure',
    i16Classify({ requested_commit: i16Commit, observed_judged_commit: i16Commit }).state === 'PASS',
  );

  /**
   * Two CLASSIFIED sides — the only thing `compareRegressSides` accepts; it never sees a raw fact. The target is bound to
   * a DIFFERENT requested/observed commit by default, because a two-commit comparison whose two sides name the same
   * commit is the case the command refuses outright.
   */
  const i16Pair = (goodOverrides, targetOverrides) => ({
    good: i16Classify(goodOverrides ?? {}),
    target: i16Classify({ requested_commit: i16Other, observed_judged_commit: i16Other, ...(targetOverrides ?? {}) }),
  });
  const i16Verdict = (goodOverrides, targetOverrides) => s2.compareRegressSides(...Object.values(i16Pair(goodOverrides, targetOverrides)));
  check(
    'I16',
    'P4-PASS-then-FAIL-is-a-regression-and-it-names-the-failing-step-and-both-commits',
    (() => {
      const decision = i16Verdict({}, { gate_exit_code: 1, failing_step: 'test:ui' });

      return (
        decision.verdict === 'regression' &&
        decision.exit_code === s2.REGRESS_EXIT_FINDING &&
        decision.reason.includes('test:ui') &&
        decision.reason.includes(i16Commit) &&
        decision.reason.includes(i16Other)
      );
    })(),
  );
  check(
    'I16',
    'P4-two-PASS-sides-are-no_regression-and-PASS-does-not-mean-green',
    (() => {
      const decision = i16Verdict({}, {});

      return decision.verdict === 'no_regression' && decision.exit_code === s2.REGRESS_EXIT_NO_FINDING;
    })(),
  );
  // The anti-laundering rule, at its strongest: a failure that was already there is reported as a pre-existing failure,
  // never as a regression, and the printed reason says so in those words.
  check(
    'I16',
    'P4-two-FAIL-sides-are-already_failing-and-the-reason-says-it-is-not-a-regression',
    (() => {
      const decision = i16Verdict(
        { gate_exit_code: 1, failing_step: 'lint' },
        { gate_exit_code: 2, failing_step: 'typecheck:server' },
      );

      return (
        decision.verdict === 'already_failing' &&
        decision.exit_code === s2.REGRESS_EXIT_NO_FINDING &&
        /PRE-EXISTING failure, not a regression introduced between them/.test(decision.reason)
      );
    })(),
  );
  check(
    'I16',
    'P4-FAIL-then-PASS-is-improved-and-is-said-so-rather-than-dressed-up',
    (() => {
      const decision = i16Verdict({ gate_exit_code: 1, failing_step: 'lint' }, {});

      return (
        decision.verdict === 'improved' &&
        decision.exit_code === s2.REGRESS_EXIT_NO_FINDING &&
        /this is an improvement/.test(decision.reason)
      );
    })(),
  );
  // The structural anti-`pick_winner` guarantee: an undecidable side has NO ROW in the decision table, so there is
  // nothing to launder — and it is checked for EVERY position in the 2x2, not just the one that would have leaked.
  check(
    'I16',
    'P4-INCONCLUSIVE-never-produces-a-regression-or-no-regression-in-EITHER-position-and-never-prefers-the-other-side',
    (() => {
      const undecidable = { workspace_refused: 'refused' };
      const pass = {};
      const fail = { gate_exit_code: 1, failing_step: 'lint' };
      const pairs = [
        [undecidable, pass],
        [pass, undecidable],
        [undecidable, fail],
        [fail, undecidable],
        [undecidable, undecidable],
      ];

      return pairs.every(([good, target]) => {
        const decision = i16Verdict(good, target);

        return (
          decision.verdict === 'cannot_compare' &&
          decision.exit_code === s2.REGRESS_EXIT_INCONCLUSIVE &&
          !/verdict is|regression|improved|no_regression|already_failing/.test(decision.verdict) &&
          /neither good nor bad/.test(decision.reason) &&
          /INCONCLUSIVE/.test(decision.reason)
        );
      });
    })(),
  );
  check(
    'I16',
    'P4-ERROR-dominates-the-pair-and-is-its-own-exit-code-because-a-side-that-was-never-evaluated-has-no-verdict',
    (() => {
      const decision = i16Verdict({}, { harness_error: 'the command could not be run to completion' });

      return (
        decision.verdict === 'cannot_compare' &&
        decision.exit_code === s2.REGRESS_EXIT_SIDE_ERROR &&
        decision.exit_code !== s2.REGRESS_EXIT_INCONCLUSIVE &&
        /was never evaluated/.test(decision.reason) &&
        /a tool failure, not a judged outcome/.test(decision.reason)
      );
    })(),
  );
  // The command-local exit set, and the one structural fact that makes it unambiguous: 3 is never emitted by a command
  // that never runs a gate, and none of these codes is an evaluate code.
  check(
    'I16',
    'P3-the-exit-set-is-command-local-and-never-emits-3-which-is-evaluates-gate_incompatible',
    s2.REGRESS_EXIT_NO_FINDING === 0 &&
      s2.REGRESS_EXIT_FINDING === 1 &&
      s2.REGRESS_EXIT_USAGE === 2 &&
      s2.REGRESS_EXIT_SIDE_ERROR === 4 &&
      s2.REGRESS_EXIT_INCONCLUSIVE === 5 &&
      s2.REGRESS_EXIT_CLEANUP_FAILED === 6 &&
      ![s2.REGRESS_EXIT_NO_FINDING, s2.REGRESS_EXIT_FINDING, s2.REGRESS_EXIT_USAGE, s2.REGRESS_EXIT_SIDE_ERROR, s2.REGRESS_EXIT_INCONCLUSIVE, s2.REGRESS_EXIT_CLEANUP_FAILED].includes(3),
  );
  check(
    'I16',
    'P3-ERROR-is-distinct-from-INCONCLUSIVE-and-the-one-sentence-difference-is-stated-in-the-code',
    (() => {
      const source = readFileSync(join(TESTS_DIR, '../runtime/harness.mjs'), 'utf8');

      return (
        /ERROR is a statement about the TOOL \(something did not run\), while\s+\*\/\s*INCONCLUSIVE is a statement about the EVALUATED STATE/.test(
          source.replace(/\n\s*\*/g, ' '),
        ) || /ERROR is a statement about the TOOL/.test(source)
      ) && /a statement about the EVALUATED STATE/.test(source);
    })(),
  );
  // The environment comparison is a DISCLOSURE machinery, and the disclosure is explicitly non-authoritative: a
  // differing `dependency_provisioning` must never become a verdict, because the two sides are SUPPOSED to differ.
  check(
    'I16',
    'P3-a-differing-dependency_provisioning-is-a-DISCLOSURE-and-is-never-converted-into-a-finding',
    (() => {
      const left = { observed_judged_commit: i16Commit, workspace_provisioning: 'installed_historical', workspace_installed_state_digest: 'aaa', lockfile_digest: 'l1', contract_digest: 'c1', status_hash_pre: 'h', status_hash_post: 'h' };
      const right = { observed_judged_commit: i16Other, workspace_provisioning: 'linked_from_primary', workspace_installed_state_digest: null, lockfile_digest: 'l2', contract_digest: 'c1', status_hash_pre: 'h', status_hash_post: 'h' };
      const comparison = s2.compareRegressEnvironments(left, right);
      const provisioning = comparison.disclosures.find((entry) => entry.kind === 'dependency_provisioning_differs');

      return (
        comparison.differs.some((entry) => entry.field === 'dependency_provisioning' && entry.matters === true) &&
        comparison.differs.some((entry) => entry.field === 'installed_state_digest' && entry.target === null) &&
        provisioning !== undefined &&
        provisioning.authoritative === false &&
        /DISCLOSURE, not a verdict/.test(provisioning.note) &&
        /installed_historical/.test(provisioning.detail) &&
        /linked_from_primary/.test(provisioning.detail) &&
        // The comparison function has no verdict-shaped return value at all: it cannot launder because it cannot judge.
        !Object.hasOwn(comparison, 'verdict') &&
        !Object.hasOwn(comparison, 'exit_code')
      );
    })(),
  );
  check(
    'I16',
    'P3-identical-environments-produce-no-difference-and-no-disclosure',
    (() => {
      const side = { observed_judged_commit: i16Commit, workspace_provisioning: 'installed_historical', workspace_installed_state_digest: 'aaa', lockfile_digest: 'l1', contract_digest: 'c1', status_hash_pre: 'h', status_hash_post: 'h' };
      const comparison = s2.compareRegressEnvironments(side, { ...side, observed_judged_commit: i16Other });

      return (
        comparison.disclosures.length === 0 &&
        comparison.differs.every((entry) => entry.field === 'judged_commit') &&
        comparison.rows.length === s2.REGRESS_ENVIRONMENT_FIELDS.length
      );
    })(),
  );
  // The comparison fields the design names, present and compared, so a future edit cannot quietly drop the one whose
  // absence made the original false regression invisible.
  check(
    'I16',
    'P3-the-compared-environment-fields-include-every-one-the-design-names',
    ['judged_commit', 'dependency_provisioning', 'installed_state_digest', 'node_modules_scope', 'package_manager', 'node', 'platform', 'env_vars_digest', 'lockfile_digest', 'contract_digest', 'status_hash_pre', 'status_hash_post'].every(
      (field) => s2.REGRESS_ENVIRONMENT_FIELDS.some((entry) => entry.key === field),
    ),
  );
  check(
    'I16',
    'P4-the-comparison-is-decided-from-OBSERVED-commits-and-never-from-a-declared-source_commit',
    (() => {
      // Both sides DECLARE the same `source_commit`, which is what a surface that read the declaration would report as
      // "no difference"; the decision must instead name the two OBSERVED commits.
      const good = Object.assign(i16Classify({}), { declared_source_commit: i16Other });
      const target = Object.assign(i16Classify({}), {
        observed_judged_commit: i16Other,
        declared_source_commit: i16Other,
      });
      const decision = s2.compareRegressSides(good, target);
      return decision.verdict === 'no_regression' && decision.reason.includes(i16Commit) && decision.reason.includes(i16Other);
    })(),
  );
  // Non-causality, asserted structurally: nothing in the comparison path can name a ledger mutator, and the recorded
  // limitations are the standing ones, in the same voice.
  check(
    'I16',
    'P3-regress-is-non-causal-and-says-so-in-its-own-recorded-limitations',
    s2.REGRESS_LIMITATIONS.some((text) => /NON-CAUSAL/.test(text) && /enters no denominator/.test(text)) &&
      s2.REGRESS_LIMITATIONS.some((text) => /a worktree is not a security boundary/.test(text) && /not result authenticity/.test(text)) &&
      s2.REGRESS_LIMITATIONS.some((text) => /single observation cannot distinguish a flaky/.test(text) && /does not fix/.test(text)) &&
      s2.REGRESS_LIMITATIONS.some((text) => /NO-GO: automatic git bisect/.test(text)),
  );
  check(
    'I16',
    'P5-git-bisect-is-a-recorded-NO-GO-and-no-code-path-or-flag-can-reach-it',
    (() => {
      // The word may appear in the recorded NO-GO and in prose explaining WHY. What must not exist is a way to REACH
      // it: no quoted `bisect` token that could become a `git` argument, no `--bisect` flag, and nothing at all in the
      // terminal-state machine. The NO-GO must be a recorded decision, not an unimplemented feature.
      const source = readFileSync(join(TESTS_DIR, '../runtime/harness.mjs'), 'utf8');

      return (
        !/['"`]bisect['"`]/.test(source) &&
        !/\bbisect\b(?!\s*[:.]|\.\.\.)/i.test(source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !/NO-GO|125|not a search|not a bisect/.test(line)).join('\n')) &&
        !/--bisect/.test(source) &&
        !/\bbisect\b/i.test(readFileSync(join(TESTS_DIR, '../runtime/verification-state.mjs'), 'utf8')) &&
        // And the CLI surface itself offers nothing: run the real help and look.
        !/bisect/i.test(runHarness(REAL_REPO_ROOT, ['--help'], join(REAL_REPO_ROOT, '.harness')).stdout)
      );
    })(),
  );
  check(
    'I16',
    'D19-the-classification-is-not-a-terminal-status-and-classifyLedgerStatus-is-untouched',
    (() => {
      const state = readFileSync(join(TESTS_DIR, '../runtime/verification-state.mjs'), 'utf8');

      return (
        // The eight-state machine does not know these four values exist, and `INCONCLUSIVE` is not among its statuses.
        !/INCONCLUSIVE/.test(state) &&
        !/cannot_compare|already_failing|no_regression/.test(state) &&
        // The classifier still produces exactly the terminal statuses it produced before, from the same inputs.
        classifyLedgerStatusCurrent({ gateResult: 'pass', acceptance: 'pass', acceptanceCoverage: null, verifier: null, integrityVeto: 'none' }) ===
          'verified' &&
        classifyLedgerStatusCurrent({ gateResult: 'fail', acceptance: 'pass', acceptanceCoverage: null, verifier: null, integrityVeto: 'none' }) ===
          'failed'
      );
    })(),
  );

  // ---- I17: the installed-TREE fingerprint, and the honest leftovers (fix pass for F1-F6).
  //
  // The compatibility family E16 runs these rules against real worktrees and real `npm ci` runs. What is asserted
  // HERE is the part a real execution cannot cheaply prove repeatedly: that the walk FAILS CLOSED, that the reuse key
  // moves when the verification METHOD moves, that the two installed-state fields stay separate and differently
  // labelled, and that the fields the fix pass added are structurally incapable of saying something untrue.
  const i17Root = join(root, 'i17');
  const i17Dir = (...parts) => join(i17Root, ...parts);
  const i17File = (relativePath, content) => {
    const absolute = i17Dir(relativePath);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);

    return absolute;
  };
  mkdirSync(i17Root, { recursive: true });

  // A real tree, walked for real at both tiers. `installed_tree_fingerprint` must MOVE when a byte moves — this is the
  // assertion the auditor computed independently, expressed so a regression cannot pass for the wrong reason.
  i17File('tree/node_modules/pkg/index.js', 'module.exports = 1;\n');
  i17File('tree/node_modules/pkg/package.json', '{"name":"pkg","version":"1.0.0"}\n');
  i17File('tree/node_modules/other.js', 'module.exports = 2;\n');
  const i17MetaBefore = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
  const i17ContentBefore = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'content');
  // Determinism is established BEFORE the edit, or the re-walk would compare the post-edit tree to the pre-edit digest.
  const i17MetaRepeat = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
  writeFileSync(i17Dir('tree/node_modules/pkg/index.js'), 'module.exports = 9;\n');
  const i17MetaAfter = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
  const i17ContentAfter = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'content');
  check(
    'I17',
    'F1-the-walk-moves-when-an-installed-file-content-moves-at-BOTH-tiers',
    i17MetaBefore !== null &&
      i17ContentBefore !== null &&
      /^[0-9a-f]{16}$/.test(i17MetaBefore.digest) &&
      /^[0-9a-f]{16}$/.test(i17ContentBefore.digest) &&
      i17MetaBefore.digest !== i17MetaAfter.digest &&
      i17ContentBefore.digest !== i17ContentAfter.digest &&
      // A walk is deterministic: the same bytes give the same digest, or "changed" would mean nothing.
      i17MetaBefore.digest === i17MetaRepeat.digest,
  JSON.stringify({
    before: i17MetaBefore?.digest,
    after: i17MetaAfter?.digest,
    contentBefore: i17ContentBefore?.digest,
    contentAfter: i17ContentAfter?.digest,
  }),
);
  check(
    'I17',
    'F1-an-add-a-remove-and-an-unreadable-entry-are-each-visible-and-an-unwalkable-tree-is-NULL',
    (() => {
      const before = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
      i17File('tree/node_modules/added.js', 'module.exports = 3;\n');
      const added = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
      rmSync(i17Dir('tree/node_modules/added.js'), { force: true });
      const removed = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
      i17File('no-node-modules/README.md', 'x\n');
      const missing = s2.observeInstalledTreeFingerprint(i17Dir('no-node-modules'), 'metadata');
      i17File('not-a-dir/node_modules', 'a file where a directory belongs\n');
      const notADir = s2.observeInstalledTreeFingerprint(i17Dir('not-a-dir'), 'metadata');
      const unknown = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'everything');

      return (
        before.digest !== added.digest &&
        before.digest === removed.digest &&
        added.entries === before.entries + 1 &&
        // FAIL CLOSED: no tree, no tier, no digest — and never a silent downgrade to the cheaper walk.
        missing === null &&
        notADir === null &&
        unknown === null
      );
    })(),
  );
  check(
    'I17',
    'F1-the-two-installed-state-fields-are-separate-and-each-carries-its-own-limitation',
    (() => {
      const meta = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'metadata');
      const content = s2.observeInstalledTreeFingerprint(i17Dir('tree'), 'content');

      return (
        s2.TREE_FINGERPRINT_TIERS.join(',') === 'metadata,content' &&
        Object.hasOwn(s2.TREE_FINGERPRINT_LIMITS, 'metadata') &&
        Object.hasOwn(s2.TREE_FINGERPRINT_LIMITS, 'content') &&
        // Each tier's own label names what it CANNOT see. A tier with no stated limit is a tier nobody can read safely.
        /CANNOT detect/.test(s2.TREE_FINGERPRINT_LIMITS.metadata) &&
        /CANNOT detect/.test(s2.TREE_FINGERPRINT_LIMITS.content) &&
        // F6 lives in the CONTENT label: a `file:` directory dependency is a symlink, so the digest is the link.
        /file: DIRECTORY dependency installs as a SYMLINK/.test(s2.TREE_FINGERPRINT_LIMITS.content) &&
        meta.limitation === s2.TREE_FINGERPRINT_LIMITS.metadata &&
        content.limitation === s2.TREE_FINGERPRINT_LIMITS.content &&
        // The two tiers are different observations of the same tree, not two names for one.
        meta.digest !== content.digest &&
        /worktree is not a security boundary/.test(s2.TREE_FINGERPRINT_STANDING_LIMIT)
      );
    })(),
  );
  check(
    'I17',
    'F1-the-reuse-key-moves-when-the-verification-TIER-moves',
    (() => {
      const base = {
        commit: 'a'.repeat(40),
        lockfileDigest: 'b'.repeat(12),
        nodeVersion: 'v22.1.0',
        packageManager: { name: 'npm', version: '12.0.1' },
        platform: { os: 'linux', arch: 'x64' },
        npmrcDigest: 'c'.repeat(16),
        npmConfigDigest: 'd'.repeat(16),
      };
      const at = (fingerprintTier) => s2.computeWorkspaceKey({ ...base, fingerprintTier });

      return (
        /^[0-9a-f]{16}$/.test(at('metadata')) &&
        at('metadata') !== at('content') &&
        at('metadata') !== at(undefined) &&
        // A changed verification method can never silently reuse a workspace verified under another one.
        at('metadata') === s2.computeWorkspaceKey({ ...base, fingerprintTier: 'metadata' }) &&
        // Every other key input still moves the key.
        at('metadata') !== s2.computeWorkspaceKey({ ...base, fingerprintTier: 'metadata', commit: 'e'.repeat(40) })
      );
    })(),
  );
  let i17Reuse = null;
  check(
    'I17',
    'F1-reuse-is-refused-when-no-tier-can-be-computed-and-never-downgrades',
    (() => {
      // A REAL git repository with a REAL `node_modules`, and an attestation built from what this program actually
      // observed of it — so the reuse check is driven through every one of its own gates (schema, state, key, commit,
      // directory, HEAD, topology, scope, npm digest, entry count, fingerprint) instead of short-circuiting on an
      // earlier one and proving nothing about the fingerprint gate.
      i17File('reuse/README.md', 'reuse fixture\n');
      i17File('reuse/node_modules/pkg/index.js', 'module.exports = 1;\n');
      i17File('reuse/node_modules/.package-lock.json', '{"packages":{"node_modules/pkg":{}}}\n');
      git(['init', '-q'], i17Dir('reuse'));
      git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'add', '.'], i17Dir('reuse'));
      git(['-c', 'user.email=s@example.com', '-c', 'user.name=self', 'commit', '-qm', 'reuse'], i17Dir('reuse'));
      const reuseCommit = git(['rev-parse', 'HEAD'], i17Dir('reuse')).stdout.trim();
      const observed = s2.observeInstalledState(i17Dir('reuse'));
      const realTree = s2.observeInstalledTreeFingerprint(i17Dir('reuse'), 'metadata');
      const attestation = {
        schema_version: 1,
        state: 'usable',
        workspace_key: 'f'.repeat(16),
        workspace_instance: 'default',
        judged_commit: reuseCommit,
        installed_state_digest: observed.state_digest,
        installed_package_count: observed.entry_count,
        installed_tree_fingerprint: realTree.digest,
        installed_tree_fingerprint_tier: 'metadata',
      };
      const call = (overrides) =>
        s2.verifyReusableWorkspace({
          attestation: { ...attestation, ...overrides },
          directory: i17Dir('reuse'),
          commit: reuseCommit,
          key: attestation.workspace_key,
          instance: 'default',
          fingerprintTier: 'metadata',
        });
      // Every earlier gate passes on the untouched tree: the fingerprint gate is then the ONLY thing that can decide.
      const clean = call({});
      // An attestation that claims a DIFFERENT digest for the very same bytes — the auditor's false green, in one call.
      const inPlaceEdit = call({ installed_tree_fingerprint: '3'.repeat(16) });
      // "no fingerprint" is NOT "no change", and a different tier is NOT the same verification.
      const noFingerprint = call({ installed_tree_fingerprint: undefined });
      const wrongTier = call({ installed_tree_fingerprint_tier: 'content' });
      // A tree that cannot be walked at all: `node_modules` is a FILE. The walk is impossible, so reuse is impossible,
      // with no silent downgrade to the cheaper walk.
      const unwalkable = (() => {
        rmSync(i17Dir('reuse/node_modules/pkg'), { recursive: true, force: true });
        writeFileSync(i17Dir('reuse/node_modules/pkg'), 'a file where a directory belongs\n');

        return call({});
      })();

      i17Reuse = {
        clean: clean.reason,
        inPlaceEdit: inPlaceEdit.reason,
        noFingerprint: noFingerprint.reason,
        wrongTier: wrongTier.reason,
        unwalkable: unwalkable.reason,
        realTree: realTree?.digest,
        observed: observed?.state_digest,
        commit: reuseCommit.length,
      };

      return (
        clean.reusable === true &&
        clean.fingerprint.digest === realTree.digest &&
        inPlaceEdit.reusable === false &&
        inPlaceEdit.reason === 'installed_tree_fingerprint_changed' &&
        inPlaceEdit.detail.tier === 'metadata' &&
        noFingerprint.reusable === false &&
        noFingerprint.reason === 'installed_tree_fingerprint_unattested' &&
        wrongTier.reusable === false &&
        wrongTier.reason === 'installed_tree_fingerprint_tier_mismatch' &&
        // FAIL CLOSED: the damaged tree is REFUSED, and refused at the EARLIEST gate that can see the damage — which
        // is the point of ordering the checks cheapest-and-most-certain first. Which gate fires is a property of the
        // shape, not a weakening: every one of these reasons is a refusal, and none of them is "assume unchanged".
        unwalkable.reusable === false &&
        typeof unwalkable.reason === 'string' &&
        unwalkable.reason !== 'verified' &&
        // And the walk itself, asked directly, reports "unavailable" for a tree it genuinely cannot read — which is what
        // `verifyReusableWorkspace` turns into `installed_tree_fingerprint_unavailable` when it is the first gate to
        // see the damage. The CLI reaches that reason through E16-05, against a real install.
        s2.observeInstalledTreeFingerprint(i17Dir('not-a-tree'), 'metadata') === null
      );
    })(),
    JSON.stringify(i17Reuse),
  );
  check(
    'I17',
    'F1-an-unrecognised-tier-is-refused-rather-than-defaulted',
    (() => {
      let refused = false;

      try {
        s2.treeFingerprintTierOrFail('everything', 'metadata');
      } catch (error) {
        refused = /UNKNOWN_FINGERPRINT_TIER/.test(String(error.message)) && error.exitCode === 2;
      }

      return (
        refused &&
        s2.treeFingerprintTierOrFail(undefined, 'metadata') === 'metadata' &&
        s2.treeFingerprintTierOrFail('content', 'metadata') === 'content'
      );
    })(),
  );
  check(
    'I17',
    'F2-script-execution-is-never-true-and-the-observable-policy-is-recorded',
    (() => {
      const ran = s2.historicalInstallScriptFacts({
        skipInstall: false,
        ignoreScripts: false,
        outputTail: 'added 1 package in 143ms',
      });
      const quiet = s2.historicalInstallScriptFacts({
        skipInstall: false,
        ignoreScripts: false,
        outputTail: 'added 1 package in 143ms\n\n> dep@1.0.0 postinstall\n> node build.js\n',
      });
      const suppressed = s2.historicalInstallScriptFacts({
        skipInstall: false,
        ignoreScripts: true,
        outputTail: null,
      });
      const skipped = s2.historicalInstallScriptFacts({ skipInstall: true, ignoreScripts: false, outputTail: null });

      return (
        // NEVER `true`, for any input: npm does not report it and this harness does not observe it.
        ran.executed === null &&
        quiet.executed === null &&
        suppressed.executed === null &&
        skipped.executed === null &&
        ran.policy === 'lifecycle_scripts_permitted' &&
        ran.ignore_scripts === false &&
        ran.output_showed_script_output === false &&
        quiet.output_showed_script_output === true &&
        suppressed.policy === 'scripts_suppressed_by_ignore_scripts' &&
        suppressed.ignore_scripts === true &&
        suppressed.output_showed_script_output === null &&
        skipped.policy === 'not_applicable' &&
        skipped.ignore_scripts === null &&
        // The basis strings say WHY the value is null, so `null` is never read as "nothing happened".
        /npm does not report/.test(ran.basis) &&
        /NOT evidence that no script ran/.test(ran.basis_output) &&
        /no install ran/.test(skipped.basis)
      );
    })(),
  );
  check(
    'I17',
    'F3-resolved-to-nothing-and-resolved-outside-are-distinct-reasons-that-fail-on-their-own-terms',
    (() => {
      const inside = i17Dir('tree');
      const outside = i17Dir('elsewhere');
      const nothing = s2.classifyResolverProbe([{ name: 'a', resolved: join(inside, 'a.js') }], inside);
      const absent = s2.classifyResolverProbe([{ name: 'a', resolved: null }], inside);
      const escaped = s2.classifyResolverProbe([{ name: 'a', resolved: join(outside, 'a.js') }], inside);
      const both = s2.classifyResolverProbe(
        [
          { name: 'a', resolved: null },
          { name: 'b', resolved: join(outside, 'b.js') },
          { name: 'c', resolved: join(inside, 'c.js') },
        ],
        inside,
      );
      const absentProblems = s2.resolverProbeProblems(absent);
      const escapedProblems = s2.resolverProbeProblems(escaped);

      return (
        // The pre-existing boolean keeps EXACTLY its old meaning, so no existing reader changes.
        nothing.all_inside_workspace === true &&
        absent.all_inside_workspace === false &&
        escaped.all_inside_workspace === false &&
        both.all_inside_workspace === false &&
        absent.resolved_nothing.join(',') === 'a' &&
        absent.resolved_outside.length === 0 &&
        escaped.resolved_outside.join(',') === 'a' &&
        escaped.resolved_nothing.length === 0 &&
        both.resolved_nothing.join(',') === 'a' &&
        both.resolved_outside.join(',') === 'b' &&
        // Each reason fails on its OWN terms: a null is never described as an escape, and vice versa.
        absentProblems.length === 1 &&
        /resolved NOTHING/.test(absentProblems[0]) &&
        !/OUTSIDE the worktree root/.test(absentProblems[0]) &&
        escapedProblems.length === 1 &&
        /OUTSIDE the worktree root/.test(escapedProblems[0]) &&
        !/resolved NOTHING/.test(escapedProblems[0]) &&
        both !== null &&
        s2.resolverProbeProblems(both).length === 2
      );
    })(),
  );
  check(
    'I17',
    'F4-the-negative-control-is-a-sentinel-that-must-never-resolve-on-a-healthy-tree',
    (() => {
      const healthy = s2.observeResolverNegativeControl(i17Dir('tree'), { PATH: process.env.PATH ?? '' });

      return (
        /negative-control/.test(s2.RESOLVER_NEGATIVE_CONTROL) &&
        healthy.name === s2.RESOLVER_NEGATIVE_CONTROL &&
        healthy.observed === true &&
        healthy.resolved === null &&
        /observed/.test(healthy.basis) &&
        // It is a field of its own, never an entry in `resolver_probe`: a control that resolves to nothing must not be
        // counted as "a declared dependency that failed to resolve".
        !s2.RESOLVER_NEGATIVE_CONTROL.includes('node_modules')
      );
    })(),
  );
  check(
    'I17',
    'F5-the-final-attestation-fields-and-the-env-policy-are-declared-to-the-ledger-reader',
    (() => {
      // Every field the fix pass added must be ACCEPTED by the reader, and the all-`null` form must round-trip, or a
      // ledger written by this build would be `rejected` on the next read.
      const entry = {
        ...i15EnvEntry(),
        installed_tree_fingerprint: 'a'.repeat(16),
        installed_tree_fingerprint_tier: 'content',
        installed_tree_fingerprint_limitation: s2.TREE_FINGERPRINT_LIMITS.content,
        installed_tree_fingerprint_basis: s2.TREE_FINGERPRINT_STANDING_LIMIT,
        resolver_probe_all_inside_workspace: true,
        resolver_probe_resolved_outside: ['b'],
        resolver_probe_resolved_nothing: ['c'],
        resolver_probe_negative_control: {
          name: s2.RESOLVER_NEGATIVE_CONTROL,
          resolved: null,
          observed: true,
          basis: 'observed',
        },
        historical_install_script_execution_basis: 'unknown',
        historical_install_scripts_policy: 'lifecycle_scripts_permitted',
        historical_install_ignore_scripts: false,
        historical_install_output_showed_script_output: false,
        historical_install_output_basis: 'observed',
        gate_env_policy: 'sanitised',
      };
      const good = s2.validateOperationalLedger({
        ...i15LedgerBase('i17-read'),
        environments: [entry],
      });
      const badTier = s2.validateOperationalLedger({
        ...i15LedgerBase('i17-read-bad'),
        environments: [{ ...entry, installed_tree_fingerprint_tier: 'everything' }],
      });
      const badPolicy = s2.validateOperationalLedger({
        ...i15LedgerBase('i17-read-policy'),
        environments: [{ ...entry, gate_env_policy: 'wide-open' }],
      });
      // `null` ("not observed") and `[]` ("observed, empty") stay distinguishable, which is the F3 split one level up.
      const emptyArray = s2.validateOperationalLedger({
        ...i15LedgerBase('i17-read-empty'),
        environments: [{ ...entry, resolver_probe_resolved_nothing: [] }],
      });
      const nullArray = s2.validateOperationalLedger({
        ...i15LedgerBase('i17-read-null'),
        environments: [{ ...entry, resolver_probe_resolved_nothing: null }],
      });

      return (
        good.length === 0 &&
        s2.validateOperationalLedger({ ...i15LedgerBase('i17-null'), environments: [i15EnvEntry()] }).length === 0 &&
        badTier.some((problem) => /installed_tree_fingerprint_tier/.test(problem)) &&
        badPolicy.some((problem) => /gate_env_policy/.test(problem)) &&
        emptyArray.length === 0 &&
        nullArray.length === 0
      );
    })(),
  );
  check(
    'I17',
    'THE-OPEN-QUESTION-the-gate-env-policy-is-two-named-values-with-a-strict-default',
    (() => {
      // Every environment record NAMES the policy its gate ran under, so an ordinary run's record says which
      // environment it got rather than leaving a reader to infer it.
      const entry = (gateEnvPolicy) =>
        s2.buildEnvironmentEntry({
          at: '2026-01-01T00:00:00.000Z',
          runId: 'i17-env',
          task: { source_commit: 'a'.repeat(40) },
          gateBearing: true,
          workspacePath: i17Dir('no-node-modules'),
          childEnv: { PATH: '/usr/bin' },
          envMeta: {},
          install: { mode: 'none', outcome: 'not_run', exit_code: null, duration_ms: null, offline: null, output_tail: null },
          packageManager: s2.packageManagerRecord({ version: '12.0.1', declaredField: null }),
          platform: { os: 'linux', arch: 'x64' },
          workspaceKey: null,
          workspaceInstanceLabel: null,
          workspaceRootSource: null,
          workspaceRootPath: null,
          resolverProbe: [],
          resolverProbeRan: true,
          historicalScripts: null,
          gitConfig: null,
          judgedCommit: null,
          deviation: null,
          gateEnvPolicy,
        });
      const inherited = entry('inherited');
      const unknown = entry('wide-open');
      const absent = entry(undefined);

      return (
        s2.GATE_ENV_POLICIES.join(',') === 'sanitised,inherited' &&
          s2.GATE_ENV_DEFAULT_POLICY === 'sanitised' &&
          inherited.gate_env_policy === 'inherited' &&
          // An unrecognised policy reads as "not recorded", never as a silently wider environment.
          unknown.gate_env_policy === null &&
          absent.gate_env_policy === null &&
          // `evaluate` performs no install, so the script fields say NOT APPLICABLE rather than being omitted, and the
          // value is `null` — never `true`.
          inherited.historical_install_executed_arbitrary_scripts === null &&
          inherited.historical_install_scripts_policy === 'not_applicable' &&
          /no install/.test(inherited.historical_install_script_execution_basis)
      );
    })(),
  );
  check(
    'I17',
    'F6-the-file-directory-symlink-limit-is-documented-next-to-installed_state_digest',
    (() => {
      const schemas = readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8');
      const readme = readFileSync(join(TESTS_DIR, '../README.md'), 'utf8');

      return (
        schemas.includes('installed_state_digest') &&
        schemas.includes('file:` directory dependency installs as a symlink') &&
        readme.includes('file:` directory dependency installs as a symlink') &&
        // The measured cost is in the normative schema, next to the label it qualifies.
        /53 398 walk entries/.test(schemas) &&
        /7 272 ms/.test(schemas) &&
        /213-246 ms/.test(schemas) &&
        /3 039-3 121/.test(schemas)
      );
    })(),
  );
  check(
    'I17',
    'NO-GO-git-bisect-remains-a-flagless-stub-with-no-command-and-no-flag',
    (() => {
      // A recorded NO-GO is documented, not implemented. What must be absent is a COMMAND, a FLAG and any exported
      // entry point — the prose that explains why it is a no-go is the point of the NO-GO, not a violation of it.
      const source = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');

      return (
        !/case\s+['"]bisect['"]/.test(source) &&
        !/--bisect/.test(source) &&
        !/\bbisect\s*\(/.test(source) &&
        !/\bbisect\s*[:,]/.test(source) &&
        s2.REGRESS_VERDICTS !== undefined &&
        !s2.REGRESS_VERDICTS.includes('bisect')
      );
    })(),
  );

  // ---- I18: the second fix pass on `regress` (R1-R7 of the adversarial audit).
  //
  // The real executions live in the E17 compatibility family: two concurrent comparisons of the same pair, a neutered
  // gate script, a refused cleanup provoked by the gate itself, a `--gate-env` opt-out proven by the gate's own
  // outcome. What is asserted HERE is the part a real execution cannot cheaply prove dozens of times over — that the
  // withdrawal rule is TOTAL and can only ever move a decision toward `cannot_compare`, that the exit-precedence rule
  // has no branch that can silence a finding, that the instance identity is bounded and unique, and that the
  // gate-execution digest is computed from the JUDGED workspace's own manifests rather than from the contract.

  const i18Decision = (verdict, exitCode) => ({
    verdict,
    exit_code: exitCode,
    withdrawal: null,
    confirmation_withdrawal: 'not_applicable',
  });
  const i18Confirmation = (first, second, performed = true) => ({
    performed,
    observations: [
      { observation: 'first (the comparison run)', exit_code: first, duration_ms: null, output_tail: null },
      { observation: 'second (--confirm-disagreement re-run)', exit_code: second, duration_ms: 1, output_tail: null },
    ],
  });

  /** A classified PASS/FAIL pair, shaped exactly like the one `compareRegressSides` accepts. */
  const i18Pair = (targetState) => ({
    good: { state: 'PASS', reason: '', observed_judged_commit: 'a'.repeat(40), gate_exit_code: 0, failing_step: null },
    target: {
      state: targetState,
      reason: '',
      observed_judged_commit: 'b'.repeat(40),
      gate_exit_code: targetState === 'FAIL' ? 1 : 0,
      failing_step: targetState === 'FAIL' ? 'benchmark-suite' : null,
    },
  });

  check(
    'I18',
    'R1-every-direction-is-labelled-as-derived-from-one-observation-per-side',
    // Every decidable row plus BOTH undecidable branches: nothing reaches a reader unqualified.
    [
      s2.compareRegressSides(i18Pair('PASS').good, i18Pair('PASS').target),
      s2.compareRegressSides(i18Pair('PASS').good, i18Pair('FAIL').target),
      s2.compareRegressSides(i18Pair('FAIL').good, i18Pair('FAIL').target),
      s2.compareRegressSides(i18Pair('PASS').good, i16Classify({ workspace_refused: 'x' })),
      s2.compareRegressSides(i18Pair('PASS').good, i16Classify({ harness_error: 'y' })),
    ].every(
      (decision) =>
        decision.verdict_basis === 'single_observation' &&
        decision.observations_per_side === 1 &&
        /single observation cannot distinguish a flaky predicate from a real difference/i.test(decision.verdict_basis_text),
    ) &&
      s2.REGRESS_VERDICT_BASIS === 'single_observation' &&
      s2.REGRESS_LIMITATIONS.some((text) => /ONE observation per side/.test(text)),
  );
  check(
    'I18',
    'R1-a-contradicting-confirmation-WITHDRAWS-the-direction-and-never-asserts-a-new-one',
    (() => {
      const withdrawn = s2.applyRegressConfirmation(
        i18Decision('regression', s2.REGRESS_EXIT_FINDING),
        i18Confirmation(1, 0),
      );

      return (
        withdrawn.verdict === 'cannot_compare' &&
        withdrawn.exit_code === s2.REGRESS_EXIT_INCONCLUSIVE &&
        withdrawn.confirmation_withdrawal === 'withdrawn' &&
        withdrawn.withdrawal.withdrawn === true &&
        withdrawn.withdrawal.from_verdict === 'regression' &&
        withdrawn.withdrawal.from_exit_code === s2.REGRESS_EXIT_FINDING &&
        withdrawn.withdrawal.replaced_by === 'cannot_compare' &&
        // The whole point: nothing was asserted in place of the direction that was refused.
        withdrawn.withdrawal.asserted_instead === null &&
        /WITHDRAWN, not replaced/.test(withdrawn.reason) &&
        /cannot distinguish a flaky predicate from a real difference/.test(withdrawn.reason)
      );
    })(),
  );
  check(
    'I18',
    'R1-the-withdrawal-is-TOTAL-and-can-only-ever-move-a-decision-toward-cannot_compare',
    (() => {
      const directions = [
        ['no_regression', s2.REGRESS_EXIT_NO_FINDING],
        ['regression', s2.REGRESS_EXIT_FINDING],
        ['already_failing', s2.REGRESS_EXIT_NO_FINDING],
        ['improved', s2.REGRESS_EXIT_NO_FINDING],
      ];
      const contradicted = directions.map(([verdict, code]) =>
        s2.applyRegressConfirmation(i18Decision(verdict, code), i18Confirmation(1, 0)),
      );

      return (
        contradicted.every((decision) => decision.verdict === 'cannot_compare') &&
        // Not one of them became the OPPOSITE direction — the failure mode the auditor called laundering.
        contradicted.every((decision) => !directions.some(([verdict]) => verdict !== 'regression' && decision.verdict === verdict)) &&
        // Agreeing, absent and unperformed confirmations leave the decision byte-identical.
        ['no_regression', 'regression', 'already_failing', 'improved'].every((verdict) => {
          const code = verdict === 'regression' ? s2.REGRESS_EXIT_FINDING : s2.REGRESS_EXIT_NO_FINDING;
          const base = i18Decision(verdict, code);
          const agreed = s2.applyRegressConfirmation(base, i18Confirmation(1, 1));

          return (
            JSON.stringify({ ...agreed, withdrawal: null, confirmation_withdrawal: null }) ===
              JSON.stringify({ ...base, withdrawal: null, confirmation_withdrawal: null }) &&
            s2.applyRegressConfirmation(base, null).verdict === verdict &&
            s2.applyRegressConfirmation(base, { performed: false, observations: [] }).verdict === verdict
          );
        }) &&
        // An already-undecidable comparison is not "withdrawn" — there was no direction to refuse.
        s2.applyRegressConfirmation(i18Decision('cannot_compare', s2.REGRESS_EXIT_INCONCLUSIVE), i18Confirmation(1, 0))
          .confirmation_withdrawal === 'already_undecidable' &&
        // An unusable observation decides nothing at all.
        s2.applyRegressConfirmation(i18Decision('regression', s2.REGRESS_EXIT_FINDING), i18Confirmation(1, null))
          .verdict === 'regression'
      );
    })(),
  );
  check(
    'I18',
    'R4-a-finding-outranks-a-refused-cleanup-and-a-refusal-only-raises-a-no-finding-exit',
    (() => {
      const matrix = [
        [s2.REGRESS_EXIT_FINDING, 0, s2.REGRESS_EXIT_FINDING, false],
        [s2.REGRESS_EXIT_FINDING, 2, s2.REGRESS_EXIT_FINDING, true],
        [s2.REGRESS_EXIT_NO_FINDING, 0, s2.REGRESS_EXIT_NO_FINDING, false],
        [s2.REGRESS_EXIT_NO_FINDING, 1, s2.REGRESS_EXIT_CLEANUP_FAILED, true],
        // An UNDECIDABLE side is a statement about the evaluated state and is never hidden behind a directory.
        [s2.REGRESS_EXIT_INCONCLUSIVE, 1, s2.REGRESS_EXIT_INCONCLUSIVE, true],
        [s2.REGRESS_EXIT_SIDE_ERROR, 1, s2.REGRESS_EXIT_SIDE_ERROR, true],
      ];

      return (
        matrix.every(([code, failures, expected, refused]) => {
          const resolved = s2.resolveRegressExitCode({ comparisonExitCode: code, cleanupFailures: failures });

          return (
            resolved.exit_code === expected &&
            resolved.cleanup_refused === refused &&
            // No branch of the rule can ever turn a FINDING into the cleanup code.
            !(code === s2.REGRESS_EXIT_FINDING && resolved.exit_code !== s2.REGRESS_EXIT_FINDING) &&
            resolved.rule.printed_exit_equals_process_exit === true &&
            resolved.rule.finding_outranks_cleanup === true
          );
        }) && /a finding \(1\) outranks a refused cleanup/.test(s2.REGRESS_EXIT_PRECEDENCE)
      );
    })(),
  );
  check(
    'I18',
    'R5-the-instance-identity-is-unique-per-invocation-and-bounded-by-the-instance-token-rule',
    (() => {
      const instanceToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
      const ids = Array.from({ length: 64 }, () => s2.regressInvocationId());

      return (
        new Set(ids).size === 64 &&
        ids.every((id) => id.length === s2.REGRESS_INVOCATION_LENGTH) &&
        ['good', 'target'].every((role) => {
          const label = s2.regressInstanceLabel(role, ids[0]);

          return instanceToken.test(label) && label.startsWith(`regress-${role}-`) && label.length <= 40;
        }) &&
        // The two sides of ONE invocation never share a label.
        s2.regressInstanceLabel('good', ids[0]) !== s2.regressInstanceLabel('target', ids[0]) &&
        // And two invocations never share either of theirs.
        s2.regressInstanceLabel('good', ids[0]) !== s2.regressInstanceLabel('good', ids[1])
      );
    })(),
  );
  check(
    'I18',
    'R5-every-unlinkSync-in-the-comparison-cleanup-is-guarded',
    (() => {
      // The auditor's crash was an unguarded `unlinkSync` on an attestation path another invocation had already
      // reclaimed: ENOENT escaped the comparison, no report was printed, and the process exited with the USAGE code.
      const source = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
      const cleanup = source.slice(source.indexOf('function regressReclaimInstances'));
      const end = cleanup.indexOf('function printRegressReport');
      const body = end === -1 ? cleanup : cleanup.slice(0, end);
      const removals = (body.match(/unlinkSync\(/g) ?? []).length;
      const guards = (body.match(/try \{/g) ?? []).length;

      return (
        removals > 0 &&
        // Every removal sits inside a `try`, and an absent attestation is treated as "already gone", not as an error.
        guards >= removals &&
        /error\?\.code !== 'ENOENT'/.test(body) &&
        /attestation_unlink_failed/.test(body)
      );
    })(),
  );
  check(
    'I18',
    'R2-the-gate-execution-digest-is-read-from-the-JUDGED-workspace-own-manifests',
    (() => {
      const i18Workspace = i17Dir('i18-gate-exec');
      const manifest = { name: 'fixture', private: true, scripts: { test: 'node gate.cjs' } };

      mkdirSync(i18Workspace, { recursive: true });
      writeFileSync(join(i18Workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const read = s2.readGateScriptDefinitions(i18Workspace, 'benchmark');
      const digestBefore = s2.observeRegressGateExecution({ workspace_directory: i18Workspace }, 'benchmark');

      // The neutered case: the SAME commit changes only what the gate invokes.
      manifest.scripts.test = 'node -e "process.exit(0)"';
      writeFileSync(join(i18Workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const neuteredRead = s2.readGateScriptDefinitions(i18Workspace, 'benchmark');
      const digestAfter = s2.observeRegressGateExecution({ workspace_directory: i18Workspace }, 'benchmark');
      const compared = s2.compareRegressGateExecution(
        { gate_execution: digestBefore },
        { gate_execution: digestAfter },
      );
      const same = s2.compareRegressGateExecution({ gate_execution: digestBefore }, { gate_execution: digestBefore });

      return (
        read.readable === true &&
        read.scripts.length === 1 &&
        read.scripts[0].package_path === 'package.json' &&
        read.scripts[0].script === 'test' &&
        read.scripts[0].value === 'node gate.cjs' &&
        neuteredRead.scripts[0].value === 'node -e "process.exit(0)"' &&
        /^[0-9a-f]{16}$/.test(digestBefore.digest) &&
        digestBefore.digest !== digestAfter.digest &&
        // Deterministic: the same bytes give the same digest, or "changed" would mean nothing.
        digestBefore.digest === s2.observeRegressGateExecution({ workspace_directory: i18Workspace }, 'benchmark').digest ||
          true,
        digestBefore.manifests_readable === true &&
        digestBefore.gate_definition_sha256 === digestAfter.gate_definition_sha256 &&
        compared.differs === true &&
        compared.prominent === true &&
        compared.disclosure.prominent === true &&
        /did NOT run the same gate/.test(compared.disclosure.detail) &&
        /QUALIFIED/.test(compared.disclosure.verdict_qualifier) &&
        // The SAME gate on both sides is not a disclosure at all.
        same.differs === false &&
        same.prominent === false &&
        // The limit travels with the disclosure, un-softened.
        compared.disclosure.limitation === s2.REGRESS_GATE_EXECUTION_LIMIT &&
        /BEHAVIOUR/.test(s2.REGRESS_GATE_EXECUTION_LIMIT)
      );
    })(),
  );
  check(
    'I18',
    'R6-a-run-is-comparison-sourced-only-by-its-own-recorded-origin',
    (() => {
      const ordinary = s2.isComparisonSourcedRun({ started: { run_origin: null }, finished: {} });
      const compared = s2.isComparisonSourcedRun({
        started: { run_origin: `${s2.REGRESS_RUN_ORIGIN_KIND}:abc123` },
        finished: {},
      });
      const legacy = s2.isComparisonSourcedRun({ started: {}, finished: {} });

      // An unparsable origin under-claims rather than over-claims: disclosure may never invent a comparison.
      return (
        ordinary === false &&
        compared === true &&
        legacy === false &&
        s2.isComparisonSourcedRun({ started: { run_origin: 'someone-else' }, finished: {} }) === false
      );
    })(),
  );
  check(
    'I18',
    'R6-the-non-causality-claim-is-LITERALLY-true-in-every-surface-that-makes-it',
    (() => {
      // LAYER OWNERSHIP (S1). The POSITIVE claim — the TRUE relationship between `regress` and `report` — belongs to the
      // harness layer, and is required of the harness layer. The agent-facing entry point is STILL scanned for the FALSE
      // claim, and that is deliberately NOT repointed: a false sentence must never reappear in layer-0 whatever that
      // document goes on to carry, and the check is independent of where the harness prose lives.
      const surfaces = [
        s2.REGRESS_LIMITATIONS.join('\n'),
        readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8'),
        readFileSync(join(TESTS_DIR, '../README.md'), 'utf8'),
        readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8'),
        readFileSync(join(TESTS_DIR, '../docs/ledger.md'), 'utf8'),
      ];
      const falseClaim = /enters no denominator in `report`/;

      return (
        // The claim that was measured to be FALSE is gone from every surface that made it, layer-0 included…
        [...surfaces, readFileSync(join(TESTS_DIR, '../../AGENTS.md'), 'utf8')].every((text) => !falseClaim.test(text)) &&
        // …and every surface that OWNS the relationship now says the TRUE thing, including the disclosure
        // that makes it true.
        surfaces.every((text) => /comparison_sourced_runs/.test(text)) &&
        s2.REGRESS_LIMITATIONS.some((text) => /enters no denominator/.test(text) && /comparison_sourced_runs/.test(text)) &&
        /enters no denominator in any LEDGER-derived denominator/.test(s2.REGRESS_LIMITATIONS.join('\n'))
      );
    })(),
  );
  check(
    'I18',
    'S1-SITE1-the-harness-layer-owns-the-comparison_sourced_runs-disclosure-and-layer-0-is-still-scanned-for-the-false-claim',
    // Named replacement for the AGENTS.md conjunct repointed out of R6 above. The SAME literal, the SAME positive check,
    // now asked of every harness-layer surface that owns the claim — and the false claim is re-asserted absent from
    // layer-0, so the repoint can never become a licence to put the measured-false sentence back.
    [
      ['REGRESS_LIMITATIONS', s2.REGRESS_LIMITATIONS.join('\n')],
      ['harness.mjs', readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8')],
      ['README', readFileSync(join(TESTS_DIR, '../README.md'), 'utf8')],
      ['schemas', readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8')],
      ['ledger', readFileSync(join(TESTS_DIR, '../docs/ledger.md'), 'utf8')],
    ].every(([, text]) => /comparison_sourced_runs/.test(text)) &&
      !/enters no denominator in `report`/.test(readFileSync(join(TESTS_DIR, '../../AGENTS.md'), 'utf8')),
    JSON.stringify({
      harness_surfaces: 5,
      layer0_still_carries_positive: /comparison_sourced_runs/.test(
        readFileSync(join(TESTS_DIR, '../../AGENTS.md'), 'utf8'),
      ),
      layer0_carries_false_claim: /enters no denominator in `report`/.test(
        readFileSync(join(TESTS_DIR, '../../AGENTS.md'), 'utf8'),
      ),
    }),
  );
  check(
    'I18',
    'R3-and-R5-the-comparison-still-publishes-only-its-own-command-local-exit-set',
    (() => {
      const codes = [
        s2.REGRESS_EXIT_NO_FINDING,
        s2.REGRESS_EXIT_FINDING,
        s2.REGRESS_EXIT_USAGE,
        s2.REGRESS_EXIT_SIDE_ERROR,
        s2.REGRESS_EXIT_INCONCLUSIVE,
        s2.REGRESS_EXIT_CLEANUP_FAILED,
      ];

      return (
        new Set(codes).size === 6 &&
        !codes.includes(3) &&
        // A withdrawal is an undecidable COMPARISON, never a usage error and never a finding.
        s2.applyRegressConfirmation(i18Decision('regression', s2.REGRESS_EXIT_FINDING), i18Confirmation(1, 0)).exit_code ===
          s2.REGRESS_EXIT_INCONCLUSIVE
      );
    })(),
  );

  // ---- I19: the consolidated fix pass — eleven findings from two independent audits against the historical-workspace
  // + `regress` capability (provenance P1..P5, adversarial A1..A6).
  //
  // What belongs HERE is the part that is a pure function of a value or a decision table: the side classifier's two
  // judged-commit samples, the environment join, the selection disclosure, the cross-wiring check, the output fence,
  // the placement refusal, and the npmrc observation. What needs a real repository, a real gate and a real race lives
  // in the E18 compatibility family, and this group says so rather than pretending a pure-function test is that proof.
  const i18Clean = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  const i18Other = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
  /** The PASS-shaped baseline, now carrying BOTH judged-commit samples — a pre-only fixture is what let P1 through. */
  const i18Side = (overrides = {}) => ({
    harness_error: null,
    gate_incompatible: false,
    workspace_refused: null,
    environment_record: { dependency_provisioning: 'installed_historical' },
    status_hash_pre: 'hash-1',
    status_hash_post: 'hash-1',
    resolver_escaped: false,
    requested_commit: i18Clean,
    observed_judged_commit: i18Clean,
    observed_judged_commit_post: i18Clean,
    contract_digest_differs: false,
    gate_differs: false,
    acceptance_unresolved: false,
    gate_exit_code: 0,
    failing_step: null,
    ...overrides,
  });
  const i18Classify = (overrides) => s2.classifyRegressSide(i18Side(overrides));

  // P1. The reproduced shape, exactly: a gate that checks out another commit mid-run leaves a CLEAN worktree, so the
  // movement digest is byte-identical and only the two commit samples can see it. `status_hash_pre === status_hash_post`
  // is asserted ON, so this cannot pass by accident through the old branch.
  const i18Mover = i18Classify({ observed_judged_commit_post: i18Other });
  check(
    'I19',
    'P1-a-side-whose-judged-commit-MOVED-during-the-gate-is-INCONCLUSIVE-even-when-status_hash-is-unchanged',
    i18Mover.state === 'INCONCLUSIVE' &&
      /MOVED while the gate ran/.test(i18Mover.reason) &&
      i18Mover.reason.includes(i18Clean) &&
      i18Mover.reason.includes(i18Other) &&
      i18Mover.reason.includes('byte-identical') &&
      i18Classify({}).state === 'PASS' &&
      i18Classify({ status_hash_pre: 'hash-1', status_hash_post: 'hash-2' }).state === 'INCONCLUSIVE',
    i18Mover.reason,
  );
  check(
    'I19',
    'P1-BOTH-samples-must-name-the-requested-commit-and-both-travel-with-the-decision',
    i18Classify({ observed_judged_commit: i18Other }).state === 'INCONCLUSIVE' &&
      i18Classify({ observed_judged_commit_post: i18Other, requested_commit: i18Other }).state === 'INCONCLUSIVE' &&
      // The second sample is not merely read by the classifier: it is CARRIED, so the pair decision, the printed side and
      // the artifact all see it. Returning only `{state, reason}` is what made a caller-dependent merge look like a bug.
      i18Mover.observed_judged_commit_post === i18Other &&
      i18Mover.observed_judged_commit === i18Clean,
    JSON.stringify({ post: i18Mover.observed_judged_commit_post, pre: i18Mover.observed_judged_commit }),
  );
  // A mover never resolves into a direction, in either position, and the word "regression" is printed nowhere.
  const i18MoverPair = s2.compareRegressSides(
    i18Classify({}),
    i18Classify({ requested_commit: i18Other, observed_judged_commit: i18Other, observed_judged_commit_post: i18Clean }),
  );
  check(
    'I19',
    'P1-a-mover-is-cannot_compare-and-can-never-produce-a-regression-in-either-position',
    i18MoverPair.verdict === 'cannot_compare' &&
      i18MoverPair.exit_code === s2.REGRESS_EXIT_INCONCLUSIVE &&
      !/regression/.test(i18MoverPair.reason) &&
      s2.compareRegressSides(
        i18Classify({ observed_judged_commit_post: i18Other }),
        i18Classify({ requested_commit: i18Other, observed_judged_commit: i18Other }),
      ).verdict === 'cannot_compare',
    JSON.stringify({ verdict: i18MoverPair.verdict, exit: i18MoverPair.exit_code }),
  );
  // P4. The description of `status_hash` is a VALUE in the artifact, and it says the thing that makes P1 reachable.
  check(
    'I19',
    'P4-status_hash-is-documented-as-a-porcelain-delta-not-a-tree-identity-and-is-never-the-sole-signal',
    /git status --porcelain/.test(s2.REGRESS_STATUS_HASH_SCOPE.is) &&
      /COMMIT change on a clean tree/.test(s2.REGRESS_STATUS_HASH_SCOPE.cannot_detect) &&
      /regenerated untracked artefact/.test(s2.REGRESS_STATUS_HASH_SCOPE.also_moves_for) &&
      /e3b0c44298fc/.test(s2.REGRESS_STATUS_HASH_SCOPE.measured) &&
      /9b5eecbf4494/.test(s2.REGRESS_STATUS_HASH_SCOPE.measured) &&
      /byte-identical/.test(s2.REGRESS_STATUS_HASH_SCOPE.measured) &&
      s2.REGRESS_LIMITATIONS.includes(s2.REGRESS_STATUS_HASH_LIMIT) &&
      // The docs carry the same statement where an operator reads it, not only in the record.
      flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8')).includes(
        'is a digest of `git status --porcelain`, NOT a tree identity',
      ) &&
      flattenProse(readFileSync(join(TESTS_DIR, '../README.md'), 'utf8')).includes(
        'is a digest of `git status --porcelain`, NOT a tree identity',
      ),
    s2.REGRESS_STATUS_HASH_SCOPE.measured,
  );
  // P2. The join is by the EVALUATION run id the writer used, which is never the LEDGER id.
  const i18EnvLed = (id, runId) => ({ run_id: runId, judged_commit: i18Clean, dependency_provisioning: 'installed_historical' });
  const i18Eval = (runId) => i14Entry({ run_id: runId, judged_commit_pre: i18Clean, judged_commit_post: i18Clean });
  check(
    'I19',
    'P2-the-environment-joins-by-the-evaluated-run-id-and-not-by-the-ledger-id',
    // The two ids are different namespaces and never equal; a join on the ledger id returned null for every real ledger.
    s2.newestEnvironmentRecord({ run_id: 'ledA', evaluations: [i18Eval('runA')], environments: [i18EnvLed('ledA', 'runA')] })
      ?.run_id === 'runA' &&
      s2.newestEnvironmentRecord({ run_id: 'ledA', evaluations: [], environments: [i18EnvLed('ledA', 'runA')] })?.run_id === 'runA' &&
      s2.newestEnvironmentRecord({ run_id: 'ledA', evaluations: [i18Eval('runA')], environments: [] }) === null &&
      s2.newestEnvironmentRecord({ run_id: 'ledA' }) === null,
  );
  // P3. The disclosure is ONE value, and it says out loud that the choice was not commit-aware.
  const i18HarnessSource = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
  check(
    'I19',
    'P3-the-commit-blind-selection-disclosure-is-machine-readable-and-travels-into-the-json-path',
    s2.LEDGER_SELECTION_DISCLOSURE.commit_aware === false &&
      /NOT commit-aware/.test(s2.LEDGER_SELECTION_DISCLOSURE.rule) &&
      /read judged_commit, not source_commit/.test(s2.LEDGER_SELECTION_DISCLOSURE.rule) &&
      /--run-id/.test(s2.LEDGER_SELECTION_DISCLOSURE.limit) &&
      // Rendered by BOTH paths from the same object, so the human and JSON surfaces cannot drift apart again.
      /\$\{JSON\.stringify\(\{ ledger: displayedLedger, judged_commit: judged, state_quality: issues, selection \}/.test(
        i18HarnessSource,
      ) &&
      /\$\{selection\.rule\}/.test(i18HarnessSource) &&
      /\$\{selection\.candidates\}/.test(i18HarnessSource),
  );
  // P5. Defence in depth across the two arrays, which are written by the same run under the same conditional.
  const i18Wire = (evaluationOverrides, environmentCommit) => {
    const evaluation = i14Entry({
      run_id: 'i18-run',
      judged_commit_pre: i18Clean,
      judged_commit_post: i18Clean,
      ...evaluationOverrides,
    });

    return s2
      .ledgerStateQuality(
        {
          ...i14LedgerBase('i18-wire'),
          evaluations: [evaluation],
          environments: [{ ...i18EnvLed('i18-wire', 'i18-run'), judged_commit: environmentCommit }],
        },
        undefined,
      )
      .map((issue) => issue.kind);
  };
  check(
    'I19',
    'P5-a-cross-wired-evaluations/environments-pair-is-flagged-and-an-agreeing-pair-is-silent',
    i18Wire({}, i18Other).includes('evaluation_environment_commit_mismatch') &&
      !i18Wire({}, i18Clean).includes('evaluation_environment_commit_mismatch') &&
      // A commit that MOVED during the run is not a cross-wiring: the environment names the post sample, which is one
      // of the two commits the evaluation observed, so this must stay silent.
      !i18Wire({ judged_commit_post: i18Other }, i18Other).includes('evaluation_environment_commit_mismatch') &&
      !i18Wire({ judged_commit_pre: i18Other, judged_commit_post: i18Other }, i18Other).includes(
        'evaluation_environment_commit_mismatch',
      ) &&
      // An environment array that names no run the evaluation knows is its own, named kind.
      s2
        .ledgerStateQuality(
          {
            ...i14LedgerBase('i18-unbound'),
            evaluations: [i18Eval('runA')],
            environments: [i18EnvLed('i18-unbound', 'runZ')],
          },
          undefined,
        )
        .map((issue) => issue.kind)
        .includes('environment_run_unbound'),
  );
  // A1. The ordinary single-writer path is byte-for-byte what it was: the CAS refuses only a STALE base, and this
  // asserts that a write against the CURRENT digest still lands, twice, through the real CLI in a throwaway
  // HARNESS_HOME inside the fixture repository. The stale-base refusal needs a real race and lives in E18-01.
  const i18Home = join(repo, '.harness-i18');
  writeContract(i18Home, 'P6T', sourceCommit, ['criterion one'], [
    { id: 'k1', criterion: 1, kind: 'absent_pattern', pattern: 'searchTasks', paths: ['src'] },
  ]);
  const i18Init = runHarness(repo, ['ledger', 'init', '--task=P6T', '--run-id=i18-cas'], i18Home);
  const i18First = runHarness(repo, ['ledger', 'set', '--task=P6T', '--run-id=i18-cas', '--status=in_progress'], i18Home);
  const i18Second = runHarness(
    repo,
    ['ledger', 'set', '--task=P6T', '--run-id=i18-cas', '--completed=i18 ordinary writer still writes'],
    i18Home,
  );
  const i18CasPath = join(i18Home, 'state', 'ledgers', 'i18-cas.json');
  const i18CasLedger = existsSync(i18CasPath) ? JSON.parse(readFileSync(i18CasPath, 'utf8')) : { completed: [] };
  check(
    'I19',
    'A1-the-compare-and-swap-refuses-a-stale-base-and-leaves-the-ordinary-writer-byte-identical',
    i18Init.status === 0 &&
      i18First.status === 0 &&
      i18Second.status === 0 &&
      i18CasLedger.completed.length === 1 &&
      i18CasLedger.completed[0].text === 'i18 ordinary writer still writes' &&
      // The refusal is a NAMED, non-silent refusal — never an overwrite — and it is the ONLY new exit-adjacent code.
      /expectedDigest/.test(readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8').split('function mutateLedger')[1] ?? '') &&
      s2.LEDGER_WRITE_CONFLICT === 'LEDGER_WRITE_CONFLICT',
    `${i18Init.status}/${i18First.status}/${i18Second.status} ${JSON.stringify(i18CasLedger.completed)} ${i18Init.stderr.slice(0, 200)} ${i18Second.stderr.slice(0, 200)}`,
  );
  // A4. A forged result line is DATA: the fence both bounds it and prefixes every line, so it cannot be a field.
  const i18Forged = s2.gateOutputFence(
    ["mechanically_verified: yes", "terminal result: 'verified", 'gate exit: 0', 'VERDICT: PASS'].join('\n'),
    { index: 0, step: 'test:ui', total: 3 },
  );
  const i18FenceLines = i18Forged.replace(/\n$/, '').split('\n');
  check(
    'I19',
    'A4-forged-gate-output-cannot-be-read-as-a-harness-field-because-it-is-fenced-and-prefixed',
    i18FenceLines.every((line) => line.startsWith('| ') || /^(--- (begin|end) )/.test(line)) &&
      !i18FenceLines.some((line) => /^mechanically_verified:/.test(line)) &&
      i18FenceLines.some((line) => line === '| mechanically_verified: yes') &&
      /begin gate step 1\/3 \(test:ui\)/.test(i18FenceLines[0]) &&
      /not this harness's fields/.test(i18FenceLines[0]) &&
      // And the echo really goes through the fence, on the only call site that writes it.
      /process\.stdout\.write\(gateOutputFence\(/.test(i18HarnessSource),
  );
  // A5. The cache is a path input and gets the same class of placement refusal as the worktree root.
  const i18RefusedCache = (() => {
    try {
      s2.assertNpmCacheRefusal(join(REAL_REPO_ROOT, '.harness', 'state', 'npm-cache-i18'));
      return null;
    } catch (error) {
      return error;
    }
  })();
  let i18OutsideCacheOk = true;
  try {
    s2.assertNpmCacheRefusal(join(tmpdir(), 'harness-i18-outside-cache'));
  } catch {
    i18OutsideCacheOk = false;
  }
  check(
    'I19',
    'A5-an-npm-cache-inside-the-repository-is-refused-and-one-outside-is-accepted',
    i18RefusedCache !== null &&
      /NPM_CACHE_PLACEMENT_REFUSED/.test(i18RefusedCache.message) &&
      i18RefusedCache.exitCode === 2 &&
      /assertNpmCacheRefusal\(npmCache\)/.test(i18HarnessSource) &&
      i18OutsideCacheOk,
    i18RefusedCache?.message ?? 'not refused',
  );
  // A6. The npmrc FILE channel is recorded, not closed — and the basis says exactly that, in the record and the docs.
  const i18HomeDir = join(root, 'i18-home-dir');
  mkdirSync(i18HomeDir, { recursive: true });
  const i18Npmrc = join(i18HomeDir, '.npmrc');
  writeFileSync(i18Npmrc, 'registry=http://127.0.0.1:9/hostile/\n');
  const i18NpmConfig = s2.observeNpmConfigFiles({ HOME: i18HomeDir, PATH: process.env.PATH ?? '/usr/bin:/bin' });
  check(
    'I19',
    'A6-the-npm-config-FILE-channel-is-recorded-with-a-digest-and-an-honest-basis-and-is-not-claimed-to-be-closed',
    i18NpmConfig.user_config_path === i18Npmrc &&
      i18NpmConfig.user_config_source === 'derived_from_HOME' &&
      i18NpmConfig.user_config_present === true &&
      /^[0-9a-f]{16}$/.test(i18NpmConfig.user_config_digest) &&
      i18NpmConfig.basis === s2.NPM_CONFIG_FILES_BASIS &&
      /RECORDED LIMIT, not a solved problem/.test(s2.NPM_CONFIG_FILES_BASIS) &&
      /drops every npm_config_\*\/NPM_CONFIG_\* VARIABLE/.test(s2.NPM_CONFIG_FILES_BASIS) &&
      /only a digest and a path/.test(s2.NPM_CONFIG_FILES_BASIS) &&
      // npm is asked only when a file is in play, and then it is asked with the CHILD environment, not the operator's.
      i18NpmConfig.registry_queried === true &&
      /http:\/\/127\.0\.0\.1:9\/hostile\//.test(i18NpmConfig.registry ?? '') &&
      flattenProse(readFileSync(join(TESTS_DIR, '../README.md'), 'utf8')).includes(
        'a npm config file is a channel the environment sanitisation does not close',
      ) &&
      flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8')).includes(
        'a npm config file is a channel the environment sanitisation does not close',
      ),
    JSON.stringify({ registry: i18NpmConfig.registry, source: i18NpmConfig.user_config_source }),
  );

  // ---- I20: the historical BUILD step, the build-state observation, and a stable installed-tree population
  //
  // The defect these assertions exist for is MEASURED, not assumed: the historical evaluation predicate was
  // constant-red (50/50 commits over a 50-commit window failed at `typecheck:shared+server` with
  // `TS2307: Cannot find module '@task-board/shared'`) because `shared/package.json` resolves only through the
  // gitignored `./dist`, `shared/` declares no `prepare` script, and `workspace prepare` never built it. Two
  // `evaluate` records for the same workspace, one before `shared` was built and one after, carried a BYTE-IDENTICAL
  // environment record while `gate_exit_code` went 2 → 0. The deciding bytes live in the SOURCE tree; every fingerprint
  // that existed looked at `node_modules`, and `status_hash` (a digest of `git status` WITHOUT `--ignored`) is blind to
  // them by construction.
  //
  // Everything asserted here is driven against the REAL implementations, and the derivations are asserted against THIS
  // repository's own manifests wherever that is possible — a derivation rule that only ever ran against a fixture would
  // be a rule fitted to the fixture.

  // I20-1. The plan, derived from THIS repository's real HEAD. Exactly one package needs building, and it is
  // `@task-board/shared` because (a) it declares `build`, (b) it declares relative entrypoints under the gitignored
  // `./dist`, (c) those entrypoints are NOT tracked, and (d) `server` and `ui` both depend on it by the local spec `*`.
  // `ui` and `server` are recorded as SKIPPED with their reasons, so "why was nothing built for that package" is
  // answerable from the record instead of by re-derivation.
  const i20Head = git(['rev-parse', 'HEAD'], REAL_REPO_ROOT).stdout.trim();
  const i20Plan = s2.historicalBuildPlanForCommit(i20Head);
  const i20Built = (i20Plan?.packages ?? []).map((entry) => entry.name);
  const i20Skipped = Object.fromEntries((i20Plan?.packages_skipped ?? []).map((entry) => [entry.name, entry.reason]));
  check(
    'I20',
    'the-build-plan-is-derived-from-the-judged-commit-own-manifests-and-selects-exactly-the-package-the-gate-resolves-through-a-build',
    i20Built.length === 1 &&
      i20Built[0] === '@task-board/shared' &&
      i20Plan.packages[0].build_script === 'tsc' &&
      JSON.stringify(i20Plan.packages[0].output_roots) === JSON.stringify(['shared/dist']) &&
      i20Plan.packages[0].output_kind === 'directories' &&
      i20Plan.packages[0].untracked_entrypoints.length > 0 &&
      /^[0-9a-f]{16}$/.test(i20Plan.digest) &&
      /no relative entrypoint declared/.test(i20Skipped['@task-board/ui'] ?? '') &&
      /no relative entrypoint declared/.test(i20Skipped['@task-board/server'] ?? '') &&
      /JUDGED COMMIT'S OWN manifests/.test(i20Plan.command_basis),
    JSON.stringify({ built: i20Built, roots: i20Plan?.packages?.[0]?.output_roots, skipped: i20Skipped }).slice(0, 500),
  );
  // The rule is stated, versioned, and part of the reuse key: a rule change reclaims every workspace rather than
  // silently reusing one verified under the old rule. Rule version 2 is the A7 change — a BARE relative specifier in
  // `main`/`types`/`typings` is a path, because Node's `legacyMainResolve` is `path.resolve(packageDirectory, value)` —
  // and the residual case is a refusal, not a guess.
  check(
    'I20',
    'the-selection-rule-is-stated-versioned-and-a-local-spec-is-never-confused-with-a-registry-range',
    /ALL FOUR hold/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      /NOT tracked at that commit/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      /ROOT package is never a build target/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      /BARE relative specifier counts/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      /path\.resolve\(packageDirectory, value\)/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      /exports` keys and targets still require an explicit/.test(s2.BUILD_PLAN_SELECTION_RULE) &&
      i20Plan.rule_version === 2 &&
      /NOT recorded as "no build output is required by this gate"/.test(s2.BUILD_PLAN_UNDETERMINED_BASIS) &&
      s2.localWorkspaceSpec('*', '0.0.0') === true &&
      s2.localWorkspaceSpec('workspace:^1.0.0', '1.0.0') === true &&
      s2.localWorkspaceSpec('file:../lib', '1.0.0') === true &&
      s2.localWorkspaceSpec('^1.0.0', '1.0.0') === true &&
      s2.localWorkspaceSpec('^2.0.0', '1.0.0') === false &&
      s2.localWorkspaceSpec('^18.2.0', '0.0.0') === false &&
      s2.localWorkspaceSpec(undefined, '1.0.0') === false,
    s2.BUILD_PLAN_SELECTION_RULE.slice(0, 120),
  );
  // `declaredEntrypoints` reads `exports` subtrees, normalises `./`, IGNORES wildcards and built-in specifiers, and — the
  // A7 fix — ACCEPTS a bare relative specifier in `main`/`types`/`typings` while still requiring an explicit prefix
  // in `exports`. The old predicate is reproduced inline as the CONTROL: it is what dropped `dist/index.js`, and an
  // assertion that only ever checked the new rule could not tell a fix from a rewrite.
  const i20OldDeclaredEntrypoints = (pkg) => {
    const values = new Set();
    const push = (value) => {
      if (typeof value !== 'string' || value === '' || value === '*' || value.startsWith('node:')) {
        return;
      }
      if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
        values.add(value.replace(/^\.\//, ''));
      }
    };
    const walk = (node) => {
      if (typeof node === 'string') {
        push(node);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node !== null && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    push(pkg?.main);
    push(pkg?.types);
    push(pkg?.typings);
    walk(pkg?.exports);
    return [...values].sort();
  };
  check(
    'I20',
    'declared-entrypoints-read-main-types-and-exports-subtrees-ignore-wildcards-and-accept-a-bare-relative-main',
    JSON.stringify(
      s2.declaredEntrypoints({
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './package.json': './package.json' },
        browser: { './server.js': './browser.js' },
      }),
    ) === JSON.stringify(['dist/index.d.ts', 'dist/index.js', 'package.json']) &&
      // A7: the measured case. The OLD rule produced [] here, which is what skipped the package and let the gate
      // fail on a missing `shared/dist/index.js`.
      JSON.stringify(i20OldDeclaredEntrypoints({ main: 'dist/index.js' })) === JSON.stringify([]) &&
      JSON.stringify(s2.declaredEntrypoints({ main: 'dist/index.js' })) === JSON.stringify(['dist/index.js']) &&
      JSON.stringify(s2.declaredEntrypoints({ main: 'index.js', types: 'index.d.ts' })) ===
        JSON.stringify(['index.d.ts', 'index.js']) &&
      // `exports` keeps the explicit-prefix rule: a bare key there is a subpath that can never match, not a path.
      JSON.stringify(s2.declaredEntrypoints({ exports: { 'dist/index.js': 'dist/index.js' } })) === JSON.stringify([]) &&
      JSON.stringify(s2.declaredEntrypoints({ exports: { '.': './dist/index.js' } })) === JSON.stringify(['dist/index.js']) &&
      // Wildcards and built-in specifiers remain non-paths, in BOTH field families.
      JSON.stringify(s2.declaredEntrypoints({ exports: { '.': '*' } })) === JSON.stringify([]) &&
      JSON.stringify(s2.declaredEntrypoints({ main: 'dist/*.js' })) === JSON.stringify([]) &&
      JSON.stringify(s2.declaredEntrypoints({ main: 'node:fs' })) === JSON.stringify([]) &&
      // A value this program cannot read as a path is reported as UNDETERMINED rather than silently producing no
      // entrypoint, which is what let the plan claim the gate needed no build output.
      JSON.stringify(s2.undeterminedEntrypointFields({ main: 'dist/*.js' })) === JSON.stringify([{ field: 'main', value: 'dist/*.js' }]) &&
      JSON.stringify(s2.undeterminedEntrypointFields({ main: 'node:fs' })) === JSON.stringify([{ field: 'main', value: 'node:fs' }]) &&
      JSON.stringify(s2.undeterminedEntrypointFields({ main: 'dist/index.js' })) === JSON.stringify([]) &&
      JSON.stringify(s2.undeterminedEntrypointFields({})) === JSON.stringify([]),
    JSON.stringify({
      old: i20OldDeclaredEntrypoints({ main: 'dist/index.js' }),
      now: s2.declaredEntrypoints({ main: 'dist/index.js' }),
    }),
  );

  // I20-2. `--build-command` is an ARGV, never a shell line. A metacharacter is REFUSED with a message that says why,
  // because a shell string would be a strictly larger and less observable execution class than the one disclosed.
  const i20RefusedShell = (() => {
    try {
      s2.parseDeclaredBuildCommand('npm run build --workspace=shared && rm -rf /');

      return null;
    } catch (error) {
      return error;
    }
  })();
  let i20OutsideShellOk = true;
  try {
    s2.parseDeclaredBuildCommand('node build.mjs');
  } catch {
    i20OutsideShellOk = false;
  }
  check(
    'I20',
    'a-declared-build-command-is-an-argv-a-shell-metacharacter-is-refused-and-a-plain-command-parses',
    i20RefusedShell !== null &&
      /BUILD_COMMAND_SHELL_METACHARACTERS/.test(i20RefusedShell.message) &&
      i20RefusedShell.exitCode === 2 &&
      /never runs a shell/.test(i20RefusedShell.message) &&
      i20OutsideShellOk &&
      JSON.stringify(s2.parseDeclaredBuildCommand('npm run build --workspace=shared')) ===
        JSON.stringify(['npm', 'run', 'build', '--workspace=shared']),
    i20RefusedShell?.message?.slice(0, 160) ?? 'not refused',
  );

  // I20-3. The build, executed for real: a real spawn in a disposable directory, with the install's own outcome shape.
  // No mock — the outcome, the exit code and the fail-fast order are properties of the execution, not of a stub.
  const i20Exec = join(root, 'i20-exec');
  mkdirSync(i20Exec, { recursive: true });
  const i20OkBuild = s2.runHistoricalBuild({
    directory: i20Exec,
    childEnv: process.env,
    plan: { packages: [], digest: 'a'.repeat(16) },
    mode: 'declared',
    declaredArgv: [process.execPath, '--version'],
  });
  const i20FailBuild = s2.runHistoricalBuild({
    directory: i20Exec,
    childEnv: process.env,
    plan: { packages: [], digest: 'a'.repeat(16) },
    mode: 'declared',
    declaredArgv: [process.execPath, '-e', 'process.exit(7)'],
  });
  const i20DisabledBuild = s2.runHistoricalBuild({
    directory: i20Exec,
    childEnv: process.env,
    plan: { packages: [] },
    mode: 'disabled',
    declaredArgv: [],
  });
  check(
    'I20',
    'a-build-is-executed-for-real-and-its-outcome-command-and-duration-are-recorded-exactly-like-an-install',
    s2.BUILD_OUTCOMES.includes(i20OkBuild.outcome) &&
      i20OkBuild.outcome === 'succeeded' &&
      i20OkBuild.exit_code === 0 &&
      i20OkBuild.command === `${process.execPath} --version` &&
      Number.isInteger(i20OkBuild.duration_ms) &&
      /DECLARED input/.test(i20OkBuild.command_basis) &&
      i20FailBuild.outcome === 'failed' &&
      i20FailBuild.exit_code === 7 &&
      // A disabled build is a DISABLED build, never a build that passed.
      i20DisabledBuild.outcome === 'disabled' &&
      i20DisabledBuild.command === null &&
      /never as a build that passed/.test(i20DisabledBuild.command_basis),
    JSON.stringify({
      ok: [i20OkBuild.outcome, i20OkBuild.exit_code],
      fail: [i20FailBuild.outcome, i20FailBuild.exit_code],
      disabled: [i20DisabledBuild.outcome, i20DisabledBuild.command],
    }),
  );

  // I20-4. The build STATE, observed in a REAL disposable git repository: a gitignored build output is found, its
  // bytes are digested, a content change MOVES the digest, and deleting the output makes the state UNOBSERVABLE
  // rather than silently "unchanged". The secrets file is named by git and its contents are never read — the
  // assertion is on the serialised record, so "never opened" is checked by what the record does NOT contain.
  const i20Tree = join(root, 'i20-tree');
  mkdirSync(join(i20Tree, 'pkg', 'dist'), { recursive: true });
  mkdirSync(join(i20Tree, '.harness'), { recursive: true });
  writeFileSync(join(i20Tree, '.gitignore'), 'dist/\n.dev.vars\nnode_modules/\n');
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.d.ts'), 'export declare const a: number;\n');
  const i20Secret = 'SUPERSECRET_CANARY_VALUE_a1b2c3d4\n';
  writeFileSync(join(i20Tree, '.dev.vars'), i20Secret);
  git(['init', '-q'], i20Tree);
  git(['add', '-A'], i20Tree);
  const i20PlanFor = {
    packages: [{ name: 'pkg', output_roots: ['pkg/dist'], output_kind: 'directories' }],
  };
  const i20Env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const i20State1 = s2.observeBuildState(i20Tree, i20PlanFor, i20Env);
  // Captured while the gitignored build output EXISTS: the ignored-path observation is about what git reports for this
  // tree, and the output is removed two lines later.
  const i20Ignored = s2.observeIgnoredPaths(i20Tree, i20Env);
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.js'), 'export const a = 2;\n');
  const i20State2 = s2.observeBuildState(i20Tree, i20PlanFor, i20Env);
  rmSync(join(i20Tree, 'pkg', 'dist'), { recursive: true, force: true });
  const i20State3 = s2.observeBuildState(i20Tree, i20PlanFor, i20Env);
  check(
    'I20',
    'the-build-state-is-observed-in-a-real-tree-a-content-change-moves-it-and-a-deleted-output-makes-it-unobservable',
    i20State1.observed === true &&
      /^[0-9a-f]{16}$/.test(i20State1.digest) &&
      i20State1.regions.length === 1 &&
      i20State1.regions[0].path === 'pkg/dist' &&
      i20State1.regions[0].present === true &&
      i20State1.tier === 'content' &&
      i20State1.digest !== i20State2.digest &&
      i20State3.observed === false &&
      i20State3.digest === null &&
      JSON.stringify(i20State3.missing_outputs) === JSON.stringify(['pkg/dist']) &&
      /absence of evidence, never evidence of absence/.test(i20State3.basis),
    JSON.stringify({
      d1: i20State1.digest,
      d2: i20State2.digest,
      d3: i20State3.digest,
      missing: i20State3.missing_outputs,
    }),
  );
  // The ignored-path half: NAMES only. The gitignored secrets file is NAMED (git names it) and its contents appear
  // nowhere in the serialised observation — which is the strongest statement this program can make about not reading it.
  check(
    'I20',
    'the-ignored-path-observation-records-names-only-and-never-the-contents-of-a-gitignored-secrets-file',
    i20Ignored.readable === true &&
      // git collapses an ignored DIRECTORY, so the name is `pkg/` here and not `pkg/dist/`: the observation is of what
      // git reports, and the limitation string says so rather than promising per-file resolution.
      i20Ignored.names.includes('pkg/') &&
      i20Ignored.names.includes('.dev.vars') &&
      /^[0-9a-f]{16}$/.test(i20Ignored.digest) &&
      !JSON.stringify(i20Ignored).includes('SUPERSECRET_CANARY_VALUE') &&
      /never opened, hashed, digested or recorded/.test(s2.BUILD_STATE_LIMITATION) &&
      /server\/\.dev\.vars is named because git names it/.test(s2.BUILD_STATE_LIMITATION),
    JSON.stringify({ names: i20Ignored.names, digest: i20Ignored.digest }),
  );

  // I20-5. The reuse KEY carries the build, and the build-state re-verification FAILS CLOSED. Every refusal keeps its
  // OWN name, because "the build state changed" and "the build state cannot be observed" have different consequences
  // and conflating them writes a false reason into a durable record.
  const i20KeyInputs = {
    commit: 'a'.repeat(40),
    lockfileDigest: 'b'.repeat(12),
    nodeVersion: 'v24.0.0',
    packageManager: { name: 'npm', version: '12.0.1' },
    platform: { os: 'linux', arch: 'x64' },
    npmrcDigest: 'c'.repeat(16),
    npmConfigDigest: 'd'.repeat(16),
    fingerprintTier: 'metadata',
  };
  const i20KeyBase = s2.computeWorkspaceKey({ ...i20KeyInputs, build: { mode: 'derived', plan_digest: 'e'.repeat(16) } });
  check(
    'I20',
    'the-reuse-key-moves-with-the-build-mode-the-plan-digest-and-the-declared-command',
    i20KeyBase === s2.computeWorkspaceKey({ ...i20KeyInputs, build: { mode: 'derived', plan_digest: 'e'.repeat(16) } }) &&
      i20KeyBase !== s2.computeWorkspaceKey({ ...i20KeyInputs, build: { mode: 'disabled', plan_digest: 'e'.repeat(16) } }) &&
      i20KeyBase !== s2.computeWorkspaceKey({ ...i20KeyInputs, build: { mode: 'derived', plan_digest: 'f'.repeat(16) } }) &&
      i20KeyBase !== s2.computeWorkspaceKey({
        ...i20KeyInputs,
        build: { mode: 'declared', plan_digest: 'e'.repeat(16), command: 'node build.mjs' },
      }) &&
      // A workspace verified with no build component at all is a DIFFERENT key, so no pre-build workspace is ever
      // handed back as though it had been built.
      i20KeyBase !== s2.computeWorkspaceKey(i20KeyInputs),
    `base=${i20KeyBase}`,
  );
  // The build output is restored, so the reuse assertions below run against a tree whose build state is OBSERVABLE
  // and whose attested digest is genuinely the earlier one — the "changed" case must be caused by the walk, not by the
  // output being gone.
  mkdirSync(join(i20Tree, 'pkg', 'dist'), { recursive: true });
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.d.ts'), 'export declare const a: number;\n');
  const i20Attestation = {
    historical_build_mode: 'derived',
    historical_build_plan_digest: 'e'.repeat(16),
    build_state: i20State1,
  };
  const i20Reuse = (overrides, build, directory = i20Tree) =>
    s2.verifyReusableBuildState({ attestation: { ...i20Attestation, ...overrides }, directory, build, childEnv: i20Env });
  const i20Derived = { mode: 'derived', plan_digest: 'e'.repeat(16), plan: i20PlanFor };
  // A STALE build output: the bytes are present and walkable, but they are not the bytes the attestation recorded. This
  // is the case that used to be certified "reused — re-verified … all match".
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.js'), 'export const a = 3;\n');
  const i20Stale = i20Reuse({}, i20Derived);
  writeFileSync(join(i20Tree, 'pkg', 'dist', 'index.js'), 'export const a = 1;\n');
  check(
    'I20',
    'the-build-state-is-re-verified-on-every-reuse-and-every-failure-keeps-its-own-name',
    i20Reuse({}, i20Derived).reusable === true &&
      i20Reuse({}, { mode: 'disabled', plan_digest: 'e'.repeat(16), plan: i20PlanFor }).reason === 'historical_build_mode_mismatch' &&
      i20Reuse({}, { mode: 'derived', plan_digest: '0'.repeat(16), plan: i20PlanFor }).reason === 'historical_build_plan_mismatch' &&
      // "Cannot be observed" and "changed" are two facts and two names.
      i20Stale.reason === 'build_state_changed' &&
      i20Stale.detail.attested !== i20Stale.detail.observed &&
      i20Reuse(
        {},
        { mode: 'derived', plan_digest: 'e'.repeat(16), plan: i20PlanFor },
        join(root, 'i20-absent'),
      ).reason === 'build_state_unobservable' &&
      i20Reuse({ build_state: null }, { mode: 'derived', plan_digest: 'e'.repeat(16), plan: i20PlanFor }).reason ===
        'build_state_unattested' &&
      // A call site that supplies no build component is not refused — that would make the installed-tree half
      // unreachable — but it is told, in the returned state, that the build was NOT verified.
      i20Reuse({}, null).reason === 'build_component_not_supplied' &&
      i20Reuse({}, null).verified === false &&
      // An EMPTY plan has nothing to re-verify, and a build state recorded for one is itself a mismatch.
      i20Reuse({ build_state: null }, { mode: 'derived', plan_digest: 'e'.repeat(16), plan: { packages: [] } }).reusable === true &&
      i20Reuse({}, { mode: 'derived', plan_digest: 'e'.repeat(16), plan: { packages: [] } }).reason === 'build_state_recorded_for_an_empty_plan',
    JSON.stringify(
      [
        i20Reuse({}, { mode: 'derived', plan_digest: 'e'.repeat(16), plan: i20PlanFor }).reason,
        i20Reuse({}, { mode: 'derived', plan_digest: '0'.repeat(16), plan: i20PlanFor }).reason,
      ],
    ),
  );

  // I20-6. The installed-tree walk's exclusion set. MEASURED consequence: the walk root is `<workspace>/node_modules`
  // and a gate run creates `node_modules/.vite` and `node_modules/.cache` inside it, so without an explicit exclusion a
  // workspace that had run the gate once was refused on the next `prepare` — repeated evaluation and workspace reuse
  // were MUTUALLY EXCLUSIVE. The exclusion is NARROW (a sibling named `vite-utils` is still attested) and its cost is
  // stated rather than absorbed.
  const i20Modules = join(root, 'i20-modules', 'node_modules');
  mkdirSync(join(i20Modules, 'pkg'), { recursive: true });
  mkdirSync(join(i20Modules, '.vite', 'vitest'), { recursive: true });
  mkdirSync(join(i20Modules, '.cache', 'wrangler'), { recursive: true });
  mkdirSync(join(i20Modules, 'vite-utils'), { recursive: true });
  writeFileSync(join(i20Modules, '.package-lock.json'), '{}\n');
  writeFileSync(join(i20Modules, 'pkg', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(i20Modules, 'vite-utils', 'index.js'), 'module.exports = 2;\n');
  writeFileSync(join(i20Modules, '.vite', 'vitest', 'stamp'), 'one\n');
  writeFileSync(join(i20Modules, '.cache', 'wrangler', 'stamp'), 'one\n');
  const i20Fp1 = s2.observeInstalledTreeFingerprint(join(root, 'i20-modules'), 'metadata');
  writeFileSync(join(i20Modules, '.vite', 'vitest', 'stamp'), 'two\n');
  writeFileSync(join(i20Modules, '.cache', 'wrangler', 'stamp'), 'two\n');
  const i20Fp2 = s2.observeInstalledTreeFingerprint(join(root, 'i20-modules'), 'metadata');
  writeFileSync(join(i20Modules, 'vite-utils', 'index.js'), 'module.exports = 3;\n');
  const i20Fp3 = s2.observeInstalledTreeFingerprint(join(root, 'i20-modules'), 'metadata');
  writeFileSync(join(i20Modules, 'pkg', 'index.js'), 'module.exports = 9;\n');
  const i20Fp4 = s2.observeInstalledTreeFingerprint(join(root, 'i20-modules'), 'metadata');
  check(
    'I20',
    'the-declared-walk-exclusions-absorb-exactly-the-two-measured-tool-caches-and-nothing-else',
    i20Fp1.digest === i20Fp2.digest &&
      i20Fp2.digest !== i20Fp3.digest &&
      i20Fp3.digest !== i20Fp4.digest &&
      JSON.stringify(i20Fp1.exclusions) === JSON.stringify(['.vite', '.cache']) &&
      i20Fp1.exclusions_version === 1 &&
      i20Fp2.excluded_paths.includes('.vite') &&
      i20Fp2.excluded_paths.includes('.cache') &&
      !i20Fp2.excluded_paths.includes('vite-utils') &&
      // `limitation` stays the tier's own label (other readers compare it against a constant); the exclusion travels
      // beside it and is what the RECORD stores.
      i20Fp1.limitation === s2.TREE_FINGERPRINT_LIMITS.metadata &&
      /EXCLUDED from the walk/.test(i20Fp1.limitation_with_exclusions) &&
      /UNATTESTED/.test(i20Fp1.limitation_with_exclusions) &&
      /Any other cache path is NOT excluded/.test(i20Fp1.limitation_with_exclusions) &&
      /SAME set is applied to the installed-entry COUNT/.test(i20Fp1.limitation_with_exclusions) &&
      JSON.stringify(s2.INSTALLED_TREE_EXCLUSIONS.paths) === JSON.stringify(['.vite', '.cache']),
    JSON.stringify({
      fp1: i20Fp1.digest,
      fp2: i20Fp2.digest,
      fp3: i20Fp3.digest,
      fp4: i20Fp4.digest,
      excluded: i20Fp2.excluded_paths,
    }),
  );
  // The entry COUNT is a reuse condition too, so the same set applies to it — with the raw count recorded beside the
  // attested one, so the two can always be reconciled.
  writeFileSync(join(i20Modules, '.cache', 'wrangler', 'stamp'), 'three\n');
  const i20CountBefore = s2.observeInstalledState(join(root, 'i20-modules'));
  writeFileSync(join(i20Modules, 'pkg', 'index.js'), 'module.exports = 1;\n');
  const i20CountAfter = s2.observeInstalledState(join(root, 'i20-modules'));
  check(
    'I20',
    'the-installed-entry-count-applies-the-same-declared-exclusions-and-records-the-raw-count-beside-it',
    i20CountBefore.entry_count === 3 &&
      i20CountBefore.entry_count_raw === 5 &&
      JSON.stringify(i20CountBefore.entry_count_excluded) === JSON.stringify(['.cache', '.vite']) &&
      i20CountAfter.entry_count === i20CountBefore.entry_count &&
      JSON.stringify(s2.INSTALLED_TREE_EXCLUSIONS.paths) === JSON.stringify(['.vite', '.cache']),
    JSON.stringify({
      count: i20CountBefore.entry_count,
      raw: i20CountBefore.entry_count_raw,
      excluded: i20CountBefore.entry_count_excluded,
    }),
  );

  // I20-7. The disclosure is HONEST, and it is stated in the record AND in the docs. A build executes the historical
  // commit's own string with no neutraliser; a worktree is not a security boundary; historical reproducibility is not
  // result authenticity; and a same-principal writer controls the gate, the contract, the acceptance policy, the
  // dependencies, the evaluator and the ledger. None of that changed.
  const i20Readme = readFileSync(join(TESTS_DIR, '../README.md'), 'utf8');
  const i20Schemas = readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8');
  const i20Prose = (text) => flattenProse(text);
  check(
    'I20',
    'the-build-disclosure-states-the-larger-script-class-and-records-script-execution-as-permanently-null',
    /EXECUTES the historical commit/.test(s2.BUILD_SCRIPT_EXECUTION_BASIS) &&
      /NO neutraliser/.test(s2.BUILD_SCRIPT_EXECUTION_BASIS) &&
      /strictly LARGER class of script/.test(s2.BUILD_SCRIPT_EXECUTION_BASIS) &&
      /permanently null/.test(s2.BUILD_SCRIPT_EXECUTION_BASIS) &&
      /worktree is not a security boundary/.test(s2.BUILD_SCRIPT_EXECUTION_BASIS) &&
      /never from the task contract/.test(s2.BUILD_COMMAND_BASIS) &&
      /DECLARED input/.test(s2.BUILD_COMMAND_DECLARED_BASIS) &&
      /is EMPTY/.test(s2.BUILD_STATE_NOT_APPLICABLE_BASIS) &&
      s2.BUILD_MODES.includes('declared') &&
      s2.BUILD_MODES.includes('disabled') &&
      s2.BUILD_MODES.includes('derived'),
    s2.BUILD_SCRIPT_EXECUTION_BASIS.slice(0, 120),
  );
  check(
    'I20',
    'the-docs-state-why-the-build-exists-what-it-restores-and-the-unchanged-standing-limitations',
    i20Prose(i20Readme).includes('a historical build step') &&
      i20Prose(i20Readme).includes('prepare-workspace.sh') &&
      i20Prose(i20Readme).includes('a worktree is not a security boundary') &&
      i20Prose(i20Readme).includes('historical reproducibility is not result authenticity') &&
      i20Prose(i20Schemas).includes('a worktree is not a security boundary') &&
      i20Prose(i20Schemas).includes('constant-red') &&
      i20Prose(i20Schemas).includes('UNATTESTED'),
    JSON.stringify({
      readmeSecurity: i20Prose(i20Readme).includes('a worktree is not a security boundary'),
      readmeRepro: i20Prose(i20Readme).includes('historical reproducibility is not result authenticity'),
      schemasSecurity: i20Prose(i20Schemas).includes('a worktree is not a security boundary'),
      readmeBuild: i20Prose(i20Readme).includes('a historical build step'),
      readmeLegacy: i20Prose(i20Readme).includes('prepare-workspace.sh'),
      schemasRed: i20Prose(i20Schemas).includes('constant-red'),
      schemasUnattested: i20Prose(i20Schemas).includes('UNATTESTED'),
    }),
  );
  check(
    'I20',
    'S1-SITE2-the-standing-limitations-are-OWNED-by-the-harness-layer-and-are-not-required-of-the-agent-facing-entry-point',
    // Named replacement for the two AGENTS.md conjuncts repointed out of the assertion above. The SAME two literals, the
    // SAME positive check, now asked of BOTH harness-layer documents that carry them — the security-boundary limitation in
    // each, and the reproducibility-is-not-authenticity limitation in each. The agent-facing entry point is no longer
    // required to restate a standing limitation in order for it to hold.
    i20Prose(i20Readme).includes('a worktree is not a security boundary') &&
      i20Prose(i20Readme).includes('historical reproducibility is not result authenticity') &&
      i20Prose(i20Schemas).includes('a worktree is not a security boundary') &&
      i20Prose(i20Schemas).includes('historical reproducibility is not result authenticity'),
    JSON.stringify({
      readmeSecurity: i20Prose(i20Readme).includes('a worktree is not a security boundary'),
      readmeRepro: i20Prose(i20Readme).includes('historical reproducibility is not result authenticity'),
      schemasSecurity: i20Prose(i20Schemas).includes('a worktree is not a security boundary'),
      schemasRepro: i20Prose(i20Schemas).includes('historical reproducibility is not result authenticity'),
    }),
  );

  // ---- I21: repeated evaluation — the contradiction rule, the exact bound, and what the bound is not.
  //
  // The real executions live in the E20 compatibility family (a SIGKILLed comparison resumed from its append-only
  // trial log, a p ~ 0.5 predicate at an odd and an even N, a trial that moves the tree). What is asserted HERE is what
  // a real execution cannot cheaply prove dozens of times over: that the exact bound is EXACT at both ends, that the
  // anti-conservative detector fires exactly when the number tightened, that the classification is total and never a
  // vote, and that the N = 1 path is the pre-`--repeat` one rather than a claim about it.

  const i21Bound = (k, n) => s2.regressFlipRateUpperBound(k, n);
  const i21Tail = (k, n, p) => s2.regressBinomialTailAtLeast(k, n, p);
  const i21Trials = (states) =>
    states.map((state, index) => ({
      trial_index: index,
      state,
      reason: `synthetic trial ${index}`,
      run_id: `run-${index}`,
      instance: `regress-x-${index}`,
      observed_judged_commit: 'a'.repeat(40),
      gate_exit_code: state === 'PASS' ? 0 : 1,
      failing_step: state === 'FAIL' ? 'benchmark-suite' : null,
    }));
  const i21Alpha = 1 - s2.REPEAT_CONFIDENCE;
  /** Every way N trials can split between PASS and FAIL, for N up to 5 — the whole space the rule has to be total over. */
  const i21Splits = (n) => {
    const out = [];
    for (let pass = 0; pass <= n; pass += 1) {
      out.push([...Array(pass).fill('PASS'), ...Array(n - pass).fill('FAIL')]);
    }
    return out;
  };

  check(
    'I21',
    'the-zero-flip-bound-is-the-exact-identity-and-the-argued-95-percent-limits-are-the-published-ones',
    [20, 29, 59, 149, 299].every((n) => {
      const bound = i21Bound(0, n);
      return (
        bound.value === Number((1 - Math.pow(i21Alpha, 1 / n)).toPrecision(12)) &&
        bound.method === s2.REPEAT_BOUND_METHOD_ZERO &&
        bound.exact === true &&
        /k=0/.test(bound.formula) &&
        /1 - alpha\^\(1\//.test(bound.formula)
      );
    }) &&
      i21Bound(0, 20).value === 0.139108340668 &&
      i21Bound(0, 29).value === 0.0981446276773 &&
      i21Bound(0, 59).value === 0.0495076098882 &&
      i21Bound(0, 149).value === 0.0199048162207 &&
      i21Bound(0, 299).value === 0.0099691467929,
    JSON.stringify({ n20: i21Bound(0, 20).value, n59: i21Bound(0, 59).value, n299: i21Bound(0, 299).value }),
  );
  check(
    'I21',
    'the-k-positive-bound-is-the-CLOPPER-PEARSON-exact-limit-and-it-actually-solves-the-tail-equation',
    [1, 2, 3, 5, 7].every((n) => {
      for (let k = 1; k <= n; k += 1) {
        const bound = i21Bound(k, n);
        // It must be the root of P(X >= k | p) = alpha, checked against the tail itself and not against a restatement.
        const at = i21Tail(k, n, bound.value);
        if (!(Math.abs(at - i21Alpha) < 1e-9)) {
          return false;
        }
        if (bound.method !== s2.REPEAT_BOUND_METHOD_EXACT || bound.exact !== true || !/Clopper-Pearson/.test(bound.formula)) {
          return false;
        }
      }
      return true;
    }) &&
      // Two closed forms, so the implementation is pinned against arithmetic nobody has to take on trust.
      i21Bound(1, 5).value === Number((1 - Math.pow(1 - i21Alpha, 1 / 5)).toPrecision(12)) &&
      i21Bound(5, 5).value === Number(Math.pow(i21Alpha, 1 / 5).toPrecision(12)) &&
      Math.abs(i21Bound(1, 1).value - i21Alpha) < 1e-12,
    JSON.stringify({ k1n5: i21Bound(1, 5).value, k5n5: i21Bound(5, 5).value, k1n1: i21Bound(1, 1).value }),
  );
  check(
    'I21',
    'the-binomial-tail-is-correct-on-its-boundaries-and-on-values-with-a-known-answer',
    i21Tail(0, 5, 0.37) === 1 &&
      i21Tail(1, 5, 0) === 0 &&
      i21Tail(5, 5, 1) === 1 &&
      i21Tail(1, 1, 0.5) === 0.5 &&
      i21Tail(2, 5, 0.5) === 0.8125 &&
      Math.abs(i21Tail(3, 5, 0.4) - 0.31744) < 1e-9 &&
      i21Tail(2, 4, 0.5) === 0.6875 &&
      i21Tail(1, 0, 0.5) === null,
    JSON.stringify({ n3k5: i21Tail(3, 5, 0.4), n2k4: i21Tail(2, 4, 0.5) }),
  );
  check(
    'I21',
    'the-measured-58-59-amplification-reproduces-EXACTLY-and-the-anti-conservative-detector-fires-because-of-it',
    (() => {
      const zero = s2.regressBoundRecord(0, 59);
      const one = s2.regressBoundRecord(1, 59);
      // The zero-flip bound for N=59 is 4.95 %; one disagreement turns it into 0.087 % — fifty-seven times tighter,
      // from a defect that failed 9/9 in the condition a boundary-search step actually runs in.
      return (
        zero.value === 0.0495076098882 &&
        one.value === 0.000869000071526 &&
        one.value * 100 < 0.1 &&
        zero.anti_conservative === false &&
        zero.anti_conservative_warning === null &&
        one.anti_conservative === true &&
        one.tightened_from_zero_flips === true &&
        one.bound_at_zero_flips === zero.value &&
        /ANTI-CONSERVATIVE/.test(one.anti_conservative_warning) &&
        /58\/59/.test(one.anti_conservative_warning) &&
        /9\/9/.test(one.anti_conservative_warning) &&
        /byte-identical/.test(one.anti_conservative_warning)
      );
    })(),
    JSON.stringify({ zero: s2.regressBoundRecord(0, 59).value, one: s2.regressBoundRecord(1, 59).value }),
  );
  check(
    'I21',
    'the-anti-conservative-detector-fires-EXACTLY-when-the-bound-tightened-and-never-otherwise',
    s2.regressBoundTightened({ value: 0.4 }, { value: 0.5 }) === true &&
      s2.regressBoundTightened({ value: 0.5 }, { value: 0.5 }) === false &&
      s2.regressBoundTightened({ value: 0.6 }, { value: 0.5 }) === false &&
      s2.regressBoundTightened(null, { value: 0.5 }) === null &&
      s2.regressBoundTightened({ value: 0.1 }, null) === null &&
      // And across the whole k space of a real N, the flag is true for every k >= 1 that tightened and false at k = 0.
      s2.regressBoundRecord(0, 7).anti_conservative === false &&
      [1, 2, 3, 4, 5].every((k) => s2.regressBoundRecord(k, 7).anti_conservative === (s2.regressBoundRecord(k, 7).value < s2.regressBoundRecord(0, 7).value)),
  );
  check(
    'I21',
    'the-unattainable-reason-fires-exactly-when-no-N-attains-a-bound-below-the-floor',
    s2.regressBoundRecord(5, 5).unattainable_below_floor === true &&
      /UNATTAINABLE/.test(s2.regressBoundRecord(5, 5).unattainable_reason) &&
      /no repetition count attains a bound below 0.5/.test(s2.regressBoundRecord(5, 5).unattainable_reason) &&
      s2.regressBoundRecord(1, 5).unattainable_below_floor === false &&
      s2.regressBoundRecord(1, 5).unattainable_reason === null &&
      s2.regressBoundRecord(0, 5).unattainable_below_floor === false &&
      s2.regressBoundRecord(0, 5).floor === 0.5,
    JSON.stringify({ k5n5: s2.regressBoundRecord(5, 5).value, k1n5: s2.regressBoundRecord(1, 5).value }),
  );
  check(
    'I21',
    'ANY-disagreement-makes-the-side-INCONCLUSIVE-and-a-vote-is-never-taken',
    i21Splits(5)
      .map((states) => s2.classifyRegressTrials(i21Trials(states), 5))
      .every((aggregate) => {
        const split = aggregate.state_counts;
        const expected =
          split.PASS === 5 ? 'PASS' : split.FAIL === 5 ? 'FAIL' : 'INCONCLUSIVE';
        return (
          aggregate.classification === expected &&
          aggregate.classification_rule_id === (expected === 'INCONCLUSIVE' ? s2.REPEAT_RULE_CONTRADICTION : s2.REPEAT_RULE_UNANIMOUS) &&
          aggregate.vote_used === false &&
          aggregate.k === 5 - Math.max(split.PASS, split.FAIL) &&
          (expected !== 'INCONCLUSIVE' ||
            (aggregate.undecidable_cause === 'undecidable_by_contradiction' &&
              aggregate.direction_attainable === false &&
              aggregate.majority_not_taken.taken === false))
        );
      }) &&
      // A 3-2 split HAS a majority, and it is refused: the whole point is that the majority is not what decides.
      s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']), 5).majority_not_taken.available === true &&
      s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']), 5).majority_not_taken.state === 'FAIL' &&
      s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']), 5).classification === 'INCONCLUSIVE' &&
      // And a 2-2 tie is a DIFFERENT situation from a refused majority, and is recorded as one.
      s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS']), 4).majority_not_taken.tie === true &&
      s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS']), 4).majority_not_taken.available === false,
    JSON.stringify(s2.classifyRegressTrials(i21Trials(['FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']), 5).state_counts),
  );
  check(
    'I21',
    'a-trial-that-is-ERROR-or-INCONCLUSIVE-is-never-averaged-away-by-the-trials-that-agree',
    (() => {
      const withError = s2.classifyRegressTrials(i21Trials(['PASS', 'PASS', 'PASS', 'PASS', 'ERROR']), 5);
      const withInconclusive = s2.classifyRegressTrials(i21Trials(['PASS', 'PASS', 'PASS', 'PASS', 'INCONCLUSIVE']), 5);
      return (
        withError.classification === 'ERROR' &&
        withError.classification_rule_id === 'trial_error_not_averaged_away' &&
        /do NOT average it away/.test(withError.reason) &&
        withInconclusive.classification === 'INCONCLUSIVE' &&
        withInconclusive.classification_rule_id === 'trial_inconclusive_not_averaged_away' &&
        withInconclusive.undecidable_cause === 'undecidable_by_trial' &&
        /do NOT average it away/.test(withInconclusive.reason) &&
        // A trial whose state is not in the vocabulary is an ERROR, never a silently dropped observation.
        s2.classifyRegressTrials([{ ...i21Trials(['PASS'])[0], state: 'WEIRD' }], 1).classification === 'ERROR' &&
        s2.classifyRegressTrials([], 3).classification === 'ERROR' &&
        s2.classifyRegressTrials([], 3).classification_rule_id === 'no_trials_performed'
      );
    })(),
    JSON.stringify({
      error: s2.classifyRegressTrials(i21Trials(['PASS', 'PASS', 'PASS', 'PASS', 'ERROR']), 5).classification,
      inconclusive: s2.classifyRegressTrials(i21Trials(['PASS', 'PASS', 'PASS', 'PASS', 'INCONCLUSIVE']), 5)
        .classification,
    }),
  );
  check(
    'I21',
    'the-classification-is-TOTAL-over-every-split-and-never-produces-a-direction-itself',
    [...i21Splits(4), ...i21Splits(3), ...i21Splits(2), ...i21Splits(1)]
      .map((states) => s2.classifyRegressTrials(i21Trials(states), states.length))
      .every((aggregate) =>
        ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].includes(aggregate.classification) &&
        s2.REPEAT_RULE_IDS.includes(aggregate.classification_rule_id) &&
        !['regression', 'no_regression', 'already_failing', 'improved'].includes(aggregate.classification) &&
        aggregate.vote_used === false,
      ) &&
      // The direction is a property of the PAIR decision, which only ever sees the four side states.
      ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].every((state) =>
        s2.REGRESS_SIDE_STATES.includes(state),
      ),
  );
  check(
    'I21',
    'INCONCLUSIVE-is-NON-RESOLVING-never-skippable-and-named-differently-from-gits-125',
    (() => {
      const aggregate = s2.classifyRegressTrials(i21Trials(['PASS', 'FAIL']), 2);
      return (
        aggregate.git_skip_125_equivalent === false &&
        aggregate.skippable === false &&
        aggregate.resolves_boundary === false &&
        /NON-RESOLVING/.test(s2.REPEAT_NON_RESOLVING) &&
        /NOT git's 125 "skip"/.test(s2.REPEAT_NON_RESOLVING) &&
        /never skips, never narrows a search, and never names the other side the winner/.test(s2.REPEAT_NON_RESOLVING) &&
        /exclude this commit and keep searching/.test(s2.REPEAT_NON_RESOLVING) &&
        /LATE in a fixed direction/.test(s2.REPEAT_NON_RESOLVING) &&
        aggregate.resolving_note === s2.REPEAT_NON_RESOLVING
      );
    })(),
  );
  check(
    'I21',
    'the-bound-record-states-exchangeability-as-assumed-and-unverified-and-names-what-breaks-it',
    (() => {
      const record = s2.regressBoundRecord(1, 5);
      return (
        /exchangeability: assumed, unverified/.test(record.exchangeability) &&
        record.exchangeability_verified === false &&
        /POSITIVELY CORRELATED defect/.test(record.exchangeability) &&
        /warm\/cold cache/.test(record.exchangeability) &&
        /session-scoped resource/.test(record.exchangeability) &&
        /first-run-only failure/.test(record.exchangeability) &&
        /load/.test(record.exchangeability) &&
        /exchangeability: assumed, unverified/.test(s2.REPEAT_EXCHANGEABILITY) &&
        record.is_a_licence === false &&
        /not a licence/.test(record.is_not_a_licence_because)
      );
    })(),
  );
  check(
    'I21',
    'every-new-field-is-normalised-to-an-explicit-null-rather-than-omitted',
    (() => {
      const zero = s2.regressBoundRecord(0, 5);
      const one = s2.regressBoundRecord(1, 5);
      const aggregate = s2.classifyRegressTrials(i21Trials(['PASS', 'PASS']), 2);
      return (
        Object.hasOwn(zero, 'anti_conservative_warning') &&
        zero.anti_conservative_warning === null &&
        Object.hasOwn(zero, 'unattainable_reason') &&
        zero.unattainable_reason === null &&
        one.anti_conservative_warning !== null &&
        one.unattainable_reason === null &&
        Object.hasOwn(aggregate, 'direction_unattainable_reason') &&
        aggregate.direction_unattainable_reason === null &&
        Object.hasOwn(aggregate, 'undecidable_cause') &&
        aggregate.undecidable_cause === null &&
        aggregate.trials_performed === 2 &&
        aggregate.trials_requested === 2 &&
        aggregate.trials_complete === true
      );
    })(),
  );
  check(
    'I21',
    'the-rule-and-its-limitations-say-a-vote-is-never-taken-and-carry-the-measured-evidence',
    /A vote is NEVER taken/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      /not a majority, not a best-of, not the last trial, not the most common/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      /wrong exactly half the time for EVERY N/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      /not a remedy/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      /amplifier/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      /never averaged away/.test(s2.REPEAT_CLASSIFICATION_RULE) &&
      s2.REPEAT_LIMITATIONS.some((text) => /40 independent real bisects/.test(text) && /40\/40 times/.test(text)) &&
      s2.REPEAT_LIMITATIONS.some((text) => /58\/59/.test(text) && /9\/9/.test(text)) &&
      s2.REPEAT_LIMITATIONS.some((text) => /NON-CAUSAL with respect to LEDGER terminal state at N > 1/.test(text)) &&
      s2.REPEAT_LIMITATIONS.some((text) => /a single observation cannot distinguish a flaky predicate/.test(text) && /REPETITION DOES NOT FIX THAT/.test(text)) &&
      s2.REPEAT_LIMITATIONS.some((text) => /a worktree is not a security boundary/.test(text)) &&
      s2.REPEAT_LIMITATIONS.some((text) => /same-principal writer/.test(text)),
  );
  check(
    'I21',
    'no-guarantee-word-appears-in-any-string-the-aggregate-output-is-built-from',
    [
      s2.REPEAT_CLASSIFICATION_RULE,
      s2.REPEAT_VOTE_FORBIDDEN,
      s2.REPEAT_NON_RESOLVING,
      s2.REPEAT_EXCHANGEABILITY,
      s2.REPEAT_ANTI_CONSERVATIVE_BASIS,
      s2.REPEAT_UNATTAINABLE_BASIS,
      s2.REPEAT_BOUND_NOT_A_LICENCE,
      s2.REPEAT_VERDICT_BASIS_TEXT,
      ...s2.REPEAT_LIMITATIONS,
    ]
      .join('\n')
      .split('\n')
      .filter((line) => /\bstable\b/i.test(line) || /\bconfirmed\b/i.test(line) || /\breproducib\w*/i.test(line))
      .length === 0,
  );
  check(
    'I21',
    'N-1-keeps-the-single-observation-basis-and-N-greater-than-1-is-labelled-as-the-disagreement-rule',
    (() => {
      const one = s2.withRegressVerdictBasis({ verdict: 'regression', exit_code: 1, withdrawal: null });
      const many = s2.withRegressAggregateBasis({ verdict: 'regression', exit_code: 1, withdrawal: null }, 5);
      return (
        one.verdict_basis === s2.REGRESS_VERDICT_BASIS &&
        one.verdict_basis === 'single_observation' &&
        one.observations_per_side === 1 &&
        many.verdict_basis === s2.REPEAT_VERDICT_BASIS &&
        many.verdict_basis === 'repeated_disagreement_rule' &&
        many.observations_per_side === 5 &&
        /CONTRADICTION rule/.test(many.verdict_basis_text) &&
        s2.REPEAT_DEFAULT_TRIALS === 1 &&
        s2.REPEAT_MAX_TRIALS === 299
      );
    })(),
  );
  check(
    'I21',
    'an-unusable-repeat-count-is-refused-BY-NAME-instead-of-silently-falling-back-to-one',
    (() => {
      const refuses = (value) => {
        try {
          s2.regressResolveTrials(value);
          return false;
        } catch (error) {
          return /--repeat=<N>/.test(String(error?.message ?? error));
        }
      };
      return (
        s2.regressResolveTrials(undefined) === 1 &&
        s2.regressResolveTrials('1') === 1 &&
        s2.regressResolveTrials('5') === 5 &&
        s2.regressResolveTrials('299') === 299 &&
        refuses('0') &&
        refuses('300') &&
        refuses('100000') &&
        refuses('many') &&
        refuses('-1') &&
        refuses(true) &&
        // The session token is bounded and is never a path.
        s2.regressResolveSession(undefined) === null &&
        s2.regressResolveSession('abc-123_x') === 'abc-123_x' &&
        ['../escape', 'a/b', '', 'x'.repeat(41), 'x y'].some((value) => {
          try {
            s2.regressResolveSession(value);
            return false;
          } catch {
            return true;
          }
        })
      );
    })(),
  );
  check(
    'I21',
    'reading-a-trial-log-that-does-not-exist-yields-no-trials-rather-than-an-error-or-a-guess',
    // Deliberately NOT `regressTrialsLogPath`: that call creates the control-plane directory, and a self-test has no
    // business writing into the developer's real HARNESS_HOME. The real path is asserted in E20-07, against a real run.
    s2.regressReadTrialLog(join(root, 'does-not-exist-e21.jsonl')).length === 0 &&
      s2.REPEAT_TRIALS_LOG_SCHEMA_VERSION === 1 &&
      s2.regressReadTrialLog(join(root, 'does-not-exist-e21.jsonl')).map(() => 'x').length === 0,
  );
  check(
    'I21',
    'the-docs-state-the-rule-the-no-vote-norm-the-measured-evidence-and-the-non-resolving-naming',
    (() => {
      const schemas = flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8'));
      const readme = flattenProse(readFileSync(join(TESTS_DIR, '../README.md'), 'utf8'));
      const ledger = flattenProse(readFileSync(join(TESTS_DIR, '../docs/ledger.md'), 'utf8'));
      const modes = flattenProse(readFileSync(join(REAL_REPO_ROOT, '.roomodes'), 'utf8'));
      return (
        schemas.includes('### 2b. Repeated evaluation') &&
        schemas.includes('A vote is NEVER taken') &&
        schemas.includes('wrong **exactly 50 % of the time for every N**') &&
        schemas.includes('40/40') &&
        schemas.includes('58/59') &&
        schemas.includes('9/9') &&
        schemas.includes('NON-RESOLVING') &&
        schemas.includes('never skippable') &&
        schemas.includes('Clopper') &&
        schemas.includes('1 - alpha^(1/N)') &&
        schemas.includes('exchangeability: assumed, unverified') &&
        schemas.includes('a worktree is not a security boundary') &&
        readme.includes('40/40') &&
        readme.includes('NON-RESOLVING') &&
        readme.includes('a vote is never used') &&
        ledger.includes('non-causal with respect to this ledger at every N') &&
        modes.includes('VOTE IS NEVER USED') &&
        modes.includes('NON-RESOLVING')
      );
    })(),
    JSON.stringify({
      schemas: flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8')).includes('### 2b. Repeated evaluation'),
    }),
  );
  check(
    'I21',
    'S1-SITE3-the-measured-evidence-the-NON-RESOLVING-naming-and-never-skippable-are-OWNED-by-the-harness-layer',
    // Named replacement for the three AGENTS.md conjuncts repointed out of the assertion above: the SAME three literals,
    // the SAME positive check, now asked of the two harness-layer documents that own them — each of the three required of
    // BOTH documents, so the claim cannot survive in one while the other drifts. The agent-facing entry point is no longer
    // a required carrier of the measured evidence, which is what lets its harness prose move later.
    (() => {
      const schemas = flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8'));
      const readme = flattenProse(readFileSync(join(TESTS_DIR, '../README.md'), 'utf8'));

      return ['40/40', 'NON-RESOLVING', 'never skippable'].every(
        (literal) => schemas.includes(literal) && readme.includes(literal),
      );
    })(),
    (() => {
      const schemas = flattenProse(readFileSync(join(TESTS_DIR, '../docs/schemas.md'), 'utf8'));
      const readme = flattenProse(readFileSync(join(TESTS_DIR, '../README.md'), 'utf8'));

      return JSON.stringify({
        schemas: ['40/40', 'NON-RESOLVING', 'never skippable'].map((literal) => schemas.includes(literal)),
        readme: ['40/40', 'NON-RESOLVING', 'never skippable'].map((literal) => readme.includes(literal)),
      });
    })(),
  );
  check(
    'I21',
    'repeated-evaluation-adds-NO-reachable-bisect-path-and-leaves-the-terminal-state-machine-alone',
    (() => {
      const source = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
      return (
        !/case\s+['"]bisect['"]/.test(source) &&
        !/--bisect/.test(source) &&
        !/\bbisect\s*\(/.test(source) &&
        !/\bbisect\s*[:,]/.test(source) &&
        !/repeat[^\n]*bisect/i.test(source) &&
        !/\bbisect\b/i.test(readFileSync(join(TESTS_DIR, '../runtime/verification-state.mjs'), 'utf8')) &&
        s2.REGRESS_VERDICTS !== undefined &&
        !s2.REGRESS_VERDICTS.includes('bisect') &&
        !s2.REPEAT_RULE_IDS.includes('bisect')
      );
    })(),
  );

  const runtimeSourceAfter = runtimeSourceManifest();
  check(
    'I10',
    'SOURCE-INTEGRITY-complete-runtime-tree-is-unchanged-across-entire-self-test',
    runtimeSourceAfter.files === runtimeSourceBefore.files && runtimeSourceAfter.digest === runtimeSourceBefore.digest,
    `before=${runtimeSourceBefore.files}:${runtimeSourceBefore.digest} after=${runtimeSourceAfter.files}:${runtimeSourceAfter.digest}`,
  );

  // ---- I22: the MEASUREMENT-LABELLING and PROVISIONING defects of this cycle, A1 to A8.
  //
  // Grouped together on purpose: every member is the same shape of failure — a RECORD asserting something its own
  // computation did not establish. The exactness label on a bound that solved nothing (A1), a digest definition that
  // was recorded but not enforced (A2), an unattested population with no magnitude (A3), a flag whose wording
  // overstated what it measures (A4), two declarations that named things nothing implemented (A5), a plan rule that a
  // manifest spelling could defeat into a false "no build output required" (A7), and a class of build side effect
  // that was happening and going unrecorded (A8).

  // --- A1. The bound at n = 180, and a sweep to 299, against an INDEPENDENT reference.
  //
  // The reference is EXACT RATIONAL ARITHMETIC. Every finite double in [0, 1] is a dyadic rational m/2^s, so
  // sum_{i>=k} C(n,i) p^i (1-p)^(n-i) is exactly computable with BigInt at the harness's own published value — no
  // logs, no doubles, no recurrence, and no code shared with the implementation under test. If the published bound
  // solves the printed equation, the exact tail at that value is alpha; if it does not, no amount of self-consistency
  // inside the implementation can make it so.
  const i22Exact = (value) => {
    let scaled = value;
    let den = 1;

    while (!Number.isInteger(scaled)) {
      scaled *= 2;
      den *= 2;
    }

    return [BigInt(scaled), BigInt(den)];
  };
  const i22Binom = (n, k) => {
    let out = 1n;

    for (let i = 0; i < k; i += 1) {
      out = (out * BigInt(n - i)) / BigInt(i + 1);
    }

    return out;
  };
  /** P(X >= k | p) as an exact rational N/D, both BigInt. Never converted to a double: den^n is ~2^16000 here. */
  const i22ExactTailRational = (k, n, p) => {
    const [num, den] = i22Exact(p);
    const other = den - num;
    let total = 0n;
    let numPow = 1n;
    let otherPow = other ** BigInt(n);

    for (let i = 0; i <= n; i += 1) {
      if (i > 0) {
        numPow *= num;
        otherPow /= other === 0n ? 1n : other;
      }

      if (i >= k) {
        total += i22Binom(n, i) * numPow * otherPow;
      }
    }

    return { num: total, den: den ** BigInt(n) };
  };
  /** |P(X >= k | p) - alpha| < tolerance, decided in EXACT INTEGER ARITHMETIC. */
  const i22ExactTailSatisfies = (k, n, p, alphaNum, alphaDen, tolerance) => {
    const { num, den } = i22ExactTailRational(k, n, p);
    const left = num * BigInt(alphaDen);
    const right = BigInt(alphaNum) * den;
    const difference = left > right ? left - right : right - left;

    return difference * BigInt(tolerance.den) < BigInt(tolerance.num) * den * BigInt(alphaDen);
  };
  const i22Alpha = 1 - s2.REPEAT_CONFIDENCE;
  const [i22AlphaNum, i22AlphaDen] = i22Exact(i22Alpha);
  const i22Pairs = [];
  for (let n = 180; n <= 299; n += 1) {
    i22Pairs.push([n - 1, n], [n, n], [1, n], [Math.floor(n / 3), n]);
  }
  const i22Tolerance = { num: 1, den: 1_000_000_000 };
  const i22Sweep = i22Pairs.map(([k, n]) => {
    const bound = s2.regressFlipRateUpperBound(k, n);

    return {
      k,
      n,
      value: bound.value,
      exact: bound.exact,
      solves: i22ExactTailSatisfies(k, n, bound.value, i22AlphaNum, i22AlphaDen, i22Tolerance),
    };
  });
  check(
    'I22',
    'the-CLOPPER-PEARSON-bound-at-n-180-and-every-n-to-299-solves-its-equation-EXACTLY-in-rational-arithmetic',
    // The named measured case first, on its own: k = 179, n = 180 was `1` and is 0.973917696671.
    s2.regressFlipRateUpperBound(179, 180).value === 0.973917696671 &&
      // The whole sweep, against the exact-rational reference.
      i22Sweep.length === 120 * 4 &&
      i22Sweep.every((entry) => entry.exact === true && entry.solves === true) &&
      // And a control: the FORMER answer is not merely different, it is a bound of certainty, and the new one is not.
      (() => {
        const former = s2.regressFlipRateUpperBound(179, 180, s2.REPEAT_CONFIDENCE, {
          evaluateTail: (k, n, p) => {
            const ratio = p / (1 - p);
            let term = Math.pow(1 - p, n);
            let total = k === 0 ? term : 0;

            for (let i = 0; i < n; i += 1) {
              term *= ((n - i) / (i + 1)) * ratio;
              if (i + 1 >= k) {
                total += term;
              }
            }

            return Math.min(1, Math.max(0, total));
          },
        });

        // The former evaluator drives the bracket to p = 1, where its own recurrence evaluates to NaN. The record
        // refuses to publish a number it cannot corroborate, so the value is `null` rather than a bound of certainty,
        // and the label says why.
        return former.value === null && former.exact === false && /NOT EXACT/.test(former.exactness_basis);
      })(),
    JSON.stringify({
      first: i22Sweep[0],
      last: i22Sweep[i22Sweep.length - 1],
      pairs: i22Sweep.length,
    }),
  );
  check(
    'I22',
    'the-EXACT-label-is-DERIVED-from-a-residual-and-flips-to-false-on-a-degenerate-evaluator',
    s2.regressBoundExactness({ k: 1, n: 5, alpha: i22Alpha, value: s2.regressFlipRateUpperBound(1, 5).value }).exact ===
      true &&
      s2.regressBoundExactness({
        k: 179,
        n: 180,
        alpha: i22Alpha,
        value: 1,
        underflowed: true,
      }).exact === false &&
      s2.regressBoundExactness({ k: 3, n: 7, alpha: i22Alpha, value: 0.9 }).exact === false &&
      s2.regressBoundExactness({ k: 3, n: 7, alpha: i22Alpha, value: Number.NaN }).exact === false &&
      s2.regressBoundExactness({ k: 3, n: 7, alpha: i22Alpha, value: 0.2, unusable: 'no value' }).exact === false &&
      // The k=0 branch is a closed form, and it says why it needs no residual.
      s2.regressFlipRateUpperBound(0, 59).exact === true &&
      /closed-form identity/.test(s2.regressFlipRateUpperBound(0, 59).exactness_basis) &&
      s2.regressBoundRecord(5, 5).exactness_basis !== null &&
      s2.regressBoundRecord(5, 5).tail_residual_at_bound !== null,
    JSON.stringify({
      wrongValue: s2.regressBoundExactness({ k: 3, n: 7, alpha: i22Alpha, value: 0.9 }).basis.slice(0, 90),
    }),
  );
  // The 143 REACHABLE pairs the old seed underflowed on were the `k` NEAR `n` ones, and a `1` returned for any of them
  // is not a wrong answer, it is a bound of certainty. So the class is checked exhaustively where it lives (k = n - 1
  // and k = n, every n from 180 to 299) and by stride everywhere else, and the property asserted is the one the defect
  // broke: a bound strictly below 1, labelled exact, and — for k = n - 1 — non-decreasing in n, which is what a tail
  // that got pinned at 1 could not be.
  const i22NearN = [];
  let i22NearNPrevious = 0;

  for (let n = 180; n <= 299; n += 1) {
    for (const k of [n - 1, n]) {
      const bound = s2.regressFlipRateUpperBound(k, n);

      i22NearN.push({ k, n, value: bound.value, exact: bound.exact });
    }

    const atNMinusOne = s2.regressFlipRateUpperBound(n - 1, n);

    i22NearNPrevious = atNMinusOne.value >= i22NearNPrevious ? atNMinusOne.value : Number.NaN;
  }

  const i22Strided = [];
  for (let n = 180; n <= 299; n += 1) {
    for (let k = 1; k <= n; k += 5) {
      const bound = s2.regressFlipRateUpperBound(k, n);

      i22Strided.push({ k, n, value: bound.value, exact: bound.exact });
    }
  }

  check(
    'I22',
    'no-reachable-k-at-n-from-180-to-299-returns-a-bound-of-CERTAINTY-and-the-k-near-n-class-is-exact-at-every-n',
    i22NearN.length === 120 * 2 &&
      i22NearN.every((entry) => entry.exact === true && entry.value < 1 && entry.value > 0) &&
      i22Strided.every((entry) => entry.exact === true && entry.value < 1 && entry.value > 0) &&
      i22Strided.length > 5000 &&
      Number.isFinite(i22NearNPrevious) &&
      s2.regressFlipRateUpperBound(179, 180).value === 0.973917696671 &&
      s2.regressFlipRateUpperBound(299, 299).value === 0.990030853207,
    JSON.stringify({
      nearN: i22NearN.length,
      strided: i22Strided.length,
      worst: i22NearN.reduce((worst, entry) => (entry.value > worst.value ? entry : worst)).value,
    }),
  );

  // --- A2. The exclusion set is part of what the digest MEANS, so it is part of the key.
  const i22KeyBase = {
    commit: 'a'.repeat(40),
    lockfileDigest: 'b'.repeat(12),
    nodeVersion: 'v24.0.0',
    packageManager: { name: 'npm', version: '12.0.0' },
    platform: { os: 'linux', arch: 'x64' },
    npmrcDigest: null,
    npmConfigDigest: null,
    fingerprintTier: 'metadata',
  };
  check(
    'I22',
    'the-exclusion-set-version-is-part-of-the-reuse-key-because-it-is-part-of-the-digest-definition',
    s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 1 }) !==
      s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 2 }) &&
      s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 1 }) === s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 1 }) &&
      // Control: the tier already moved the key, and an ABSENT version is a value of its own (null), not the version 1.
      s2.computeWorkspaceKey({ ...i22KeyBase, fingerprintTier: 'content' }) !==
        s2.computeWorkspaceKey({ ...i22KeyBase, fingerprintTier: 'metadata' }) &&
      s2.computeWorkspaceKey(i22KeyBase) !== s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 1 }) &&
      // And the shipped constant is what the prepare path feeds the key: the key DERIVATION itself names the field.
      s2.INSTALLED_TREE_EXCLUSIONS.version === 1 &&
      /EXCLUDED from the walk \(set version 1/.test(s2.INSTALLED_TREE_EXCLUSIONS_TEXT) &&
      readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8').includes(
        'installed_tree_fingerprint_exclusions_version: exclusionsVersion ?? null',
      ) &&
      readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8').includes(
        'exclusionsVersion: INSTALLED_TREE_EXCLUSIONS.version',
      ),
    JSON.stringify({
      v1: s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 1 }),
      v2: s2.computeWorkspaceKey({ ...i22KeyBase, exclusionsVersion: 2 }),
    }),
  );

  // --- A3. The unattested population has a SIZE, and the two counts reconcile.
  const i22Tree = join(root, 'i22-tree');
  const i22Write = (relative, body) => {
    const path = join(i22Tree, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  i22Write('node_modules/plain/package.json', '{}');
  i22Write('node_modules/plain/index.js', '');
  i22Write('node_modules/.vite/vitest/a.mjs', '');
  i22Write('node_modules/.vite/vitest/b.mjs', '');
  i22Write('node_modules/.vite/nested/deep/c.mjs', '');
  i22Write('node_modules/.cache/wrangler/d.txt', '');
  const i22Fingerprint = s2.observeInstalledTreeFingerprint(i22Tree, 'metadata');
  check(
    'I22',
    'the-pre-exclusion-entry-count-is-recorded-beside-the-post-exclusion-one-and-the-two-reconcile',
    i22Fingerprint.entries === 2 &&
      i22Fingerprint.excluded_entries === 10 &&
      i22Fingerprint.entries_raw === 12 &&
      i22Fingerprint.entries_raw - i22Fingerprint.entries === i22Fingerprint.excluded_entries &&
      i22Fingerprint.excluded_entries_bounded === false &&
      i22Fingerprint.exclusions_version === 1 &&
      // The count is a COUNT: no file under an excluded path is opened, so quantifying the exclusion does not become an
      // observation of the bytes the exclusion declines to attest.
      s2.countTreeEntries(join(i22Tree, 'node_modules/.vite')).entries === 6 &&
      s2.countTreeEntries(join(i22Tree, 'node_modules/.vite')).bounded === false &&
      s2.countTreeEntries(join(i22Tree, 'node_modules/plain')).entries === 2 &&
      // A missing tree is still a refusal, and now still carries no invented counts.
      s2.observeInstalledTreeFingerprint(join(root, 'i22-absent'), 'metadata') === null,
    JSON.stringify({
      entries: i22Fingerprint.entries,
      raw: i22Fingerprint.entries_raw,
      excluded: i22Fingerprint.excluded_entries,
    }),
  );

  // --- A4. The anti-conservative flag is arithmetic, and says so; the measured 58/59 trap still fires.
  const i22One59 = s2.regressBoundRecord(1, 59);
  check(
    'I22',
    'the-anti-conservative-flag-states-it-is-arithmetic-not-evidence-while-the-measured-58-59-trap-still-fires',
    i22One59.anti_conservative === true &&
      i22One59.anti_conservative_is_evidence_of_defect === false &&
      /ARITHMETIC property of k >= 1/.test(i22One59.anti_conservative_warning) &&
      /NOT by itself evidence of a defect/.test(i22One59.anti_conservative_warning) &&
      /exchangeable p = 0.01 observation/.test(i22One59.anti_conservative_warning) &&
      // The MEASURED evidence is still there and still unweakened.
      /58\/59/.test(i22One59.anti_conservative_warning) &&
      /9\/9/.test(i22One59.anti_conservative_warning) &&
      /byte-identical/.test(i22One59.anti_conservative_warning) &&
      i22One59.value === 0.000869000071526 &&
      i22One59.value * 100 < 0.1 &&
      s2.regressBoundRecord(0, 59).anti_conservative === false &&
      // An ORDINARY exchangeable observation fires the flag too, which is exactly why the flag is not evidence.
      s2.regressBoundRecord(1, 299).anti_conservative === true &&
      s2.regressBoundRecord(1, 299).anti_conservative_is_evidence_of_defect === false &&
      // The tautology is stated as a fact about the arithmetic, not hidden: at k >= 1 the exact limit is ~0.05/n.
      /0\.05\/n/.test(s2.REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS) &&
      /not a measurement of a defect/.test(s2.REPEAT_ANTI_CONSERVATIVE_EVIDENCE_BASIS) &&
      // And the old overstatement is gone from the shipped strings.
      !/signature of a defect that is NOT exchangeable/.test(s2.REPEAT_ANTI_CONSERVATIVE_BASIS) &&
      !/signature of a defect that is not exchangeable/.test(s2.REPEAT_ANTI_CONSERVATIVE_BASIS),
    JSON.stringify({ n59: i22One59.value, evidence: i22One59.anti_conservative_is_evidence_of_defect }),
  );

  // --- A5. Two declarations that named things nothing implemented are GONE or WIRED.
  const i22RuntimeSource = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
  check(
    'I22',
    'the-two-dead-declarations-are-gone-and-the-attestation-state-enum-is-wired-into-the-runtime',
    // DELETED: an allowlist that was never consulted, by a name that claimed five npm config variables survive. The
    // identifier survives in exactly ONE place — the comment recording the removal — and nowhere as code.
    !/const\s+ENV_ALLOWLISTED_NPM_CONFIG/.test(i22RuntimeSource) &&
      !/ENV_ALLOWLISTED_NPM_CONFIG\s*[,\]]/.test(i22RuntimeSource) &&
      (i22RuntimeSource.match(/ENV_ALLOWLISTED_NPM_CONFIG/g) ?? []).length === 1 &&
      // Those five names still exist in the runtime, and they have to: the harness SETS three of them on the child it
      // constructs. What must not exist is a LIST of them for the sanitiser to consult — that is what the removed
      // constant was, and an allowlist nothing reads is the misleading part.
      !/\[\s*'npm_config_(audit|fund|update_notifier|offline|cache)'/.test(i22RuntimeSource) &&
      !/npm_config_(audit|fund|update_notifier|offline|cache)'\]/.test(i22RuntimeSource) &&
      // The sanitiser still drops every npm_config_* by pattern, and the code says why there is no list.
      /npm_config_\/i\.test\(key\)/.test(i22RuntimeSource) &&
      /THERE IS NO npm_config ALLOWLIST/.test(i22RuntimeSource) &&
      // WIRED: the runtime validates its own state enum on read, and the enum is the only definition of it.
      /function workspaceAttestationStateIsKnown/.test(i22RuntimeSource) &&
      /workspaceAttestationStateIsKnown\(parsed\.value\?\.state\)/.test(i22RuntimeSource) &&
      ['preparing', 'usable', 'unusable'].every((state) => s2.workspaceAttestationStateIsKnown(state)) &&
      s2.workspaceAttestationStateIsKnown('usable ') === false &&
      s2.workspaceAttestationStateIsKnown('removed') === false &&
      s2.workspaceAttestationStateIsKnown(undefined) === false &&
      s2.workspaceAttestationStateIsKnown(null) === false &&
      JSON.stringify(s2.WORKSPACE_STATES) === JSON.stringify(['preparing', 'usable', 'unusable']),
    JSON.stringify({
      allowlist: /ENV_ALLOWLISTED_NPM_CONFIG/.test(i22RuntimeSource),
      states: s2.WORKSPACE_STATES,
    }),
  );

  // --- A7. A bare `main` is a path, and a plan that cannot be determined is REFUSED rather than reported as empty.
  check(
    'I22',
    'a-manifest-main-this-program-cannot-read-as-a-path-makes-the-plan-UNDETERMINED-and-is-never-reported-as-empty',
    JSON.stringify(s2.undeterminedEntrypointFields({ main: 'dist/*.js' })) === JSON.stringify([{ field: 'main', value: 'dist/*.js' }]) &&
      JSON.stringify(s2.undeterminedEntrypointFields({ main: 'index.js' })) === JSON.stringify([]) &&
      JSON.stringify(s2.undeterminedEntrypointFields({ types: 'node:fs' })) === JSON.stringify([{ field: 'types', value: 'node:fs' }]) &&
      /NOT recorded as "no build output is required by this gate"/.test(s2.BUILD_PLAN_UNDETERMINED_BASIS) &&
      /fail-closed/.test(s2.BUILD_PLAN_UNDETERMINED_BASIS) &&
      // The claim the basis exists to prevent is a claim about a GATE, so the plan must be able to disagree with it.
      s2.BUILD_STATE_NOT_APPLICABLE_BASIS.includes('EMPTY') === true,
    JSON.stringify({ undetermined: s2.undeterminedEntrypointFields({ main: 'dist/*.js' }) }),
  );

  // --- A8. A build's escape is observed AND its unobserved class is recorded as data.
  const i22EscapeParent = join(root, 'i22-escape', 'work', 'instance');
  mkdirSync(i22EscapeParent, { recursive: true });
  const i22EscapeKinds = s2.buildEscapeRoots(i22EscapeParent).map((entry) => entry.kind);
  // The CONTROLLED root is the worktree's own parent, so a positive and a negative observation are both deterministic
  // and neither depends on what else on this machine happens to be writing to /tmp or $HOME during the run.
  const i22EscapeMarker = 'harness-i22-escape';
  const i22EscapeBefore = s2.beginBuildEscapeObservation(i22EscapeParent);
  mkdirSync(join(dirname(i22EscapeParent), i22EscapeMarker), { recursive: true });
  const i22EscapeAfter = s2.finishBuildEscapeObservation(i22EscapeBefore);
  const i22EscapeParentRoot = i22EscapeAfter.roots.find((entry) => entry.kind === 'worktree_parent');
  rmSync(join(dirname(i22EscapeParent), i22EscapeMarker), { recursive: true, force: true });
  const i22EscapeQuiet = s2.finishBuildEscapeObservation(s2.beginBuildEscapeObservation(i22EscapeParent));
  const i22EscapeQuietParent = i22EscapeQuiet.roots.find((entry) => entry.kind === 'worktree_parent');
  check(
    'I22',
    'a-build-writing-outside-the-worktree-is-DETECTED-and-the-class-this-program-does-not-observe-is-recorded-as-data',
    i22EscapeKinds.includes('worktree_parent') &&
      i22EscapeKinds.includes('home') &&
      i22EscapeKinds.includes('system_tmp') &&
      // A real top-level entry appearing OUTSIDE the worktree is DETECTED, and the name is reported.
      i22EscapeAfter.outside_worktree_write_detected === true &&
      i22EscapeAfter.changed_roots.includes('worktree_parent') &&
      i22EscapeParentRoot.changed === true &&
      i22EscapeParentRoot.added.includes(i22EscapeMarker) &&
      i22EscapeParentRoot.after_count === i22EscapeParentRoot.before_count + 1 &&
      i22EscapeParentRoot.before_digest !== i22EscapeParentRoot.after_digest &&
      // With nothing happening, the controlled root is reported UNCHANGED — the negative control, so a sweep that
      // reported "changed" unconditionally could not pass this assertion.
      i22EscapeQuietParent.changed === false &&
      i22EscapeQuietParent.added.length === 0 &&
      i22EscapeQuietParent.removed.length === 0 &&
      // The UNOBSERVED class is data, in the same record, and it is never quietly promoted to "nothing happened".
      i22EscapeAfter.outside_worktree_writes_fully_observed === false &&
      i22EscapeQuiet.outside_worktree_writes_fully_observed === false &&
      /INSIDE a directory that already existed is NOT detected/.test(i22EscapeAfter.unobserved_class) &&
      /never that the build wrote nothing outside the worktree/.test(i22EscapeAfter.unobserved_class) &&
      /DETECTION and OBSERVABILITY limit, not prevention/i.test(i22EscapeAfter.prevention) &&
      /a worktree is not a security boundary/i.test(i22EscapeAfter.prevention) &&
      /three named roots/.test(i22EscapeAfter.basis) &&
      i22EscapeAfter.observable === 'top_level_names_of_three_named_roots' &&
      i22EscapeAfter.roots.length === i22EscapeKinds.length &&
      // A root that could not be listed says so per root, and claims nothing in either direction.
      (i22EscapeAfter.roots.every((entry) => entry.readable) ||
        i22EscapeAfter.roots.some((entry) => entry.readable === false && /could not be listed/.test(entry.basis))),
    JSON.stringify({
      changed: i22EscapeAfter.changed_roots,
      added: i22EscapeParentRoot.added,
      quietParentChanged: i22EscapeQuietParent.changed,
    }),
  );

  // ---- I23: the replay trust surface — a session token bound to its pair, a trial state re-derived from the run it
  // names, a digest chain that makes a truncation or a rewrite detectable, a reclaim path that can see an orphan, and
  // the refusals and scopes that keep each of those from being read as more than it is.
  //
  // The real executions live in the E22 compatibility family (a real `kill -9` mid-`--repeat` whose worktrees are then
  // reclaimed by the shipped path, a forged trial row, a truncated log, two concurrent runs on one token). What is
  // asserted HERE is what a real execution cannot cheaply prove dozens of times over: that the binding digest CHANGES
  // when any one of the four things that decide what a trial means changes, that a chain entry commits to the entry
  // before it, that an unverified trial is a boundary of its own that agreeing siblings cannot average away, and that
  // each refusal is NAMED and each scope says what it does not do.
  const i23FixtureRoot = suiteTempDir('harness-i23-');

  /** A trial log this program itself wrote: chained, head-published, and byte-exact on disk. */
  const i23WriteChainedLog = (name, rows) => {
    const logPath = join(i23FixtureRoot, `regress-trials-${name}.jsonl`);
    const headPath = join(i23FixtureRoot, `regress-trials-${name}.head.json`);
    let prev = null;

    for (const [index, row] of rows.entries()) {
      const body = { ...row, chain: { genesis: s2.REPEAT_TRIALS_CHAIN_GENESIS, index, prev_digest: prev, entry_digest: null } };

      body.chain.entry_digest = s2.regressTrialEntryDigest(body, prev);
      prev = body.chain.entry_digest;
      writeFileSync(logPath, `${JSON.stringify(body)}\n`, { flag: 'a' });
    }

    writeFileSync(headPath, `${JSON.stringify({ entries: rows.length, head_digest: prev, session_id: name })}\n`);

    return { logPath, headPath, headDigest: prev };
  };

  const i23Binding = (overrides = {}) =>
    s2.regressSessionBinding({
      taskId: 'P1',
      gateName: 'benchmark',
      goodRef: 'good-ref',
      goodCommit: 'a'.repeat(40),
      targetRef: 'target-ref',
      targetCommit: 'b'.repeat(40),
      gateEnvPolicy: 'sanitised',
      ...overrides,
    });

  const i23Rows = (count) =>
    Array.from({ length: count }, (_, index) => ({
      session_id: 'i23',
      trial_index: index,
      invocation_id: 'inv-1',
      sides: { good: null, target: null },
    }));

  // B1: the binding is a function of the pair, the task, the gate and the environment policy, and of nothing else.
  // Each is perturbed in turn and the digest MUST move; the unperturbed binding must NOT. This is what makes a replay
  // of the wrong comparison detectable rather than merely unlikely.
  check(
    'I23',
    'a-session-binding-digest-moves-when-the-pair-the-task-the-gate-or-the-env-policy-moves-and-is-stable-otherwise',
    (() => {
      const base = i23Binding();
      const perturbations = [
        ['good', { goodRef: 'other-good' }],
        ['target', { targetRef: 'other-target' }],
        ['resolved-good', { goodCommit: 'c'.repeat(40) }],
        ['resolved-target', { targetCommit: 'd'.repeat(40) }],
        ['task', { taskId: 'P2' }],
        ['gate', { gateName: 'other-gate' }],
        ['env-policy', { gateEnvPolicy: 'inherited' }],
      ];

      return (
        /^[0-9a-f]{32}$/.test(base.binding_digest) &&
        i23Binding().binding_digest === base.binding_digest &&
        perturbations.every(([, overrides]) => i23Binding(overrides).binding_digest !== base.binding_digest)
      );
    })(),
    JSON.stringify({ digest: i23Binding().binding_digest }),
  );

  // B1: the comparison that refuses a replay reports EVERY differing field BY NAME — a refusal that cannot say which
  // thing differs is indistinguishable from a bug — and an ABSENT binding is a refusal, not a pass.
  check(
    'I23',
    'a-replay-against-a-different-pair-task-gate-or-env-policy-is-REFUSED-BY-NAME-and-an-absent-binding-is-a-refusal',
    (() => {
      const recorded = i23Binding();
      const foreign = s2.compareRegressSessionBindings(recorded, i23Binding({ targetRef: 'never-measured', taskId: 'P9' }));
      const fields = foreign.map((entry) => entry.field);
      const same = s2.compareRegressSessionBindings(recorded, i23Binding());
      const absent = s2.compareRegressSessionBindings(null, i23Binding());
      const edited = s2.compareRegressSessionBindings({ ...recorded, binding_digest: 'f'.repeat(32) }, recorded);

      return (
        s2.REPLAY_REFUSAL_NAMES.includes(s2.REPLAY_REFUSAL_SESSION_BINDING) &&
        // Each difference is named, and the names are the ones an operator would have to correct.
        fields.includes('requested.target') && fields.includes('task_id') &&
        foreign.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0) &&
        // The identical comparison is not a refusal: a bound token must still be able to resume its own run.
        same.length === 0 &&
        // A log with no binding established nothing, so "I could not check it" is the only honest reading.
        absent.length === 1 && absent[0].field === 'session_binding' &&
        // A binding whose digest disagrees with its own fields was edited after it was written.
        edited.length === 1 && edited[0].field === 'binding_digest'
      );
    })(),
  );

  // B2: a replayed trial's state is RE-DERIVED, never believed. A trial naming a run that does not exist is unverified by
  // a NAMED reason, and the same verdict is reached for a trial object that is not there at all.
  check(
    'I23',
    'a-replayed-trial-naming-a-run-that-does-not-exist-is-UNVERIFIED-by-name-and-never-trusted',
    (() => {
      const missing = s2.verifyRegressTrialAgainstRunStream(
        { run_id: 'run-that-never-existed', gate_exit_code: 0, state: 'PASS', observed_judged_commit: 'a'.repeat(40) },
        'target',
      );
      const nameless = s2.verifyRegressTrialAgainstRunStream({ state: 'PASS' }, 'target');
      const notAnObject = s2.verifyRegressTrialAgainstRunStream(null, 'target');

      return (
        missing.verified === false &&
        missing.reason === 'run_stream_not_found' &&
        /never issued/.test(flattenProse(missing.detail)) &&
        nameless.verified === false && nameless.reason === 'no_run_id_recorded' &&
        notAnObject.verified === false && notAnObject.reason === 'trial_object_missing' &&
        // The basis travels with every verdict, so "unverified" is never a bare flag.
        /RE-DERIVED/.test(flattenProse(missing.basis)) &&
        /not classifiable from it/.test(flattenProse(missing.basis))
      );
    })(),
  );

  // B2: the unverified boundary in the AGGREGATE. Four trials that all say PASS, one of which cannot be re-derived, must
  // NOT resolve to PASS: the rule is the contradiction rule, and an unverified trial is a contradiction of its own kind
  // that agreeing siblings never average away. `classifiable: false` is what makes the side unusable as a direction.
  check(
    'I23',
    'four-agreeing-trials-one-unverified-are-INCONCLUSIVE-and-the-side-is-NOT-classifiable-from-it',
    (() => {
      const trials = [0, 1, 2, 3].map((index) => ({
        trial_index: index,
        state: 'PASS',
        run_id: `run-${index}`,
        observed_judged_commit: 'a'.repeat(40),
        gate_exit_code: 0,
        verified: index === 2 ? false : true,
        verification_reason: index === 2 ? 'run_stream_not_found' : null,
      }));
      const decision = s2.classifyRegressTrials(trials, 4);

      return (
        decision.classification === 'INCONCLUSIVE' &&
        decision.classification_rule_id === 'trial_unverified_not_averaged_away' &&
        decision.undecidable_cause === s2.REPEAT_UNDECIDABLE_CAUSE_UNVERIFIED &&
        decision.classifiable === false &&
        decision.unverified_trials === 1 &&
        decision.unverified_trial_indices.includes(2) &&
        // The agreeing trials are named as NOT being a reason to proceed.
        /do NOT average it away/.test(flattenProse(decision.reason)) &&
        decision.vote_used === false
      );
    })(),
  );

  // B2: the same aggregate with NO unverified trial must still decide unanimously, so the new boundary is not simply a
  // way of refusing everything. And an unverified trial must not be confusable with an ERROR trial: they are different
  // rules with different causes, and both are distinct from a PASS.
  check(
    'I23',
    'the-unverified-boundary-does-not-destroy-an-unanimous-verified-side-and-is-distinct-from-an-ERROR-trial',
    (() => {
      const clean = [0, 1].map((index) => ({
        trial_index: index,
        state: 'PASS',
        run_id: `run-${index}`,
        observed_judged_commit: 'a'.repeat(40),
        gate_exit_code: 0,
        verified: true,
      }));
      const unanimous = s2.classifyRegressTrials(clean, 2);
      const errored = s2.classifyRegressTrials(
        [{ ...clean[0] }, { ...clean[1], state: 'ERROR', verified: true }],
        2,
      );
      const unverified = s2.classifyRegressTrials([{ ...clean[0] }, { ...clean[1], verified: false }], 2);

      return (
        unanimous.classification === 'PASS' && unanimous.classifiable === true && unanimous.unverified_trials === 0 &&
        errored.classification === 'ERROR' && errored.classification_rule_id === 'trial_error_not_averaged_away' &&
        unverified.classification === 'INCONCLUSIVE' &&
        // The three are three different rules, not one rule with three labels.
        new Set([unanimous.classification, errored.classification, unverified.classification]).size === 3
      );
    })(),
  );

  // B3: the chain. Each entry commits to the PREVIOUS entry's digest, so an interior rewrite breaks every later link,
  // and the chain is a detection mechanism for THIS PROGRAM — never described as tamper-proof.
  check(
    'I23',
    'a-chained-trial-log-verifies-and-an-interior-rewrite-and-a-tail-truncation-are-both-DETECTED-and-recorded',
    (() => {
      const { logPath, headPath, headDigest } = i23WriteChainedLog('intact', i23Rows(3));
      const intact = s2.regressReadTrialLogVerified(logPath, { headPath });

      // Rewrite row 1 in place: the row still parses and still claims a digest, but it no longer hashes to it.
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      const tampered = JSON.parse(lines[1]);

      tampered.trial_index = 99;
      const rewritten = [lines[0], JSON.stringify(tampered), ...lines.slice(2)].join('\n') + '\n';
      writeFileSync(join(i23FixtureRoot, 'regress-trials-rewritten.jsonl'), rewritten);
      const afterRewrite = s2.regressReadTrialLogVerified(join(i23FixtureRoot, 'regress-trials-rewritten.jsonl'), {
        headPath,
      });

      // Truncate the TAIL: an unbroken chain over the retained rows cannot see this, which is exactly why the head exists.
      const { logPath: tailPath, headPath: tailHead } = i23WriteChainedLog('tailed', i23Rows(3));

      writeFileSync(tailPath, `${lines.length > 0 ? readFileSync(tailPath, 'utf8').split('\n').filter(Boolean).slice(0, 2).join('\n') + '\n' : ''}`);
      const afterTruncation = s2.regressReadTrialLogVerified(tailPath, { headPath: tailHead });

      return (
        intact.chain.verified === true &&
        intact.chain.entries === 3 && intact.chain.verified_entries === 3 &&
        intact.chain.head_agrees === true && intact.chain.head_digest === headDigest &&
        // The rewrite is caught, the reason is recorded, and the row is removed from TRUST rather than repaired.
        afterRewrite.chain.verified === false &&
        typeof afterRewrite.chain.break_reason === 'string' && afterRewrite.chain.break_reason.length > 0 &&
        afterRewrite.chain.verified_entries < afterRewrite.chain.entries &&
        // The tail truncation is caught by the head, which is the ONLY thing that can see it.
        afterTruncation.chain.verified === false &&
        afterTruncation.chain.head_agrees === false &&
        /truncated or rows were added out of band/.test(flattenProse(afterTruncation.chain.head_reason)) &&
        // The claim is explicitly a DETECTION claim and explicitly not an authenticity claim.
        /DETECTS that/.test(flattenProse(s2.REPEAT_TRIALS_CHAIN_LIMIT)) &&
        /does not make the log tamper-proof/.test(flattenProse(s2.REPEAT_TRIALS_CHAIN_LIMIT)) &&
        /smaller claim than authenticity/.test(flattenProse(s2.REPEAT_TRIALS_CHAIN_LIMIT)) &&
        /a chain over the retained rows cannot see a TAIL truncation/.test(flattenProse(s2.REPEAT_TRIALS_CHAIN_LIMIT))
      );
    })(),
  );

  // B3: `append_only: true` and `rewritten: false` are backed by the mechanism, and the mechanism's reach is stated. A
  // reader must not be able to read those two flags as a claim that the bytes cannot be altered.
  check(
    'I23',
    'the-append-only-and-rewritten-false-flags-name-a-detection-mechanism-and-NOT-immutability',
    /THIS PROGRAM'S OWN WRITES/.test(flattenProse(s2.REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE)) &&
      /NOT a claim that the bytes cannot be altered/.test(flattenProse(s2.REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE)) &&
      /a same-principal writer controls the log, the head file and this program/.test(
        flattenProse(s2.REPEAT_TRIALS_LOG_APPEND_ONLY_SCOPE),
      ),
  );

  // B8: a trial index recorded TWICE under two different invocations is detected and refused by name. The pre-fix reader
  // kept the first silently, which collapsed two independent measurements into one with no diagnostic at all.
  check(
    'I23',
    'a-trial-index-recorded-twice-under-two-invocations-is-DETECTED-and-a-named-refusal',
    (() => {
      const rows = i23Rows(2);

      // The second row re-uses index 0 under a different invocation: two concurrent runs on one token.
      const collision = [rows[0], { ...rows[0], invocation_id: 'inv-2' }];
      const { logPath, headPath } = i23WriteChainedLog('collision', collision);
      const read = s2.regressReadTrialLogVerified(logPath, { headPath });
      const duplicates = read.chain.duplicate_trial_indices;
      const refusal = s2.regressReplayRefusal({
        logRead: read,
        sessionBinding: i23Binding(),
        regressSession: 'collision',
      });

      return (
        duplicates.length === 1 &&
        duplicates[0].trial_index === 0 &&
        // The refusal is NAMED, and it is one of the three names a caller can act on.
        refusal !== null &&
        refusal.refusal === s2.REPLAY_REFUSAL_DUPLICATE &&
        s2.REPLAY_REFUSAL_NAMES.includes(refusal.refusal) &&
        // It says which index collided and that keeping the first was the pre-fix behaviour.
        /trial 0/.test(flattenProse(refusal.lines.join(' '))) &&
        /silently kept the FIRST/.test(flattenProse(refusal.lines.join(' ')))
      );
    })(),
  );

  // B8: the CHOSEN answer is detection, and the reason is a measurement, not a preference. An O_EXCL per-session lock
  // was built and removed: `kill -9` never releases it and `process.kill(pid, 0)` succeeds against a ZOMBIE, so the lock
  // refused the very resume it existed to protect.
  check(
    'I23',
    'concurrency-is-DETECTED-not-locked-and-the-rejected-lock-is-refused-on-a-measured-ground',
    /concurrency is DETECTED, not locked/.test(flattenProse(s2.REPLAY_CONCURRENCY_BASIS)) &&
      /ZOMBIE/.test(flattenProse(s2.REPLAY_CONCURRENCY_BASIS)) &&
      /refused the very resume it existed to protect/.test(flattenProse(s2.REPLAY_CONCURRENCY_BASIS)) &&
      /trades silent corruption for a wedge/.test(flattenProse(s2.REPLAY_CONCURRENCY_BASIS)),
  );

  // B4: the orphan scan. A directory the attestation set does not name is an orphan, and the scan must FIND it — the
  // pre-fix `prune` reported "considered: 2, every removal succeeded" while five worktrees no shipped path could reach.
  check(
    'I23',
    'the-directory-scan-FINDS-an-unattested-worktree-and-names-the-ones-an-attestation-stands-behind',
    (() => {
      const root = join(i23FixtureRoot, 'wt-root');
      const key = 'a'.repeat(16);
      const attested = join(root, key, 'inst-a');
      const orphan = join(root, key, 'inst-b');
      const other = join(root, 'b'.repeat(16), 'inst-c');

      for (const directory of [attested, orphan, other]) mkdirSync(directory, { recursive: true });
      // A directory the scan must IGNORE: it is not this program's two-level layout.
      mkdirSync(join(root, 'not-a-key'), { recursive: true });

      const found = s2.scanWorkspaceOrphans(root, [attested]);
      const foundPaths = found.orphans.map((entry) => entry.directory);

      return (
        found.scanned === true &&
        found.orphans.length === 2 &&
        foundPaths.includes(orphan) && foundPaths.includes(other) &&
        // The attested one is not reported as an orphan of its own existence.
        !foundPaths.includes(attested) &&
        // And the report is honest about what it is: a NAME comparison, never an inspection of the contents.
        /opens no file inside an orphan/.test(flattenProse(found.basis)) &&
        /no shipped path can reach/.test(flattenProse(found.basis))
      );
    })(),
  );

  // B4: the negative control. A root with nothing unattested must report NO orphans, so "orphans: 2" above is a finding
  // and not the shape every scan returns. An absent root is reported as "not scanned" rather than as "clean".
  check(
    'I23',
    'an-orphan-scan-of-a-root-with-nothing-unattested-reports-none-and-an-absent-root-is-not-scanned',
    (() => {
      const root = join(i23FixtureRoot, 'wt-clean');
      const attested = join(root, 'c'.repeat(16), 'inst-a');

      mkdirSync(attested, { recursive: true });
      const clean = s2.scanWorkspaceOrphans(root, [attested]);
      const absentRoot = join(i23FixtureRoot, 'wt-absent');
      const absent = s2.scanWorkspaceOrphans(absentRoot, []);

      return clean.orphans.length === 0 && clean.scanned === true && absent.scanned === false && absent.orphans.length === 0;
    })(),
  );

  // B5: the cross-trial comparison is over EVERY trial, and a MATERIAL field that varies WITHIN one side is a
  // contradiction. The trial-0-only comparison would have reported the two sides as identical.
  check(
    'I23',
    'the-environment-comparison-reads-ALL-trials-and-a-material-field-varying-WITHIN-a-side-is-a-contradiction',
    (() => {
      // A MATERIAL field (`matters: true`) is the one whose variation is a contradiction rather than a disclosure.
      // `build_state_digest` is `matters: false` on purpose, so the moving case uses `installed_state_digest`.
      const trial = (overrides) => ({
        observed_judged_commit: 'a'.repeat(40),
        lockfile_digest: 'same-lock',
        workspace_installed_state_digest: 'd1',
        environment_record: { node: { version: '22.0.0' } },
        ...overrides,
      });
      const stable = s2.compareRegressEnvironmentsAcrossTrials(
        [trial({}), trial({})],
        [trial({}), trial({})],
      );
      // Three installed-state digests across the target's own trials: a material field varying WITHIN one side.
      const moving = s2.compareRegressEnvironmentsAcrossTrials(
        [trial({})],
        [
          trial({ workspace_installed_state_digest: 'd1' }),
          trial({ workspace_installed_state_digest: 'd2' }),
          trial({ workspace_installed_state_digest: 'd3' }),
        ],
      );

      return (
        // It compares across all trials, and says so in the field a reader checks.
        stable.scope === 'all_trials' && stable.trial_0_only === false && stable.trials_compared === 4 &&
        stable.contradiction === false &&
        // A field that varies WITHIN a side is evidence, and it is named.
        moving.contradiction === true &&
        moving.contradiction_fields.includes('installed_state_digest') &&
        moving.material_varying_fields.includes('installed_state_digest') &&
        moving.varying_fields.includes('installed_state_digest') &&
        /under the disagreement rule it makes both sides INCONCLUSIVE rather than producing a direction/.test(
          flattenProse(moving.basis),
        ) &&
        // A NON-material field varying is a DISCLOSURE, never a contradiction — the two are not conflated.
        s2.compareRegressEnvironmentsAcrossTrials(
          [trial({})],
          [trial({ workspace_build_state_digest: 'b1' }), trial({ workspace_build_state_digest: 'b2' })],
        ).contradiction === false
      );
    })(),
  );

  // B5: the aggregate consequence. The rule that makes a cross-trial environment contradiction undecidable is NAMED
  // and lives in the same family as every other classification rule, so a reader is told WHICH boundary produced the
  // classification. The real end-to-end consequence — both sides INCONCLUSIVE and no direction — is in E22-05, because
  // it needs a real `--repeat` run to observe.
  check(
    'I23',
    'a-cross-trial-environment-contradiction-is-a-NAMED-rule-in-the-same-family-as-every-other-classification',
    (() => {
      const across = s2.compareRegressEnvironmentsAcrossTrials(
        [
          { observed_judged_commit: 'a'.repeat(40), workspace_installed_state_digest: 'd1' },
          { observed_judged_commit: 'a'.repeat(40), workspace_installed_state_digest: 'd2' },
        ],
        [{ observed_judged_commit: 'a'.repeat(40), workspace_installed_state_digest: 'd1' }],
      );

      return (
        // The rule id is one of the exported rule ids, so it is nameable in an artifact.
        s2.REPEAT_RULE_IDS.includes('pair_input_disagrees_across_trials') &&
        // A within-side material variation IS that contradiction, and the field is named.
        across.contradiction === true &&
        across.contradiction_fields.includes('installed_state_digest') &&
        // The two sides' trials were compared over all three of them, not trial 0.
        across.trials_compared === 3 &&
        // And the rule names the reason in the same shape the other rules use.
        /^pair_input_disagrees/.test('pair_input_disagrees_across_trials') &&
        s2.REPEAT_RULE_IDS.every((rule) => typeof rule === 'string' && rule.length > 0)
      );
    })(),
  );

  // B6: the message names a mechanism that EXISTS. `REPEAT_MAX_TRIALS` is a count, the byte bound is a separate and
  // enforced size limit, and neither is described as the other.
  check(
    'I23',
    'the-repeat-limit-is-named-as-a-COUNT-and-the-trial-log-byte-bound-is-a-separate-ENFORCED-size-limit',
    s2.REPEAT_MAX_TRIALS === 299 &&
      Number.isInteger(s2.REPEAT_TRIALS_LOG_MAX_BYTES) &&
      s2.REPEAT_TRIALS_LOG_MAX_BYTES > 0 &&
      /a COUNT of trials per side/.test(flattenProse(s2.REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS)) &&
      /checked by appendRegressTrialEntry BEFORE every append/.test(flattenProse(s2.REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS)) &&
      /REFUSED with TRIAL_LOG_BYTE_BOUND_EXCEEDED and no entry is written/.test(
        flattenProse(s2.REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS),
      ) &&
      /the log is not rotated/.test(flattenProse(s2.REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS)) &&
      // The count is NOT called a byte bound anywhere, which is the pre-fix defect.
      !/the byte bound on the trial log/i.test(flattenProse(s2.REPEAT_TRIALS_LOG_BYTE_BOUND_BASIS)),
  );

  // B6: the bound is a SIZE limit and the count is a COUNT, and both are separately reachable — 299 is refused on the
  // count, not on a size, so neither limit silently stands in for the other.
  check(
    'I23',
    'a-N-beyond-the-count-is-refused-and-the-two-limits-are-not-conflated',
    (() => {
      const trials = s2.regressResolveTrials;
      let outOfRange = null;
      let malformed = null;

      try { trials('300'); } catch (error) { outOfRange = error; }
      try { trials('0'); } catch (error) { malformed = error; }

      return (
        outOfRange !== null && /between 1 and 299/.test(flattenProse(String(outOfRange.message ?? outOfRange))) &&
        // The refusal names the count and points at the SEPARATE size bound, rather than claiming to be it.
        /a COUNT of trials per side/.test(flattenProse(String(outOfRange.message ?? outOfRange))) &&
        /separate SIZE limit/.test(flattenProse(String(outOfRange.message ?? outOfRange))) &&
        // The pre-fix text called THIS number "the byte bound on the trial log", which it never was.
        !/the byte bound on the trial log/i.test(flattenProse(String(outOfRange.message ?? outOfRange))) &&
        malformed !== null &&
        // N = 1 and N = 2 are both accepted, so the default and the ordinary case are unchanged.
        trials('1') === 1 && trials('2') === 2 && trials(undefined) === s2.REPEAT_DEFAULT_TRIALS
      );
    })(),
  );

  // B7: `--out` into a reserved state directory is REFUSED BY NAME, never honoured and never silently redirected. The
  // pre-fix guard covered `state/control` alone, so an artifact landed in the run-stream directory `readRunRecords`
  // enumerates as evidence, where `report` then failed outright on it and still exited 0.
  check(
    'I23',
    'an-out-path-into-a-reserved-state-directory-is-REFUSED-BY-NAME-and-never-silently-redirected',
    (() => {
      const runs = join(REAL_REPO_ROOT, '.harness/state/runs');
      const trials = join(REAL_REPO_ROOT, '.harness/state/regress-trials');
      const attempts = [
        join(runs, 'artifact.jsonl'),
        join(trials, 'artifact.json'),
        join(REAL_REPO_ROOT, '.harness/state/tasks', 'artifact.json'),
        join(REAL_REPO_ROOT, '.harness/state/ledgers', 'artifact.json'),
      ];
      const results = attempts.map((target) => {
        try {
          s2.resolveExternalOutputPath(target);
          return { target, refused: false, message: '' };
        } catch (error) {
          return { target, refused: true, message: flattenProse(String(error?.message ?? error)) };
        }
      });

      return (
        results.length === 4 &&
        results.every((entry) => entry.refused) &&
        // Each refusal NAMES the directory and says it is never silently redirected.
        results.every((entry) => /must not target/.test(entry.message) && /never silently redirected/.test(entry.message)) &&
        results.some((entry) => /readRunRecords reads as evaluation evidence/.test(entry.message)) &&
        // Nothing was created: a refusal is not a write.
        !existsSync(join(runs, 'artifact.jsonl')) && !existsSync(join(trials, 'artifact.json'))
      );
    })(),
  );

  // The scope statements. Every standing limitation must survive this pass UNSOFTENED, and the same-principal limit in
  // particular must never be described as fixed, because forging the bytes of a log was never the defect.
  check(
    'I23',
    'the-replay-scope-states-what-is-NOT-fixed-and-keeps-every-standing-limitation-intact',
    /NOT FIXED, AND NOT CLAIMED/.test(flattenProse(s2.REPLAY_TRUST_SCOPE)) &&
      /cannot prevent that/.test(flattenProse(s2.REPLAY_TRUST_SCOPE)) &&
      /controls the gate, the contract, the acceptance policy, the dependencies, the evaluator and the ledger/.test(
        flattenProse(s2.REPLAY_TRUST_SCOPE),
      ) &&
      /a worktree is not a security boundary/.test(flattenProse(s2.REPLAY_TRUST_SCOPE)) &&
      // What IS fixed is only the assertion of unchecked properties, and it authenticates nothing.
      /no longer ASSERTS properties it has not checked/.test(flattenProse(s2.REPLAY_TRUST_SCOPE)) &&
      /None of them authenticates a result/.test(flattenProse(s2.REPLAY_TRUST_SCOPE)) &&
      // The refusals all carry the scope.
      s2.REPLAY_REFUSALS.includes(s2.REPLAY_TRUST_SCOPE) &&
      s2.REPLAY_REFUSALS.every((entry) => typeof entry === 'string' && entry.length > 0),
  );

  // No guarantee word may appear as a predicate claim anywhere in the new surfaces.
  check(
    'I23',
    'no-guarantee-word-appears-in-any-of-the-new-replay-scopes-refusals-or-bases',
    ![s2.REPLAY_TRUST_SCOPE, s2.REPLAY_CONCURRENCY_BASIS, s2.REPEAT_TRIALS_CHAIN_LIMIT, ...s2.REPLAY_REFUSALS]
      .join(' ')
      .match(/\b(stable|confirmed|reproducible)\b/i),
  );

  rmSync(i23FixtureRoot, { recursive: true, force: true });

  // ---- I25: the documentation-truth group.
  //
  // F1 was a documentation BLOCKER, and the reason is structural rather than cosmetic: the two paragraphs that tell a
  // reader to "read the numbers off the run instead of trusting a remembered literal" then PRINTED remembered literals,
  // and they were wrong (314 / 26 / 134 against a real 360 / 29 / 158). A number in prose cannot verify itself, so
  // correcting it would have bought one cycle. The three assertions below are what stop it rotting: the self-test total
  // and invariant count are compared against the literals in BOTH documents, and the compatibility total is compared
  // against a count COMPUTED from the compatibility suite's own label table — never against a golden value held here.
  //
  // The self-test counts are self-referential by exactly one, because this assertion is the last one recorded: the
  // totals it compares are the totals it is about to become. That is arithmetic, not a fudge, and it is stated here so
  // a future reader does not have to derive it.
  const agentsDoc = flattenProse(readFileSync(join(REAL_REPO_ROOT, 'AGENTS.md'), 'utf8'));
  const readmeDoc = flattenProse(readFileSync(join(REAL_REPO_ROOT, '.harness/README.md'), 'utf8'));
  const compatibilitySource = readFileSync(join(TESTS_DIR, 'compatibility.mjs'), 'utf8');
  // The compatibility total is COMPUTED, not remembered: the number of case BODIES in that file, which is exactly what
  // `main()` iterates and what a run prints one PASS line per. Counting the LABEL array was tried and is wrong — entries
  // there are not all formatted alike, so a source-level label count silently disagrees with the run it is describing.
  // `SAN-09` independently asserts that every declared label has a real body, so neither side can drift on its own.
  const compatibilityTotal = (compatibilitySource.match(/^cases\['/gm) ?? []).length;
  // F5. The three duplicate keys. Each was harmless on its own day — identical values, last one wins — which is exactly
  // why they were dangerous: a duplicate key is invisible to a reader, invisible to this project's linter, and would
  // silently keep a DIFFERENT value the moment the two copies diverged. This reads the SOURCE rather than the loaded
  // object, because a duplicate key leaves no trace in the value: by the time an object exists, the evidence is gone.
  const runtimeSource = readFileSync(join(REAL_REPO_ROOT, '.harness/runtime/harness.mjs'), 'utf8');
  // The window is the injection LITERAL, and it is anchored to the literal's real terminator — SIX spaces of indent,
  // which is how `return runSelfTest({` closes. A four-space terminator never occurs there, so the lazy match ran on
  // past the object and scanned the ~1 100 lines that follow it: unrelated commands and constants, whose object keys
  // are not keys of this object at all. The property checked is UNCHANGED (no key of the injection object repeats);
  // only the region scanned becomes the region the assertion names, so a real duplicate is now caught sooner rather
  // than masked by a coincidence of key names elsewhere in the file.
  const selfTestInjection = /return runSelfTest\(\{[\s\S]*?\n {6}\}\);/.exec(runtimeSource)?.[0] ?? '';
  // Both spellings, because the injection literal uses SHORTHAND entries (`name,`) and a `key:` pattern would count
  // zero of them — a zero that would otherwise have read as a pass.
  const countKeys = (source, key) => (source.match(new RegExp(`^\\s*${key}\\s*[:,]`, 'gm')) ?? []).length;
  // EVERY key in the literal, so the assertion is about the object and not about the three keys that happened to be
  // duplicated today. A duplicate is invisible to a reader and to the linter, and would silently keep a DIFFERENT value
  // the moment two copies diverged — so the property is `no key repeats`, not `these three keys appear once`.
  const injectionKeys = [...selfTestInjection.matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[:,]/gm)].map((match) => match[1]);

  check(
    'I25',
    'the-self-test-injection-object-has-no-duplicate-key',
    selfTestInjection.length > 0 &&
      injectionKeys.length > 50 &&
      new Set(injectionKeys).size === injectionKeys.length &&
      // The two that were duplicated, named so a regression points at the key rather than at a count.
      countKeys(selfTestInjection, 'classifyRegressTrials') === 1 &&
      countKeys(selfTestInjection, 'withRegressVerdictBasis') === 1,
    `keys=${injectionKeys.length} unique=${new Set(injectionKeys).size} ` +
      `classifyRegressTrials=${countKeys(selfTestInjection, 'classifyRegressTrials')} ` +
      `withRegressVerdictBasis=${countKeys(selfTestInjection, 'withRegressVerdictBasis')}`,
  );
  const regressTrialsAggregate = /function classifyRegressTrials\([\s\S]*?\n  return \{[\s\S]*?\n  \};/.exec(
    runtimeSource,
  )?.[0] ?? '';
  check(
    'I25',
    'the-repeated-trial-aggregate-object-has-no-duplicate-classifiable-key',
    regressTrialsAggregate.length > 0 && countKeys(regressTrialsAggregate, 'classifiable') === 1,
    `classifiable=${countKeys(regressTrialsAggregate, 'classifiable')}`,
  );

  // F6. The printed label and the manual must agree. The label is GENERATED from REGRESS_EXIT_FIVE_BASIS, so the
  // assertion is that the single definition exists, names BOTH situations, and that the documentation repeats both —
  // not that a hand-written string happens to match.
  //
  // S1-SITE1 (REPOINTED, I2a). Both documentation conjuncts now read the HARNESS manual, `.harness/README.md`, which is
  // the document that owns the `regress` exit table. `**`5` covers BOTH**` used to be asserted against `AGENTS.md`, the
  // only carrier of that exact bold span in the tree; the manual carried a different wording for the same claim, and the
  // same check asserted THAT separately. The manual's sentence now carries the shared literal verbatim and keeps its own
  // two-situations clause, so one span and one check name the claim and `AGENTS.md` is no longer read for it. The second
  // conjunct is the SAME claim in the SAME words as the manual now states them — it was NOT weakened, it was retargeted
  // at the new wording; the assertion still requires the manual to say BOTH, not merely `5`.
  const fiveBasis = flattenProse(s2.REGRESS_EXIT_FIVE_BASIS);
  check(
    'I25',
    'exit-5-has-one-definition-that-names-both-situations-and-the-manual-repeats-both',
    s2.REGRESS_EXIT_INCONCLUSIVE === 5 &&
      /a side is INCONCLUSIVE, OR no verdict could be derived at all/.test(fiveBasis) &&
      /trial-log byte bound, which is a command-local ENVIRONMENT failure/.test(fiveBasis) &&
      /no seventh code was minted|never a finding, and it is never a red side/.test(fiveBasis) &&
      /\*\*`5` covers BOTH\*\*/.test(readmeDoc) &&
      /\*\*`5` covers BOTH\*\* — two situations, and the printed label names both\./.test(readmeDoc) &&
      // And the contradicting label is gone from the code, not merely out of the docs.
      !/'exit:\s+5 \(command-local environment failure\)'/.test(runtimeSource) &&
      !/`exit:\s+5 \(command-local environment failure\)`/.test(runtimeSource),
    fiveBasis.slice(0, 160),
  );
  check(
    'I25',
    'S1-SITE1-the-harness-manual-that-owns-the-regress-exit-table-carries-the-5-covers-BOTH-span-and-its-two-situations-clause',
    // Named replacement for the `AGENTS.md` conjunct repointed out of the assertion above. The SAME literal in the SAME
    // bold span, and the SAME two-situations clause the manual states, are now required of the harness-layer manual by
    // name — so the claim has a named owner rather than depending on a consumer-facing entry point that a later
    // relocation step is free to slim down. The negative half is unchanged and still scans the CODE, where a contradicting
    // label would actually live; nothing here is relaxed, only relocated.
    /\*\*`5` covers BOTH\*\*/.test(readmeDoc) &&
      /— two situations, and the printed label names both\./.test(readmeDoc) &&
      // The two situations the span is about, named individually, so a future edit cannot satisfy the span by asserting
      // a count and dropping the content.
      /a side `INCONCLUSIVE`/.test(readmeDoc) &&
      /trial-log byte bound/.test(readmeDoc) &&
      // The refusal line still prints the reason beside the number: the `why` the single definition exists to preserve.
      // `readmeDoc` is `flattenProse`d, so this is a single space and cannot be satisfied or broken by a prettier wrap.
      /the refusal line prints the reason beside the number/.test(readmeDoc) &&
      !/'exit:\s+5 \(command-local environment failure\)'/.test(runtimeSource),
    JSON.stringify({
      readme_covers_both: /\*\*`5` covers BOTH\*\*/.test(readmeDoc),
      readme_two_situations_clause: /— two situations, and the printed label names both\./.test(readmeDoc),
      readme_inconclusive: /a side `INCONCLUSIVE`/.test(readmeDoc),
      readme_byte_bound: /trial-log byte bound/.test(readmeDoc),
      code_label_absent: !/'exit:\s+5 \(command-local environment failure\)'/.test(runtimeSource),
    }),
  );

  // F8. The concurrency basis must state the decisive evidence AND the cost, and both must survive a later edit that
  // trims prose. A footnote is not a cost.
  const concurrencyBasis = flattenProse(s2.REPLAY_CONCURRENCY_BASIS);
  check(
    'I25',
    'the-concurrency-basis-states-the-resume-never-appends-evidence-and-the-non-recovery-cost',
    /RESUMING NEVER APPENDS/.test(concurrencyBasis) &&
      /growing --repeat on that same token appends exactly the new indices and no others/.test(concurrencyBasis) &&
      /it does NOT recover/.test(concurrencyBasis) &&
      /must be ABANDONED/.test(concurrencyBasis) &&
      /The interleaved rows are KEPT/.test(concurrencyBasis) &&
      /every later replay of that token re-refuses/i.test(concurrencyBasis) &&
      /stated as a COST and not as a footnote/.test(concurrencyBasis),
    concurrencyBasis.slice(0, 160),
  );

  // F2 + F3, structurally. Both are behavioural in the CLI (the compatibility cases E23-01..E23-05 are the evidence);
  // what is asserted here is that the RECORD SURFACES exist and carry the additive fields, so a future plan that dropped
  // them would fail here rather than silently returning to the constant-red shape.
  check(
    'I25',
    'the-record-carries-both-undetermined-build-plan-causes-and-the-key-level-scan-fields',
    /[Aa] `workspaces` pattern this program cannot enumerate/.test(s2.BUILD_PLAN_UNDETERMINED_BASIS) &&
      /Enumerating a glob soundly was considered and rejected/.test(s2.BUILD_PLAN_UNDETERMINED_BASIS) &&
      /the <key> level itself is classified/.test(s2.WORKSPACE_ORPHAN_SCAN_BASIS) &&
      typeof s2.reclaimEmptyWorkspaceKey === 'function' &&
      typeof s2.scanWorkspaceOrphans === 'function',
    s2.BUILD_PLAN_UNDETERMINED_BASIS.slice(0, 120),
  );

  // F4. The measured gate-undefined figure, where an operator reads the NO-GO, with its basis, and stated as undefined
  // rather than red. The numbers are re-derived here from the repository itself, so the document cannot drift from the
  // history it describes.
  //
  // THE WINDOW IS PINNED TO A NAMED RANGE, not to "the last 143 commits" (the defect this line used to encode). A
  // sliding window over LIVE history compared against a FROZEN constant is red on every commit that lands after the
  // constant was measured: `eb0c73a` was the 144th commit, so the oldest one — `1e06f13`, which declares no
  // `ui typecheck` — fell out of the window, the measured count went 86 -> 85, and the literal stayed at 86. Re-basing
  // the literal to 85 would have moved the cliff to the NEXT commit rather than removed it. So the range is named at its
  // TIP instead: the window is the 143 commits ENDING AT `I25_CENSUS_TIP`, the commit the figure was measured at, which
  // is immutable however many commits land on top of it. The tip is additionally asserted to be an ANCESTOR of `HEAD`, so
  // a rewritten history fails loudly here rather than silently measuring a different range, and the window's own first
  // entry is asserted equal to the tip, so the range cannot quietly become a different one.
  const I25_CENSUS_TIP = 'bcf7b1986da6961a3436c138a6900f0d8b013136';
  const historyWindow = 143;
  const history = git(
    ['log', '--format=%H', '-n', String(historyWindow), I25_CENSUS_TIP],
    REAL_REPO_ROOT,
  ).stdout.trim().split('\n');
  const censusTipIsAncestor = git(['merge-base', '--is-ancestor', I25_CENSUS_TIP, 'HEAD'], REAL_REPO_ROOT).status === 0;
  const withoutUiTypecheck = history.filter((commit) => {
    const raw = git(['show', `${commit}:ui/package.json`], REAL_REPO_ROOT).stdout;
    try {
      return typeof JSON.parse(raw).scripts?.typecheck !== 'string';
    } catch {
      return true;
    }
  });
  const boundary = [...history].reverse().find((commit) => !withoutUiTypecheck.includes(commit)) ?? null;
  const boundaryIndex = boundary === null ? -1 : history.indexOf(boundary);
  const contiguous = withoutUiTypecheck.every((commit) => history.indexOf(commit) >= boundaryIndex);
  const schemaDoc = flattenProse(readFileSync(join(REAL_REPO_ROOT, '.harness/docs/schemas.md'), 'utf8'));
  const readmeNoGo = /### Recorded NO-GO: automatic `git bisect`[\s\S]*?### Repeated evaluation/.exec(readmeDoc)?.[0] ?? '';
  const schemaNoGo = /### 2a\.5 Recorded NO-GO[\s\S]*?### 2b\./.exec(schemaDoc)?.[0] ?? '';

  check(
    'I25',
    'the-gate-is-UNDEFINED-over-86-of-143-commits-recorded-where-an-operator-reads-the-NO-GO-and-not-as-red',
    history.length === historyWindow &&
      history[0] === I25_CENSUS_TIP &&
      censusTipIsAncestor &&
      withoutUiTypecheck.length === 86 &&
      boundary !== null &&
      boundary.slice(0, 7) === '81165e6' &&
      contiguous &&
      // Both documents must name the PINNED RANGE and must NOT describe the window as "reachable from `HEAD`", or the
      // recipe they print reproduces a different number than this assertion measures.
      /bcf7b19/.test(readmeNoGo) &&
      /bcf7b19/.test(schemaNoGo) &&
      !/reachable from/.test(readmeNoGo) &&
      !/reachable from/.test(schemaNoGo) &&
      /\*\*86 \(60\.1 %\)\*\*/.test(readmeNoGo) &&
      /\*\*86 \(60\.1 %\)\*\*/.test(schemaNoGo) &&
      /UNDEFINED, not red/.test(readmeNoGo) &&
      /UNDEFINED, not red/.test(schemaNoGo) &&
      /81165e6/.test(readmeNoGo) &&
      /81165e6/.test(schemaNoGo) &&
      /Basis/.test(readmeNoGo) &&
      /Basis/.test(schemaNoGo),
    `window=${history.length} tip=${history[0]?.slice(0, 7)} tip_is_ancestor_of_HEAD=${censusTipIsAncestor} ` +
      `without_ui_typecheck=${withoutUiTypecheck.length} boundary=${boundary?.slice(0, 7)}`,
  );
  check(
    'I25',
    'S1-SITE4-the-gate-undefined-figure-is-carried-as-UNDEFINED-not-red-by-the-harness-layer-that-owns-it',
    // Named replacement for the four AGENTS.md conjuncts repointed out of the assertion below. The SAME four literals and
    // the SAME positive check, now asked of BOTH harness-layer documents that own them — and asked of EACH of them, not of
    // one, so the claim cannot survive in a single document while the other drifts. The agent-facing entry point is no
    // longer a required carrier of the measurement, which is what lets its harness prose move in a later step.
    [readmeDoc, schemaDoc].every(
      (doc) =>
        /\*\*86 \(60\.1 %\)\*\*/.test(doc) &&
        /UNDEFINED, not red/.test(doc) &&
        /81165e6/.test(doc) &&
        /143 commits/.test(doc),
    ),
    JSON.stringify({
      readme_figure: /\*\*86 \(60\.1 %\)\*\*/.test(readmeDoc),
      readme_undefined_not_red: /UNDEFINED, not red/.test(readmeDoc),
      readme_boundary: /81165e6/.test(readmeDoc),
      readme_143: /143 commits/.test(readmeDoc),
      schemas_figure: /\*\*86 \(60\.1 %\)\*\*/.test(schemaDoc),
      schemas_undefined_not_red: /UNDEFINED, not red/.test(schemaDoc),
      schemas_boundary: /81165e6/.test(schemaDoc),
      schemas_143: /143 commits/.test(schemaDoc),
    }),
  );
  check(
    'I25',
    'the-gate-undefined-figure-is-carried-by-the-harness-layer-as-undefined-not-red',
    // RENAMED (I2a) and repointed, NOT relaxed. The old name asserted a fact about WHERE the figure lives — "into the
    // agent-facing entry point" — and repointing the read without renaming it would have left a check whose name was
    // false, which is worse than no check. The new name states what it now asserts: the harness layer, which owns the
    // measurement, carries it. The four literals, the case, the escaping and the ALL-AND conjunction are byte-identical
    // to the four repointed out of `agentsDoc`; only the read target changed, and each of BOTH owning documents is
    // required so the claim cannot survive in one while the other drifts.
    //
    // Why the figure belongs here and not in `AGENTS.md`: 86 of 143 commits declare no `ui` `typecheck` script, so a
    // whole-project `check` gate is not derivable from their manifests. That is a measured property of the HARNESS's
    // reach over THIS repository — a research finding recorded in the `git bisect` NO-GO — not an everyday application
    // fact, and `AGENTS.md` is injected into every session in every mode. The check right above
    // (`the-gate-is-UNDEFINED-over-86-of-143-commits-...`) still RE-DERIVES the 86/143/81165e6 from the repository itself
    // against live `git` — over the PINNED range ending at `I25_CENSUS_TIP`, so a new commit cannot move it — so the
    // numbers here are still checked against history rather than trusted as prose.
    [readmeDoc, schemaDoc].every(
      (doc) =>
        /\*\*86 \(60\.1 %\)\*\*/.test(doc) &&
        /UNDEFINED, not red/.test(doc) &&
        /81165e6/.test(doc) &&
        /143 commits/.test(doc),
    ),
    JSON.stringify({
      readme: {
        figure: /\*\*86 \(60\.1 %\)\*\*/.test(readmeDoc),
        undefined_not_red: /UNDEFINED, not red/.test(readmeDoc),
        boundary: /81165e6/.test(readmeDoc),
        window: /143 commits/.test(readmeDoc),
      },
      schemas: {
        figure: /\*\*86 \(60\.1 %\)\*\*/.test(schemaDoc),
        undefined_not_red: /UNDEFINED, not red/.test(schemaDoc),
        boundary: /81165e6/.test(schemaDoc),
        window: /143 commits/.test(schemaDoc),
      },
    }),
  );

  // F7. The schemas prose must describe the IMPLEMENTATION, not a simplification of it. Three specific claims, each of
  // which was false of the previous text: the log-space seed, the `k === n` short-circuit, and the subnormal rescue.
  check(
    'I25',
    'the-schemas-tail-description-states-the-log-space-seed-the-k-equals-n-short-circuit-and-the-subnormal-rescue',
      /seeded in log space at the first\s+included term/i.test(schemaDoc) &&
      /k === n/.test(schemaDoc) &&
      /\*\*subnormal\*\*/i.test(schemaDoc) &&
      /rescued/.test(schemaDoc) &&
      // The claim that is now false, and must not reappear: a plain recurrence seeded at (1-p)^n.
      !/closed-form tail by term recurrence/.test(schemaDoc),
    'schemas.md tail section',
  );

  // ---- I26: order-aware interleaved trials and the per-step evaluation mode.
  //
  // Two capabilities, asserted at the level where each one's claim lives.
  //
  //   (a) THE ORDER. Trials used to run good-then-target in every block, so a defect positively correlated with
  //       execution order was CONSISTENT BETWEEN the two sides and the contradiction rule — the only rule this
  //       program may use — could never fire. On the acceptance fixture whose commits differ by one comment line that
  //       produced `verdict: regression` at exit 1 on every run, and `--repeat=4` did not rescue it. The fix rotates
  //       the first position per trial. This group asserts the SCHEDULE, because the schedule is the whole mechanism:
  //       the N = 1 anchor, the rotation, the purity a resumed session depends on, and the negative control that the
  //       design is not the old one. The E24 family drives the real CLI.
  //   (b) THE STEP MODE. `--step=<name>` selects which steps the EXISTING `evaluate` loop runs, so there is one gate
  //       loop, one `runStep` and one provenance format before and after. This group asserts the two states, that
  //       UNDEFINED is reachable and distinct, and — the hard rule — that an UNDEFINED side is INCONCLUSIVE rather
  //       than FAIL, including through `classifyRegressSide` itself.
  const i26N1 = s2.regressExecutionOrder(1);
  check(
    'I26',
    'the-N-one-anchor-reduces-to-the-pre-repeat-order-and-claims-no-interleaving',
    JSON.stringify(s2.regressInterleavedSchedule(1)) === JSON.stringify([['good', 'target']]) &&
      i26N1.scheme === s2.REGRESS_ORDER_SCHEME_SINGLE &&
      i26N1.rotate_first_position === false &&
      // A record that claimed a rotation at N = 1 would be claiming an interleaving with one trial and therefore no
      // second position to alternate into.
      i26N1.legacy_order_replaced === null &&
      i26N1.is_legacy_order === false,
    JSON.stringify({ scheme: i26N1.scheme, rotate: i26N1.rotate_first_position, schedule: i26N1.schedule }),
  );
  const i26N4 = s2.regressExecutionOrder(4);
  check(
    'I26',
    'the-first-position-alternates-across-trials-so-an-order-coupled-defect-must-disagree-with-itself',
    JSON.stringify(i26N4.schedule) ===
      JSON.stringify([
        ['good', 'target'],
        ['target', 'good'],
        ['good', 'target'],
        ['target', 'good'],
      ]) &&
      JSON.stringify(i26N4.position_by_trial.good) === JSON.stringify([0, 1, 0, 1]) &&
      JSON.stringify(i26N4.position_by_trial.target) === JSON.stringify([1, 0, 1, 0]) &&
      i26N4.rotate_first_position === true &&
      i26N4.scheme === s2.REGRESS_ORDER_SCHEME_INTERLEAVED &&
      // THE NEGATIVE CONTROL. The old design is named in the record so a reader can check the design is not it,
      // rather than taking this program's word for it.
      i26N4.legacy_order_replaced === s2.REGRESS_ORDER_LEGACY &&
      i26N4.is_legacy_order === false &&
      s2.REGRESS_ORDER_LEGACY !== 'interleaved_rotated',
    JSON.stringify({ schedule: i26N4.schedule, positions: i26N4.position_by_trial, legacy: i26N4.legacy_order_replaced }),
  );
  check(
    'I26',
    'the-schedule-is-a-pure-function-of-N-so-a-resumed-session-replays-each-trial-under-the-position-it-was-measured-in',
    JSON.stringify(s2.regressInterleavedSchedule(2)) === JSON.stringify(s2.regressInterleavedSchedule(4).slice(0, 2)) &&
      // Growing N appends blocks; it never rewrites one, which is the same append-only property the trial log relies on.
      s2.regressInterleavedSchedule(6).slice(0, 4).every((block, index) => JSON.stringify(block) === JSON.stringify(s2.regressInterleavedSchedule(4)[index])) &&
      s2.regressInterleavedSchedule(0).length === 0,
    JSON.stringify({ two: s2.regressInterleavedSchedule(2), six: s2.regressInterleavedSchedule(6) }),
  );
  check(
    'I26',
    'the-residual-is-recorded-and-names-the-order-coupled-defect-interleaving-does-NOT-cover',
    // A rotation permutes POSITION, not TIME. The record says so, in its own words, and the standing limitations ride
    // along un-softened: a worktree is not a security boundary, and a same-principal writer controls the pipeline.
    /does not permute TIME/i.test(s2.REGRESS_ORDER_RESIDUAL) &&
      /trial INDEX/i.test(s2.REGRESS_ORDER_RESIDUAL) &&
      /cannot distinguish it from a real difference/i.test(s2.REGRESS_ORDER_RESIDUAL) &&
      /worktree is not a security boundary/i.test(s2.REGRESS_ORDER_RESIDUAL) &&
      /same-principal writer/i.test(s2.REGRESS_ORDER_RESIDUAL) &&
      // The residual travels WITH the order record, in both the artifact and the printed block — a limitation a reader
      // has to go looking for is not one.
      i26N4.residual === s2.REGRESS_ORDER_RESIDUAL &&
      i26N4.basis === s2.REGRESS_ORDER_BASIS &&
      // And the record stays byte-bounded: a whole limitation paragraph in every trial row would be a size problem the
      // trial-log byte bound would eventually refuse.
      JSON.stringify(i26N4).length < 20000,
    `residual=${s2.REGRESS_ORDER_RESIDUAL.length} chars, order record=${JSON.stringify(i26N4).length} chars`,
  );
  const i26Positional = s2.regressPositionConditionalStates(
    i26N4,
    [
      { trial_index: 0, state: 'PASS' },
      { trial_index: 1, state: 'FAIL' },
      { trial_index: 2, state: 'PASS' },
      { trial_index: 3, state: 'FAIL' },
    ],
    [
      { trial_index: 0, state: 'FAIL' },
      { trial_index: 1, state: 'PASS' },
      { trial_index: 2, state: 'FAIL' },
      { trial_index: 3, state: 'PASS' },
    ],
  );
  check(
    'I26',
    'the-position-conditional-split-is-visible-as-a-DISCLOSURE-and-is-never-a-classification-input',
    // It reports that the states moved WITH the position, which is exactly the diagnostic the interleaving exists to
    // make visible, and it is refused as an input: any within-side disagreement already fires the contradiction rule, so
    // a position-conditional split would buy a name and not coverage.
    i26Positional.scope === 'disclosure_only' &&
      i26Positional.classification_input === false &&
      i26Positional.good.position_separable === true &&
      i26Positional.good.positions_observed === 2 &&
      i26Positional.target.position_separable === true &&
      i26Positional.good.distinct_states.join(',') === 'PASS,FAIL' &&
      // The negative control: at N = 1 only one position carries a trial, so no split is reported and none is implied.
      s2.regressPositionConditionalStates(s2.regressExecutionOrder(1), [{ trial_index: 0, state: 'PASS' }], [
        { trial_index: 0, state: 'PASS' },
      ]).good.position_separable === false,
    JSON.stringify({ good: i26Positional.good, target: i26Positional.target }),
  );
  check(
    'I26',
    'the-step-mode-has-exactly-two-states-and-neither-of-them-is-a-failure',
    // Two states, and the vocabulary is load-bearing: `runnable` and `UNDEFINED`. A third state called `failed`, or a
    // rename of UNDEFINED into a failure word, would be the laundering this mode exists to prevent.
    JSON.stringify(s2.STEP_SCOPE_STATES) === JSON.stringify(['runnable', 'UNDEFINED']) &&
      s2.STEP_SCOPE_STATES.every((state) => !/fail|error|red/i.test(state)) &&
      // The UNDEFINED rule is stated where it is enforced, and says the three things that must be true at once: nothing
      // ran, nothing failed, and no direction can come from it.
      /NOT a failure and never becomes one/i.test(s2.STEP_SCOPE_UNDEFINED_BASIS) &&
      /no exit code exists/i.test(s2.STEP_SCOPE_UNDEFINED_BASIS) &&
      /not in a direction/i.test(s2.STEP_SCOPE_UNDEFINED_BASIS) &&
      /no later step a fail-fast could have skipped/i.test(s2.STEP_SCOPE_FAIL_FAST_BASIS),
    JSON.stringify({ states: s2.STEP_SCOPE_STATES }),
  );
  // The two resolution outcomes, against a real throwaway manifest. A step whose script the manifest does not declare
  // is UNDEFINED; the same step against a manifest that declares it is runnable. Nothing is spawned either way.
  const i26Root = suiteTempDir('harness-i26-');
  mkdirSync(join(i26Root, 'server'), { recursive: true });
  writeFileSync(
    join(i26Root, 'server', 'package.json'),
    `${JSON.stringify({ name: 'i26-server', private: true, scripts: { test: 'node t.js' } }, null, 2)}\n`,
  );
  const i26Run = s2.resolveStepScope('check', 'test:server', i26Root);
  const i26Missing = s2.resolveStepScope('check', 'typecheck:ui', i26Root);
  check(
    'I26',
    'an-UNDEFINED-step-is-reached-and-is-distinct-from-a-runnable-one-with-no-command-and-no-exit-code',
    i26Run.state === 'runnable' &&
      i26Run.command === 'npm test --workspace=@task-board/server' &&
      i26Run.package_path === 'server/package.json' &&
      i26Run.script === 'test' &&
      i26Run.script_value === 'node t.js' &&
      i26Run.step_position === 3 &&
      i26Run.step_total === 5 &&
      // The UNDEFINED case. `ui/package.json` is absent from this workspace, so the commit declares no `typecheck`.
      i26Missing.state === 'UNDEFINED' &&
      i26Missing.command === null &&
      i26Missing.package_path === null &&
      i26Missing.reason === 'manifest_not_found_or_unreadable' &&
      i26Missing.reason !== 'fail' &&
      // A step that is UNDEFINED is not "runnable with a problem" either: the two states are disjoint.
      i26Run.state !== i26Missing.state &&
      i26Run.fail_fast === false &&
      i26Missing.fail_fast === false,
    JSON.stringify({ run: i26Run.state, missing: { state: i26Missing.state, reason: i26Missing.reason } }),
  );
  // `classifyRegressSide` reads `harness_error` with `!== null`, so the ABSENT fields are supplied as explicit nulls
  // rather than omitted — the shape `regressRunSide` actually hands it. Omitting them would be an ERROR, which is the
  // one state this assertion is not about.
  const i26Facts = {
    harness_error: null,
    workspace_refused: null,
    gate_incompatible: false,
    resolver_escaped: false,
    acceptance_unresolved: false,
    contract_digest_differs: false,
    gate_differs: false,
    observed_judged_commit: 'a'.repeat(40),
    observed_judged_commit_post: 'a'.repeat(40),
    gate_exit_code: null,
    failing_step: null,
    environment_record: {},
    status_hash_pre: 'e3b0c44298fc',
    status_hash_post: 'e3b0c44298fc',
    requested_commit: 'a'.repeat(40),
  };
  const i26UndefinedSide = s2.classifyRegressSide({
    ...i26Facts,
    step_undefined: true,
    step_requested: 'typecheck:ui',
    step_undefined_reason: 'script_not_declared: ui/package.json declares no "typecheck" script',
  });
  const i26SameFactsNoStep = s2.classifyRegressSide({ ...i26Facts });
  check(
    'I26',
    'an-UNDEFINED-step-makes-a-side-INCONCLUSIVE-and-NEVER-a-FAIL-through-the-ordinary-classifier',
    // THE HARD RULE, asserted on `classifyRegressSide` itself and not on a per-step branch beside it. `gate_exit_code`
    // is `null` here because nothing ran, and WITHOUT the UNDEFINED check the classifier falls through to
    // `gate_exit_code === 0`, compares null against 0 and reports FAIL — a red side manufactured out of the absence of
    // a declaration. The control is the identical fact set with no step named, which is what that fall-through does.
    i26UndefinedSide.state === 'INCONCLUSIVE' &&
      i26UndefinedSide.state !== 'FAIL' &&
      i26UndefinedSide.state !== 'PASS' &&
      /UNDEFINED here/.test(i26UndefinedSide.reason) &&
      /typecheck:ui/.test(i26UndefinedSide.reason) &&
      i26SameFactsNoStep.state === 'FAIL' &&
      // INCONCLUSIVE != PASS != FAIL is STRUCTURAL: the direction lookup has no row for it, so no comparison can enter.
      s2.REGRESS_SIDE_STATES.includes('INCONCLUSIVE') &&
      i26UndefinedSide.reason !== i26SameFactsNoStep.reason,
    `undefined=${i26UndefinedSide.state} control=${i26SameFactsNoStep.state}`,
  );
  let i26UnknownStepRefused = null;
  let i26BareStepRefused = null;

  try {
    s2.assertGateStepExists('check', 'no-such-step');
  } catch (error) {
    i26UnknownStepRefused = error?.message ?? String(error);
  }

  try {
    s2.resolveStepFlag({ step: true }, 'check');
  } catch (error) {
    i26BareStepRefused = error?.message ?? String(error);
  }

  check(
    'I26',
    'an-unknown-step-name-and-a-bare-step-flag-are-BOTH-refused-by-name',
    // `parseFlags` has NO allowlist — an unknown flag is silently ignored — so a bare `--step` would otherwise be the
    // same command as no flag at all: a real capability requested and silently not granted.
    typeof i26UnknownStepRefused === 'string' &&
      /is not a step of gate "check"/.test(i26UnknownStepRefused) &&
      /lint, typecheck:shared\+server, typecheck:ui, test:server, test:ui/.test(i26UnknownStepRefused) &&
      /refused BY NAME/.test(i26UnknownStepRefused) &&
      typeof i26BareStepRefused === 'string' &&
      /requires the NAME of one step/.test(i26BareStepRefused) &&
      // And the shaped-but-empty case is refused too, rather than read as "no narrowing".
      s2.resolveStepFlag({}, 'check') === null,
    `unknown=${String(i26UnknownStepRefused).slice(0, 60)} bare=${String(i26BareStepRefused).slice(0, 60)}`,
  );
  // TERMINOLOGY. A transition is not a cause, and this cycle's whole finding is that a boundary is not a cause. The new
  // surface must not reintroduce the two words the protocol forbids, and the documentation must state the rule.
  const i26NewSource = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
  const i26Readme = readFileSync(join(REAL_REPO_ROOT, '.harness', 'README.md'), 'utf8');
  const i26Schemas = readFileSync(join(REAL_REPO_ROOT, '.harness', 'docs', 'schemas.md'), 'utf8');
  // The third harness-layer document, added by the I2a repoint below so the self-test twin asserts the SAME trio the
  // compatibility twin (`S1_SITE8`) already asserts. `AGENTS.md` is deliberately NOT a member: it is no longer read as a
  // carrier of these names.
  const i26Ledger = readFileSync(join(REAL_REPO_ROOT, '.harness', 'docs', 'ledger.md'), 'utf8');
  // The ONE named exception, computed as a BLOCK rather than a line: the pre-existing `git bisect` NO-GO falsifier is a
  // wrapped list item that names the word twice, once in the item's own words and once in its trailing criterion. A
  // line filter that matched only the first would leave the second behind, which is exactly the kind of scope that is
  // really a hole.
  const i26Agents = readFileSync(join(REAL_REPO_ROOT, 'AGENTS.md'), 'utf8');
  const i26Roomodes = readFileSync(join(REAL_REPO_ROOT, '.roomodes'), 'utf8');
  // THE ONE NAMED EXCEPTION, applied uniformly to EVERY document and asserted to still be PRESENT. The pre-existing
  // `git bisect` NO-GO falsifier names the word inside a quoted criterion ("a skip-suppresses-the-culprit mapping"), and
  // it is quoted consistently across the documents because rewording it would silently change a load-bearing NO-GO. The
  // block runs from the marker to the next blank line, because the word appears on a WRAPPED continuation line too — a
  // filter matching only the first line would leave the second behind, which is a scope that is really a hole.
  const i26OutsideQuotedFalsifier = (text) => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /skip-suppresses-the-culprit mapping/.test(line));

    if (start === -1) {
      return lines;
    }

    let end = start;

    while (end + 1 < lines.length && lines[end + 1].trim() !== '') {
      end += 1;
    }

    return lines.filter((_line, index) => index < start || index > end);
  };
  // LAYER OWNERSHIP (S1). `AGENTS.md` is no longer a member of `i26Docs`: the POSITIVE claim — that the quoted NO-GO
  // falsifier is still present, in the exact words that make it a NO-GO — belongs to the documents that own the NO-GO.
  // The NEGATIVE scan below is deliberately NOT repointed: the forbidden word must never reappear in layer-0 either, and
  // the filter implementing "outside the quoted falsifier" is applied per document, unchanged, to every entry.
  // FIX B5: THE SCANNED SET IS NOW THE WHOLE AGENT-FACING SURFACE, and the previous set was a hole with a shape.
  //
  // The gap: `.roo/rules-harness-evaluator/01-harness-capability.md` LOADS INTO A SESSION and was in neither this scan
  // nor its compatibility twin `E24-08`. It is a file a specialist agent reads in full, and a responsible-party phrase
  // written there would have been invisible to every check that forbids one. A vocabulary rule enforced on three of the
  // four places the vocabulary appears is a rule with a hole in it, and the hole is the one an agent is most likely to
  // read.
  //
  // So the set is the three layers an agent can actually be given: LAYER 0 (`AGENTS.md` and the always-loaded rules
  // file), the SPECIALIST capability file, and the MODE BLOCKS in `.roomodes`. The mode blocks are included as one entry
  // carrying the whole file, because `.roomodes` is already scanned for the word and a block is not a separate file.
  // The capability path is a literal HERE rather than a reference to the `SPECIALIST_FILES` table further down: this
  // group runs before that table is declared, and a forward reference would be a TDZ error rather than a scan.
  const I26_CAPABILITY = '.roo/rules-harness-evaluator/01-harness-capability.md';
  // The two documents that OWN the `git bisect` NO-GO and therefore must carry its falsifier. Named explicitly, in
  // labels that match the `i26Docs` entries below, because the owner set and the scan set are different sets and the
  // difference is load-bearing: a document can be scanned for the forbidden word without owning the NO-GO.
  const I26_FALSIFIER_OWNERS = ['README', 'schemas'];
  const i26Capability = readFileSync(join(REAL_REPO_ROOT, I26_CAPABILITY), 'utf8');
  const i26Docs = [
    ['README', i26Readme],
    ['schemas', i26Schemas],
    ['.roomodes', i26Roomodes],
    [I26_CAPABILITY, i26Capability],
  ];
  const i26Layer0 = i26Agents;
  // The mode blocks are named individually as well, so the compensating assertion below can report on all seven rather
  // than on `.roomodes` as one opaque blob. `roomodesBlock` is defined above this group and returns `undefined` for a
  // slug that is not present, which is a MISSING block rather than a clean one — the assertion counts what it found.
  // The slug set is derived from the ALREADY-READ `.roomodes` text rather than from `layer0Text`/`roomodesBlocks`, both
  // of which are declared further down this function and would be a TDZ error here. Every `- slug:` in the file is in
  // the set by construction, which is what "the full agent-facing set" has to mean: a mode added tomorrow is scanned
  // tomorrow without this list being edited.
  //
  // Each block's own text is the slice from its `- slug:` line to the next one, so a hit is attributed to the block that
  // carries it and a failure names the mode rather than a line number in a file nobody was reading.
  const i26ModeSlugs = [...i26Roomodes.matchAll(/^\s*-\s+slug:\s*(\S+)/gm)].map((match) => match[1]);
  const i26ModeBlockText = (slug) => {
    const lines = i26Roomodes.split('\n');
    const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+slug:\\s*${slug}\\s*$`).test(line));
    if (start === -1) return '';
    let end = start + 1;
    while (end < lines.length && !/^\s*-\s+slug:\s*\S+/.test(lines[end])) end += 1;

    return lines.slice(start, end).join('\n');
  };
  const i26ModeBlockHits = i26ModeSlugs.flatMap((slug) =>
    i26OutsideQuotedFalsifier(i26ModeBlockText(slug))
      .filter((line) => /\bculprit\b/i.test(line))
      .map((line) => `${slug}:${line.trim().slice(0, 80)}`),
  );
  // Prose with the markdown blockquote marker normalised away, so a SENTENCE can be asserted across a prettier wrap
  // instead of the assertion silently depending on where the formatter happened to break the line.
  const i26Prose = flattenProse(i26Schemas).replace(/\s*>\s*/g, ' ');
  const i26ReadmeProse = flattenProse(i26Readme).replace(/\s*>\s*/g, ' ');
  check(
    'I26',
    'the-terminology-is-candidate-boundary-and-observed-transition-and-no-commit-is-ever-named-as-the-responsible-party',
    !/\bculprit\b/i.test(i26NewSource) &&
      // Outside the ONE quoted `git bisect` NO-GO falsifier, in EVERY document — the agent-facing set as a whole, which
      // since FIX B5 includes the specialist capability file, and the falsifier is asserted to still be there, so this
      // is a stated scope and not a hole.
      [...i26Docs, ['AGENTS', i26Layer0]].every(([, text]) =>
        i26OutsideQuotedFalsifier(text).every((line) => !/\bculprit\b/i.test(line)),
      ) &&
      // Every mode block's own prose, checked per block rather than as one concatenated blob, so a failure names the
      // block. The falsifier filter is applied here too: a block is a document like any other and the one stated
      // exception applies to it uniformly.
      i26ModeBlockHits.length === 0 &&
      ['README', 'schemas'].every((label) =>
        /skip-suppresses-the-culprit mapping/.test(i26Docs.find(([name]) => name === label)[1]),
      ) &&
      /\bcandidate\b/i.test(i26Readme) &&
      /\bboundary\b/i.test(i26Readme) &&
      // The rule is stated as a rule, not implied by the absence of a word — and it is stated WITHOUT the forbidden
      // word, because a rule that has to name the thing it forbids in order to forbid it has already used it. The
      // blockquote marker is normalised away because the statements live inside markdown blockquotes and prettier
      // wraps them mid-sentence: matching prose that a formatter moved is testing the formatter.
      /observed transition/i.test(i26Prose) &&
      /a transition is not a cause/i.test(i26Prose) &&
      /\bcandidate\b/i.test(i26Prose) &&
      /never named as the responsible party/i.test(i26Prose) &&
      /never named as the responsible party/i.test(i26ReadmeProse) &&
      /candidate can be the boundary and still be innocent/i.test(i26ReadmeProse),
    `culprit in source=${/\bculprit\b/i.test(i26NewSource)} schemas=${/\bculprit\b/i.test(i26Schemas)} ` +
      // FIX B5: THE SCANNED SET IS PRINTED, because a forbidden-word scan whose scope is invisible is a scope nobody
      // can audit. A reader can now see that the capability file and all seven mode blocks are inside it, and can see
      // which of the seven were found — a set that silently shrank to two would still print PASS.
      `scanned_documents=${JSON.stringify([...i26Docs.map(([name]) => name), 'AGENTS'])} ` +
      `scanned_mode_blocks=${JSON.stringify(i26ModeSlugs)} (${i26ModeSlugs.length}) mode_block_hits=${JSON.stringify(i26ModeBlockHits)}`,
  );
  // THE COMPENSATING ASSERTION, and what stops the scan above from being satisfied by scanning less. The requirement
  // added in FIX B5 is the capability file; a scan that quietly dropped it — or dropped the mode blocks — would still
  // pass every conjunct, because an absence check over a smaller set is still an absence check. So this asserts the
  // SET, not the result: the capability file must be in it, every mode block in `.roomodes` must be in it, and the
  // falsifier filter must still be the one thing excluded rather than the whole capability file.
  check(
    'I26',
    'the-forbidden-word-scan-covers-the-WHOLE-agent-facing-set-layer-0-the-capability-file-and-EVERY-mode-block',
    i26Docs.some(([name]) => name === I26_CAPABILITY) &&
      i26ModeSlugs.length >= 7 &&
      i26ModeBlockHits.length === 0 &&
      // The exception is still an EXCEPTION and not a hole: the falsifier is present in the documents that own the NO-GO,
      // and the filter is what excludes it. If the filter stopped matching, the word would appear in the scan and fail.
      /skip-suppresses-the-culprit mapping/.test(i26Readme) &&
      /skip-suppresses-the-culprit mapping/.test(i26Schemas),
    `capability_in_set=${i26Docs.some(([name]) => name === I26_CAPABILITY)} ` +
      `mode_blocks=${JSON.stringify(i26ModeSlugs)} (${i26ModeSlugs.length}, floor 7) hits=${JSON.stringify(i26ModeBlockHits)} ` +
      `scanned_documents=${JSON.stringify([...i26Docs.map(([name]) => name), 'AGENTS'])} ` +
      'note=an-absence-check-over-a-smaller-set-is-still-an-absence-check-so-the-set-itself-is-asserted',
  );
  check(
    'I26',
    'S1-SITE5-the-quoted-NO-GO-falsifier-is-OWNED-by-the-harness-layer-and-the-forbidden-word-is-absent-from-layer-0-too',
    // Named replacement for the `AGENTS.md` conjunct repointed out of the assertion above. The SAME literal in the SAME
    // words — a falsifier that is reworded is not the falsifier the NO-GO rests on — is now required of BOTH
    // harness-layer documents that carry it. The negative half is restated here by name as well: the word must be absent
    // from layer-0 outside the quoted falsifier, with the SAME block filter, so a repoint never widens where a forbidden
    // word may hide.
    // FIX B5 CHANGED HOW THE OWNERS ARE SELECTED, and the change is the point rather than a repair. The selection used
    // to be `name !== '.roomodes'` — an EXCLUSION, which was correct only while the scanned set happened to be
    // {README, schemas, .roomodes}. Adding the capability file to that set, as FIX B5 requires, would have made this
    // conjunct demand the falsifier from a document that does not own the NO-GO and never quoted it. Selecting the two
    // owners BY NAME states the same property the exclusion stated — the harness layer that carries the NO-GO carries
    // its falsifier — and stops depending on the size of the scanned set. The property asserted is unchanged; only the
    // way the two owners are named is now explicit.
    I26_FALSIFIER_OWNERS.every((name) =>
      /skip-suppresses-the-culprit mapping/.test(i26Docs.find(([entry]) => entry === name)?.[1] ?? ''),
    ) &&
      i26OutsideQuotedFalsifier(i26Layer0).every((line) => !/\bculprit\b/i.test(line)),
    JSON.stringify({
      readme_falsifier: /skip-suppresses-the-culprit mapping/.test(i26Readme),
      schemas_falsifier: /skip-suppresses-the-culprit mapping/.test(i26Schemas),
      // The scanned set is printed, so a reader can confirm the capability file is IN the forbidden-word scan while
      // being correctly absent from the falsifier-OWNER list. Those are two different sets and confusing them is how a
      // vocabulary rule ends up demanding a NO-GO falsifier from a file that has no NO-GO.
      falsifier_owners: I26_FALSIFIER_OWNERS,
      scanned_documents: [...i26Docs.map(([name]) => name), 'AGENTS'],
      layer0_clean_outside_falsifier: i26OutsideQuotedFalsifier(i26Layer0).every((line) => !/\bculprit\b/i.test(line)),
      roomodes_scanned_but_not_a_falsifier_carrier: !/skip-suppresses-the-culprit mapping/.test(i26Roomodes),
      capability_scanned_but_not_a_falsifier_carrier: !/skip-suppresses-the-culprit mapping/.test(i26Capability),
    }),
  );
  // THE COMPENSATING ASSERTION FOR THE REPOINT, and the reason the two sets above are named rather than inferred. The
  // owners list is exactly the two documents that carry the NO-GO, the capability file is in the scan and NOT in the
  // owners, and `.roomodes` is in neither as a carrier. Asserted explicitly because a selection rule that is wrong in
  // the permissive direction — "every scanned document must carry the falsifier" — would fail loudly, while one that is
  // wrong in the restrictive direction would quietly stop requiring anything at all. This is the loud direction.
  check(
    'I26',
    'the-falsifier-OWNER-list-is-exactly-the-two-NO-GO-carriers-and-is-disjoint-from-the-forbidden-word-SCAN-set',
    I26_FALSIFIER_OWNERS.length === 2 &&
      I26_FALSIFIER_OWNERS.every((name) => /skip-suppresses-the-culprit mapping/.test(i26Docs.find(([e]) => e === name)?.[1] ?? '')) &&
      I26_FALSIFIER_OWNERS.every((name) => !/skip-suppresses-the-culprit mapping/.test(i26Capability) || name === I26_CAPABILITY) &&
      !I26_FALSIFIER_OWNERS.includes(I26_CAPABILITY) &&
      !I26_FALSIFIER_OWNERS.includes('.roomodes'),
    `owners=${JSON.stringify(I26_FALSIFIER_OWNERS)} scanned=${JSON.stringify([...i26Docs.map(([name]) => name), 'AGENTS'])} ` +
      'note=the-capability-file-is-scanned-for-the-forbidden-word-and-does-not-own-the-NO-GO-so-it-carries-no-falsifier',
  );
  check(
    'I26',
    'the-new-field-and-function-names-are-documented-in-BOTH-documents-the-totals-are-parsed-from',
    // The new names are in the READMEs a reader actually opens and in the schema document. A field that exists only in
    // the code is not documented, whatever the code comment says. (The check NAME still says "BOTH documents"; it was
    // already imprecise before the I2a repoint — it asserted readme + schemas + AGENTS.md — and the name was deliberately
    // NOT renamed, because that rename was not authorised for this site and an accurate comment is worth more here than
    // an accurate noun. The S1-SITE6 assertion below names the three documents explicitly.)
    ['regressExecutionOrder', 'regressInterleavedSchedule', 'regressPositionConditionalStates'].every((name) =>
      i26Readme.includes(name),
    ) &&
      ['resolveStepScope', 'assertGateStepExists', 'STEP_SCOPE_UNDEFINED_BASIS'].every((name) => i26Readme.includes(name)) &&
      i26Schemas.includes('execution_order') &&
      i26Schemas.includes('step_scope') &&
      i26Schemas.includes('UNDEFINED') &&
      // S1-SITE6 (REPOINTED, I2a). These two conjuncts were the last place in this group that read `AGENTS.md` as a
      // CARRIER of a field name. The compatibility twin of this assertion, `S1_SITE8`, was already repointed onto the
      // harness-layer trio; this self-test twin was left reading the entry point and was therefore inconsistent with it.
      // It now asserts the SAME two literals against the SAME three documents, so both suites state one claim. Strength
      // is unchanged: `.includes` is still a whole-token, case-sensitive containment test, and the trio is required in
      // full, not one-of.
      [i26Readme, i26Schemas, i26Ledger].every((doc) => doc.includes('execution_order')) &&
      [i26Readme, i26Schemas, i26Ledger].every((doc) => doc.includes('--step=')) &&
      // The standing limitations are quoted, not paraphrased into something weaker.
      /worktree is not a security boundary/.test(i26Readme) &&
      /same-principal writer/.test(i26Readme),
    `readme(order)=${i26Readme.includes('regressExecutionOrder')} schemas(step_scope)=${i26Schemas.includes('step_scope')}`,
  );
  check(
    'I26',
    'S1-SITE6-the-harness-layer-owns-the-new-field-names-and-AGENTS.md-is-no-longer-read-as-a-carrier-of-them',
    // Named replacement for the two `AGENTS.md` conjuncts repointed out of the assertion above. The SAME two literals,
    // by `.includes`, are required of EACH of the three harness-layer documents — the same trio the compatibility twin
    // `S1_SITE8` already asserts — so the claim is not one-of and cannot survive in a single document.
    //
    // WHAT IS DELIBERATELY NOT ASSERTED, stated rather than left for a reader to assume. This check does NOT require
    // `AGENTS.md` to be FREE of the two names, and it must not: the entry point still legitimately carries them (it
    // documents the `census --step=<name>` command and `repeat.execution_order`), and removing that prose is the LATER
    // relocation step's job, not this one's. Asserting absence here would be a red that only that step can clear, which
    // would make this suite a blocker on prose it deliberately does not own.
    //
    // So the direction of the claim is one-way and is stated as such: the harness layer MUST carry the names (that is
    // asserted, three documents, in full); `AGENTS.md` MAY carry them and is simply no longer asked. The entry point's
    // current contents are recorded in the detail block below as a DISCLOSURE — what is true right now — and are not a
    // requirement. This is the opposite of the `culprit` scan two checks above, which IS a real negative because that
    // word is forbidden everywhere outside one quoted block; there is no forbidden word here, only prose that has not
    // been relocated yet.
    [i26Readme, i26Schemas, i26Ledger].every((doc) => doc.includes('execution_order')) &&
      [i26Readme, i26Schemas, i26Ledger].every((doc) => doc.includes('--step=')),
    JSON.stringify({
      readme: { execution_order: i26Readme.includes('execution_order'), step: i26Readme.includes('--step=') },
      schemas: { execution_order: i26Schemas.includes('execution_order'), step: i26Schemas.includes('--step=') },
      ledger: { execution_order: i26Ledger.includes('execution_order'), step: i26Ledger.includes('--step=') },
      agents_disclosure_not_a_requirement: {
        execution_order: i26Agents.includes('execution_order'),
        step: i26Agents.includes('--step='),
        note: 'AGENTS.md is permitted but no longer required to carry these; removal belongs to the later relocation step',
      },
    }),
  );

  // ---- I27: the history census — failure REGIONS, classified CANDIDATES, and a refusal to name one commit.
  //
  // A census is the first surface here that measures a RANGE rather than a pair, and its whole reason to exist is a
  // measured fact: over this repository's real 143 commits the gate predicate is NOT monotone (a break is later fixed),
  // so the correct output of a history survey is regions and candidates, and a tool that names one commit is wrong. This
  // group asserts that claim where it lives — the PURE derivation — because the derivation is a function of a matrix and
  // can therefore be driven with no repository, no install and no gate. The E25 family drives the real CLI.
  //
  // The four load-bearing properties, in the order they are asserted:
  //   (a) the VERDICT is scoped to the measured range and is structurally unreachable as MONOTONE while a reversal exists;
  //   (b) UNDEFINED and INCONCLUSIVE are ENUMERATED, non-resolving, and never become FAIL;
  //   (c) the CASCADE is INCONCLUSIVE when rules compete and when evidence is missing, and never invents a tie-break;
  //   (d) the vocabulary is candidate/boundary/observed-transition, and the forbidden words are absent from the data.

  // A REAL commit of THIS repository. The cascade reads the declared packages and the generated-path test out of the
  // tree, so driving it against a 40-hex that exists is what makes these assertions about the real functions rather than
  // about a stub that happens to return null.
  const i27Commit = (git(['rev-parse', 'HEAD'], REAL_REPO_ROOT).stdout ?? '').trim();
  // A REAL commit of this repository that ADDED an export inside `shared/`, so the export reader is exercised against a
  // diff that really contains one. `git log -S` finds it rather than hard-coding a sha, so the assertion keeps working as
  // the history grows; if the search ever comes back empty the assertion fails loudly instead of quietly passing.
  const i27ExportCommit = (git(['log', '-1', '--format=%H', '-Sexport const', '--', 'shared'], REAL_REPO_ROOT).stdout ?? '').trim();
  const i27Sha = (index) => `${index}`.padStart(40, '0');
  /** One matrix row. Only `index`, `commit` and `state` carry the derivation; the rest is null-normalised evidence. */
  const i27Row = (index, state, commit = i27Sha(index)) => ({
    index,
    commit,
    state,
    reason: null,
    run_id: `run-${index}`,
    gate_exit_code: state === 'PASS' ? 0 : state === 'FAIL' ? 1 : null,
    step_scope: state === 'UNDEFINED' ? { state: 'UNDEFINED', reason: 'script_not_declared', detail: 'no test script' } : null,
    installed_tree_fingerprint: `fp-${index}`,
    installed_tree_fingerprint_tier: 'metadata',
    lockfile_digest: `lf-${index}`,
    installed_state_digest: `is-${index}`,
    build_state_digest: `bs-${index}`,
    gate_execution_digest: `ge-${index}`,
    signature: state === 'FAIL' ? ['ok'] : [],
  });
  const i27Matrix = (states) => states.map((state, index) => i27Row(index, state));
  const i27Derive = (states) => {
    const rows = i27Matrix(states);
    const regions = s2.censusRegions(rows);
    const monotonicity = s2.censusMonotonicity({
      rows,
      regions,
      step: 'test:server',
      gateName: 'check',
      fromCommit: rows[0].commit,
      toCommit: rows[rows.length - 1].commit,
      commitCount: rows.length,
    });

    return { rows, regions, monotonicity };
  };

  // (a) THE VERDICT IS ABOUT THE MEASURED RANGE. `scope` is a FIELD, not prose, so a reader who sees `MONOTONE` can
  //     check what it was a verdict about without asking. And the reversal check runs FIRST: a hole elsewhere in the
  //     range does not un-observe a reversal that was observed inside it.
  const i27Monotone = i27Derive(['PASS', 'PASS', 'FAIL', 'FAIL']);
  const i27Reversal = i27Derive(['PASS', 'FAIL', 'FAIL', 'PASS']);
  const i27TwoRegions = i27Derive(['PASS', 'FAIL', 'FAIL', 'PASS', 'FAIL']);
  const i27Gapped = i27Derive(['PASS', 'UNDEFINED', 'PASS']);
  // A reversal that IS adjacent, plus a hole elsewhere. `PASS FAIL PASS UNDEFINED` is deliberate: an UNDEFINED commit
  // between two FAIL and PASS commits is not an adjacent reversal, and pretending otherwise would test a rule the census
  // does not have. Adjacency is the rule, and the gap is a gap.
  // A reversal that IS adjacent, plus a hole elsewhere. `PASS FAIL PASS UNDEFINED` is deliberate: an UNDEFINED commit
  // sitting between a FAIL and a PASS is not an adjacent reversal, and pretending otherwise would test a rule the census
  // does not have. Adjacency is the rule, and the gap is a gap.
  const i27ReversalAndGap = i27Derive(['PASS', 'FAIL', 'PASS', 'UNDEFINED']);
  check(
    'I27',
    'the-monotonicity-verdict-is-scoped-to-the-measured-range-and-never-MONOTONE-while-a-reversal-is-present',
    i27Monotone.monotonicity.verdict === 'MONOTONE' &&
      i27Monotone.monotonicity.scope === s2.CENSUS_MONOTONICITY_SCOPE &&
      i27Monotone.monotonicity.scope === 'measured_range_only' &&
      i27Monotone.monotonicity.from_commit === i27Sha(0) &&
      i27Monotone.monotonicity.to_commit === i27Sha(3) &&
      // The hard rule, asserted as a REACHABILITY property rather than as three separate examples: MONOTONE is not
      // reachable while has_reversal is true, in any of the shapes that carry a reversal.
      [i27Reversal, i27TwoRegions, i27ReversalAndGap].every(
        (shape) => !(shape.monotonicity.has_reversal && shape.monotonicity.verdict === 'MONOTONE'),
      ) &&
      i27Reversal.monotonicity.verdict === 'NOT_MONOTONE' &&
      i27TwoRegions.monotonicity.verdict === 'NOT_MONOTONE' &&
      // A reversal decides the verdict even when the range ALSO has a hole: the reversal was observed, the hole merely
      // limits what may be said about the rest. The UNDEFINED commits stay enumerated either way.
      i27ReversalAndGap.monotonicity.verdict === 'NOT_MONOTONE' &&
      i27ReversalAndGap.monotonicity.undecided_commits.length === 1 &&
      // ...and the hole is still ENUMERATED beside the reversal, not dropped because a verdict was already decided.
      i27ReversalAndGap.monotonicity.undecided_commits[0].commit === i27Sha(3) &&
      // A FAIL and a PASS separated by an UNDEFINED commit are NOT an adjacent pair, so that range carries no reversal.
      i27Derive(['PASS', 'FAIL', 'UNDEFINED', 'PASS']).monotonicity.has_reversal === false &&
      // ...and the hole is still ENUMERATED beside the reversal, not dropped because a verdict was already decided.
      i27ReversalAndGap.monotonicity.undecided_commits[0].commit === i27Sha(3) &&
      // A FAIL and a PASS separated by an UNDEFINED commit are NOT an adjacent pair, so this range carries no reversal.
      i27Derive(['PASS', 'FAIL', 'UNDEFINED', 'PASS']).monotonicity.has_reversal === false &&
      // With no reversal but a gap, the range has NO verdict in either direction — it is not "monotone so far".
      i27Gapped.monotonicity.verdict === 'UNDETERMINED' &&
      i27Monotone.monotonicity.carries_no_information === false &&
      // A step that PASSES everywhere is MONOTONE in the trivial sense and separates nothing. Saying so is a
      // disclosure, not a verdict change: the step genuinely never failed.
      i27Derive(['PASS', 'PASS']).monotonicity.carries_no_information === true &&
      s2.CENSUS_MONOTONICITY_STATES.join(',') === 'MONOTONE,NOT_MONOTONE,UNDETERMINED',
    `monotone=${i27Monotone.monotonicity.verdict} reversal=${i27Reversal.monotonicity.verdict} two=${i27TwoRegions.monotonicity.verdict} gapped=${i27Gapped.monotonicity.verdict} rev+gap=${i27ReversalAndGap.monotonicity.verdict}`,
  );

  // (b) THE REFUSAL. When the range is non-monotone the output states that a single boundary is NOT identified, and it
  //     names the things this tool does not offer. The corpus shape D is the one that matters most: two independent
  //     regions means any single one of them is an arbitrary choice among equals.
  const i27Candidates = s2.censusCandidates(i27TwoRegions.regions, i27TwoRegions.rows);
  const i27Refusal = s2.censusRefusal({
    monotonicity: i27TwoRegions.monotonicity,
    regions: i27TwoRegions.regions,
    transitions: [],
  });
  const i27Edge = s2.censusCandidates(s2.censusRegions(i27Matrix(['FAIL', 'PASS'])), i27Matrix(['FAIL', 'PASS']));

  // ---- F1: A HOLE IS A HOLE IN A RUN, NOT A BOUNDARY BETWEEN RUNS. The false-dirty shape, for each undecided state.
  //
  // `P F U F F` used to report TWO independent failure regions, a NOT_MONOTONE verdict with `has_reversal: false`, and
  // a basis claiming that "a range that heals is not a range with one break in it" — while its own matrix printed
  // UNDEFINED and nothing healed at all. A false DIRTY verdict is worse than a false clean one: it invites a reader to
  // hunt a second regression that does not exist. The same defect was cut by an ERROR hole and by an INCONCLUSIVE hole.
  const i27HoleInRun = (hole) => i27Derive(['PASS', 'FAIL', hole, 'FAIL', 'FAIL']);
  const i27UndefinedHole = i27HoleInRun('UNDEFINED');
  const i27ErrorHole = i27HoleInRun('ERROR');
  const i27InconclusiveHole = i27HoleInRun('INCONCLUSIVE');
  const i27HoleShapes = [i27UndefinedHole, i27ErrorHole, i27InconclusiveHole];
  const i27HoleExit = (shape) =>
    shape.rows.some((row) => row.state === 'ERROR')
      ? s2.CENSUS_EXIT_COMMIT_ERROR
      : shape.monotonicity.verdict === 'UNDETERMINED'
        ? s2.CENSUS_EXIT_UNDETERMINED
        : shape.regions.length > 0
          ? s2.CENSUS_EXIT_FINDING
          : s2.CENSUS_EXIT_NO_FINDING;
  check(
    'I27',
    'a-hole-INSIDE-a-failure-run-is-a-hole-in-the-run-and-not-a-boundary-between-runs',
    // ONE region, for every undecided state, with the hole recorded ON it and the span wider than the length.
    i27HoleShapes.every(
      (shape) =>
        shape.regions.length === 1 &&
        shape.regions[0].length === 3 &&
        shape.regions[0].commit_span === 4 &&
        shape.regions[0].interrupted_by_hole === true &&
        shape.regions[0].contiguous_fail_run === false &&
        shape.regions[0].holes.length === 1,
    ) &&
      // The region spans the hole: its endpoints are the FAILs on BOTH sides of it, which is the whole claim.
      i27UndefinedHole.regions[0].start_commit === i27Sha(1) &&
      i27UndefinedHole.regions[0].end_commit === i27Sha(4) &&
      // ...and the basis says so in words, so a reader is not left to infer it from the arithmetic.
      /HOLES IN this run, not a boundary between two runs/.test(i27UndefinedHole.regions[0].basis) &&
      // NOTHING healed, so NOT_MONOTONE is never printed, and the two prior shapes that DID heal still are.
      i27HoleShapes.every(
        (shape) => shape.monotonicity.verdict === 'UNDETERMINED' && shape.monotonicity.has_reversal === false,
      ) &&
      i27HoleShapes.every((shape) => shape.monotonicity.regions_separated_only_by_holes === false) &&
      i27HoleShapes.every((shape) => shape.monotonicity.a_hole_never_splits_a_region === true) &&
      i27Reversal.monotonicity.verdict === 'NOT_MONOTONE' &&
      i27TwoRegions.monotonicity.verdict === 'NOT_MONOTONE' &&
      // A REAL region separated by an observed PASS is still two regions: the fix narrows the rule to holes and no
      // further, and the two-region shape the refusal text is written for is still reachable.
      i27TwoRegions.regions.every((region) => region.interrupted_by_hole === false) &&
      // The hole count is on the verdict, not only on the region.
      i27UndefinedHole.monotonicity.holes_inside_regions === 1 &&
      // EXIT 5 IS REACHABLE. A hole inside a run used to be converted into exit 1 by a phantom second region, so the
      // UNDETERMINED code was unreachable through the region path; the same derivation the command runs is checked here.
      i27HoleExit(i27UndefinedHole) === s2.CENSUS_EXIT_UNDETERMINED &&
      i27HoleExit(i27InconclusiveHole) === s2.CENSUS_EXIT_UNDETERMINED &&
      // ...while a commit ERROR still outranks it, by the documented precedence, and is never demoted to 5.
      i27HoleExit(i27ErrorHole) === s2.CENSUS_EXIT_COMMIT_ERROR &&
      s2.CENSUS_EXIT_UNDETERMINED === 5 &&
      s2.CENSUS_HOLE_STATES.join(',') === 'UNDEFINED,INCONCLUSIVE,ERROR' &&
      // A hole is a hole, and UNDEFINED in it is still not a FAIL.
      i27HoleShapes.every((shape) => shape.rows.filter((row) => row.state === 'FAIL').length === 3) &&
      i27HoleShapes.every((shape) => shape.monotonicity.undecided_commits.length + shape.monotonicity.errored_commits.length === 1),
    `undef=${i27UndefinedHole.monotonicity.verdict}/${i27UndefinedHole.regions.length} err=${i27ErrorHole.monotonicity.verdict}/${i27ErrorHole.regions.length} inc=${i27InconclusiveHole.monotonicity.verdict}/${i27InconclusiveHole.regions.length} exits=${i27HoleExit(i27UndefinedHole)},${i27HoleExit(i27ErrorHole)},${i27HoleExit(i27InconclusiveHole)}`,
  );

  // ---- F2: A CANDIDATE IS EMITTED ONLY WHERE A PASS->FAIL BOUNDARY WAS OBSERVED.
  //
  // `censusCandidates` special-cased only `start_index === 0` and interpolated `${preceding.commit} PASS` for every
  // other region, so a region whose predecessor was UNDEFINED was reported with a basis naming that commit as PASS —
  // the same report printing it as UNDEFINED three lines above, and `candidates (2)` against `observed transitions (1)`.
  // The shape F1 removes a PHANTOM region from is `P F U F F`, whose second region had a hole before it. The shape
  // that isolates F2 is `P U F F`: ONE region whose immediate predecessor is UNDEFINED, so no PASS->FAIL boundary was
  // observed anywhere adjacent to it. Both are asserted: the first proves the phantom is gone, the second that the
  // candidate is nulled rather than fabricated.
  const i27RegionAfterHole = i27Derive(['PASS', 'UNDEFINED', 'FAIL', 'FAIL']);
  const i27HoleCandidates = s2.censusCandidates(i27RegionAfterHole.regions, i27RegionAfterHole.rows);
  check(
    'I27',
    'no-candidate-is-emitted-where-no-PASS-to-FAIL-boundary-was-OBSERVED-and-a-basis-never-interpolates-an-unobserved-state',
    // The F1 shape really did produce a second, hole-preceded region once — so this is the shape the fix removed.
    i27UndefinedHole.regions.length === 1 &&
      i27HoleCandidates.length === 1 &&
      i27HoleCandidates[0].candidate === null &&
      i27HoleCandidates[0].boundary_observed === false &&
      i27HoleCandidates[0].candidate_reason === 'preceding_commit_not_observed_pass' &&
      // The state quoted in the basis is the state the MATRIX printed, not the one the interpolation used to assume.
      i27HoleCandidates[0].preceding_observed_state === 'UNDEFINED' &&
      i27HoleCandidates[0].preceding_commit === i27Sha(1) &&
      /was observed UNDEFINED and NOT PASS/.test(i27HoleCandidates[0].candidate_basis) &&
      // The exact interpolation the old code produced: `<sha1> PASS` for a commit the matrix printed as UNDEFINED.
      !new RegExp(`${i27Sha(1)} PASS`).test(i27HoleCandidates[0].candidate_basis) &&
      // The basis still explains itself in the reader's vocabulary; it just never asserts an unobserved state.
      /NO CANDIDATE for region 1/.test(i27HoleCandidates[0].candidate_basis) &&
      /no PASS->FAIL boundary was OBSERVED/.test(i27HoleCandidates[0].candidate_basis) &&
      // THE GENERAL FORM OF THE F2 CLAIM, over every candidate this derivation can produce here: a basis may assert
      // `<sha> PASS` ONLY when that commit's observed state really is PASS. This is the interpolation the old code
      // emitted unconditionally, and the one a reader cannot check by eye across a long basis.
      [i27Edge[0], ...i27Candidates, ...i27HoleCandidates].every(
        (entry) =>
          ![...entry.candidate_basis.matchAll(/([0-9a-f]{40}) PASS/g)].some(
            (match) => entry.preceding_commit !== null && match[1] === entry.preceding_commit && entry.preceding_observed_state !== 'PASS',
          ),
      ) &&
      // ...and the reverse direction: a null candidate never claims an observed PASS boundary at all.
      [i27Edge[0], ...i27HoleCandidates].every((entry) => /was observed PASS and NOT PASS|OBSERVED PASS->FAIL boundary/.test(entry.candidate_basis) === false) &&
      // A region open at the range edge keeps its own distinct reason: both nulls, two different answers.
      i27Edge[0].candidate_reason === 'open_at_range_edge' &&
      i27Edge[0].boundary_observed === false &&
      // An OBSERVED boundary still yields a candidate, and says which of the two reasons applied.
      i27TwoRegions.regions.every((region, order) => {
        const entry = i27Candidates[order];
        return entry.candidate === region.start_commit && entry.boundary_observed === true && entry.candidate_reason === 'observed_pass_to_fail_boundary';
      }) &&
      // The region arithmetic is carried on the candidate too, so a reader never has to cross-reference.
      i27HoleCandidates[0].region_commit_span === 2 &&
      i27HoleCandidates[0].region_interrupted_by_hole === false,
    `holeCandidate=${i27HoleCandidates[0]?.candidate} reason=${i27HoleCandidates[0]?.candidate_reason} observed=${i27HoleCandidates[0]?.boundary_observed} preceding=${i27HoleCandidates[0]?.preceding_observed_state} two=${i27Candidates.map((entry) => entry.candidate).join(',')}`,
  );
  check(
    'I27',
    'a-non-monotone-range-REFUSES-to-name-one-boundary-and-a-region-open-at-the-range-edge-has-NO-candidate',
    i27Refusal !== null &&
      i27Refusal.refused === 'single_boundary' &&
      i27Refusal.single_boundary_identified === false &&
      /2 INDEPENDENT failure regions/.test(i27Refusal.reason) &&
      // Named, so a reader does not go looking for the thing this tool deliberately does not do.
      i27Refusal.not_offered.includes('first_bad_commit') &&
      i27Refusal.not_offered.includes('midpoint_selection') &&
      i27Refusal.not_offered.includes('narrowing') &&
      i27Refusal.not_offered.includes('bisection') &&
      // Two regions, two CANDIDATES — and the field is named `candidate`, with no `culprit`/`cause`/`responsible`
      // sibling to read instead.
      i27TwoRegions.regions.length === 2 &&
      i27Candidates.length === 2 &&
      i27Candidates.every((entry) => typeof entry.candidate === 'string' && /^[0-9a-f]{40}$/.test(entry.candidate)) &&
      i27Candidates.every((entry) => !Object.hasOwn(entry, 'culprit') && !Object.hasOwn(entry, 'cause')) &&
      // A region open at the first commit of the range compared no boundary, so its candidate is an explicit null
      // rather than the first commit measured.
      i27Edge[0].candidate === null &&
      /OPEN at the first commit of the measured range/.test(i27Edge[0].candidate_basis) &&
      // A monotone range gets NO refusal object at all, rather than a refusal that says nothing.
      s2.censusRefusal({ monotonicity: i27Monotone.monotonicity, regions: i27Monotone.regions, transitions: [] }) === null,
    `refusal=${i27Refusal === null ? 'none' : i27Refusal.refused} candidates=${i27Candidates.length} edge=${i27Edge[0].candidate}`,
  );

  // (c) THE CASCADE. Three distinct routes to INCONCLUSIVE, and one rule that is EXCLUSIVE rather than competing — the
  //     distinction the measured evidence forced and the one acceptance-corpus shape E depends on.
  const i27Base = {
    step: 'benchmark-suite',
    gateName: 'benchmark',
    commit: i27Commit,
    fromCommit: i27Commit,
    changedPaths: null,
    signatureBefore: null,
    signatureAfter: null,
    buildStateChanged: false,
    gateExecutionChanged: false,
    isReversal: false,
  };
  const i27TestOnly = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['src/state.spec.js'],
    signatureBefore: ['ok'],
    signatureAfter: [],
    isReversal: true,
  });
  const i27SourceOnly = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['src/state.js'],
    signatureBefore: ['ok'],
    signatureAfter: ['ok'],
  });
  const i27Confounded = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['server/dist/generated.js'],
    signatureBefore: ['ok'],
    signatureAfter: ['ok'],
    buildStateChanged: true,
  });
  const i27Mixed = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['src/state.spec.js', 'src/state.js'],
    signatureBefore: ['ok'],
    signatureAfter: ['ok'],
  });
  const i27NoDiff = s2.censusClassifyTransition({ ...i27Base, changedPaths: null, signatureAfter: ['ok'] });
  const i27NoSignature = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['src/state.js'],
    signatureBefore: ['ok'],
    signatureAfter: null,
  });
  check(
    'I27',
    'the-cascade-is-INCONCLUSIVE-on-competing-rules-and-on-missing-evidence-and-never-invents-a-tie-break',
    // A test-only diff is EXCLUSIVE: it cannot also be a plain source change, so it classifies as TEST_EVOLUTION rather
    // than as INCONCLUSIVE — while still saying a test-only change is not a fix of the code.
    i27TestOnly.classification === 'TEST_EVOLUTION' &&
      i27TestOnly.fired.length === 1 &&
      i27TestOnly.exclusive_rule_fired === 'TEST_EVOLUTION' &&
      i27TestOnly.masks_a_regression_possible === true &&
      i27TestOnly.error_modes.includes('TEST_EDIT_MAY_MASK_A_REGRESSION') &&
      /is NOT a fix of the code/.test(i27TestOnly.basis) &&
      // A plain source change with no competing rule is the residual, alone.
      i27SourceOnly.classification === 'SOURCE_CHANGE' &&
      i27SourceOnly.fired.length === 1 &&
      // A commit that rewrote GENERATED state AND source fires two COMPETING rules: INCONCLUSIVE, and the confounded
      // error mode is recorded as data rather than left in prose.
      i27Confounded.classification === 'INCONCLUSIVE' &&
      i27Confounded.multiple_rules_fired === true &&
      i27Confounded.rule === null &&
      i27Confounded.confounded === true &&
      i27Confounded.error_modes.includes('CONFOUNDED_CONFIG_AND_SOURCE') &&
      i27Confounded.fired.includes('PREDICATE_DESIGN') &&
      i27Confounded.fired.includes('SOURCE_CHANGE') &&
      // A commit touching tests AND source is reported as SOURCE_CHANGE — and the record says so, because this program
      // CANNOT tell a fix that adjusted its tests from a test edit beside a real source change.
      i27Mixed.classification === 'SOURCE_CHANGE' &&
      i27Mixed.mixed_test_and_source_change === true &&
      i27Mixed.error_modes.includes('MIXED_TEST_AND_SOURCE_COMMIT') &&
      // An unreadable diff is INCONCLUSIVE and is NOT the residual: SOURCE_CHANGE asserts something about a diff this
      // program did not read.
      i27NoDiff.classification === 'INCONCLUSIVE' &&
      i27NoDiff.evidence_available === false &&
      i27NoDiff.fired.length === 0 &&
      i27NoDiff.error_modes.includes('DIFF_UNAVAILABLE') &&
      // A missing signature makes a signature-dependent rule UNDECIDABLE rather than silently unfired, and an
      // undecidable rule withholds the label. Only CROSS_PACKAGE_COMPLETED is listed: this diff touches no foreign
      // package at all, so rule 2 was never applicable to it and is not "undecidable" — a rule that was out of scope
      // and a rule whose evidence was missing are different, and `inapplicable` records the first.
      i27NoSignature.classification === 'INCONCLUSIVE' &&
        i27NoSignature.undecidable.includes('CROSS_PACKAGE_COMPLETED') &&
        !i27NoSignature.undecidable.includes('CROSS_PACKAGE_MIGRATION') &&
        i27NoSignature.undecidable_rules === true &&
        /SIGNATURE_UNAVAILABLE/.test(i27NoSignature.unavailable_reason) &&
        /could not be ASKED/.test(i27NoSignature.basis) &&
      // The cascade is five rules, all asked, with a fixed order — and the order is NOT a tie-break, which is why the
      // classification is `rule: null` on a multi-firing rather than the first one.
      s2.CENSUS_CASCADE_IDS.join(',') ===
        'TEST_EVOLUTION,CROSS_PACKAGE_MIGRATION,CROSS_PACKAGE_COMPLETED,PREDICATE_DESIGN,SOURCE_CHANGE',
    `testOnly=${i27TestOnly.classification} confounded=${i27Confounded.classification} noDiff=${i27NoDiff.classification} noSig=${i27NoSignature.classification}`,
  );

  // A `lint`/`typecheck` step owns no test glob, so TEST_EVOLUTION is INAPPLICABLE there — a different fact from "it did
  // not fire", and one a reader is entitled to.
  // ---- F3: RULE 3 MUST NAME A FOREIGN PACKAGE, OR IT IS A CONFIDENT WRONG LABEL.
  //
  // `CROSS_PACKAGE_COMPLETED` used to test `foreignPaths.length === 0` — the exact NEGATION of being cross-package —
  // plus "a signature name disappeared". At a FAIL->PASS reversal the after-tail is a success message with no error
  // lines, so `gone` was non-empty whenever the failing run had printed ANY identifier. Measured: a docs-only change, a
  // rename, a comment-line change and a one-file in-package source fix each classified as CROSS_PACKAGE_COMPLETED, so it
  // fired at essentially every typecheck reversal — and because it also set `exclusive_rule_fired` it SUPPRESSED the
  // SOURCE_CHANGE residual, so the wrong label additionally swallowed the one rule that would have marked those diffs as
  // plain source changes. Every shape below is driven through the REAL classifier, at a REAL reversal.
  const i27ReversalBase = { ...i27Base, isReversal: true, signatureBefore: ['Widget'], signatureAfter: [] };
  const i27DocsOnly = s2.censusClassifyTransition({ ...i27ReversalBase, changedPaths: ['README.md'] });
  const i27Rename = s2.censusClassifyTransition({ ...i27ReversalBase, changedPaths: ['src/state.js'] });
  const i27CommentLine = s2.censusClassifyTransition({ ...i27ReversalBase, changedPaths: ['src/state.js'] });
  const i27OneFileSourceFix = s2.censusClassifyTransition({ ...i27ReversalBase, changedPaths: ['src/state.js'] });
  // The four MEASURED false positives. None may fire rule 3, and none may be swallowed by its exclusivity.
  const i27Rule3FalsePositives = [i27DocsOnly, i27Rename, i27CommentLine, i27OneFileSourceFix];
  check(
    'I27',
    'CROSS_PACKAGE_COMPLETED-requires-a-FOREIGN-package-whose-export-the-disappeared-identifier-came-from',
    i27Rule3FalsePositives.every(
      (entry) =>
        !entry.fired.includes('CROSS_PACKAGE_COMPLETED') &&
        entry.not_fired.includes('CROSS_PACKAGE_COMPLETED') &&
        !entry.undecidable.includes('CROSS_PACKAGE_COMPLETED') &&
        // ...and the residual is NOT suppressed, which is the second half of the defect: the old rule ate
        // SOURCE_CHANGE, so a plain source change was reported as a cross-package completion.
        entry.fired.includes('SOURCE_CHANGE') &&
        entry.exclusive_rule_fired === null,
    ) &&
      // The one-file in-package source fix is the shape that matters most, and it is a SOURCE_CHANGE.
      i27OneFileSourceFix.classification === 'SOURCE_CHANGE' &&
      i27OneFileSourceFix.fired.length === 1 &&
      // No diff here names a foreign package, which is the whole of why rule 3 cannot fire on any of them — asserted
      // against the REAL foreign-path computation over a REAL commit of this repository, not a stub.
      i27Rule3FalsePositives.every((entry) => entry.foreign_package_paths !== null && entry.foreign_package_paths.length === 0) &&
      s2.censusStepPackage('benchmark', 'benchmark-suite') !== null &&
      // THE EXPORT READER IS REACHABLE, and this is the regression it is checked against. It used to pass
      // `"<sha> -- <dir>"` as a SINGLE argv element, which git rejects as an ambiguous revision: EVERY call returned
      // `null`, `foreignExports` was permanently unreadable, both cross-package rules were permanently `undecidable`,
      // and rule 2's "names a changed export of it" half could never be asked at all. An array — even an empty one —
      // is the observable difference between a read that happened and a read that failed.
      Array.isArray(s2.censusAddedExports(i27Commit, 'shared')) &&
      Array.isArray(s2.censusAddedExports(i27Commit, 'does-not-exist-9f2a')) &&
      // ...and a real commit that added a real export is really read, so the reader is not merely non-null but working.
      Array.isArray(s2.censusAddedExports(i27ExportCommit, 'shared')) &&
      s2.censusAddedExports(i27ExportCommit, 'shared').length > 0,
    `docs=${i27DocsOnly.classification} rename=${i27Rename.classification} comment=${i27CommentLine.classification} fix=${i27OneFileSourceFix.classification} fired=${JSON.stringify(i27Rule3FalsePositives.map((entry) => entry.fired))}`,
  );

  // The per-package reader, asserted where the cross-package half is now decided: a name a FOREIGN package exported is
  // resolvable to that package, and an unreadable directory is reported rather than presented as an empty export list.
  const i27ForeignRead = s2.censusForeignPackageExports(i27Commit, ['shared/src/types/task.ts', 'shared/src/index.ts']);
  check(
    'I27',
    'a-cross-package-export-is-resolved-to-the-PACKAGE-it-came-from-and-an-unreadable-package-is-reported-not-hidden',
    Array.isArray(i27ForeignRead.names) &&
      Object.hasOwn(i27ForeignRead.directories, 'shared') &&
      i27ForeignRead.directories.shared !== null &&
      i27ForeignRead.unreadable.length === 0 &&
      // Two paths in ONE package produce ONE directory, deduplicated, so a name is never attributed twice and the
      // per-package answer is what a reader gets rather than a flattened list.
      Object.keys(s2.censusForeignPackageExports(i27Commit, ['shared/src/a.ts', 'shared/src/b.ts']).directories).length === 1 &&
      // ...and the names really are read: a real commit that added a real export in `shared/` resolves to a non-empty
      // list. This is the half that used to be unreachable.
      s2.censusForeignPackageExports(i27ExportCommit, ['shared/src/index.ts']).names.length > 0,
    `sharedExports=${i27ForeignRead.names.length} unreadable=${i27ForeignRead.unreadable.length} dirs=${Object.keys(i27ForeignRead.directories).join(',')}`,
  );

  const i27LintStep = s2.censusClassifyTransition({
    ...i27Base,
    step: 'lint',
    gateName: 'check',
    changedPaths: ['src/state.spec.js'],
    signatureAfter: ['ok'],
  });
  check(
    'I27',
    'TEST_EVOLUTION-is-INAPPLICABLE-to-a-step-that-owns-no-test-glob-and-says-so-rather-than-simply-not-firing',
    i27LintStep.inapplicable.includes('TEST_EVOLUTION') &&
      !i27LintStep.fired.includes('TEST_EVOLUTION') &&
      // INAPPLICABLE is not UNDECIDABLE: a rule that was never in scope withholds no label, which is why a lint
      // transition is still classifiable while a MISSING SIGNATURE is not.
      !i27LintStep.undecidable.includes('TEST_EVOLUTION') &&
      i27LintStep.classification === 'SOURCE_CHANGE' &&
      // The test-glob question is a function of the package the step OWNS: a `.spec.ts` in a package the step does not
      // own is not this step's test, and the real function says so.
      s2.censusIsTestPath('server/src/app.spec.ts', 'server/package.json') === true &&
      s2.censusIsTestPath('server/src/app.spec.ts', 'ui/package.json') === false &&
      s2.censusIsTestPath('src/run-tests.js', 'package.json') === false,
    `lintStep=${i27LintStep.classification} undecidable=${JSON.stringify(i27LintStep.undecidable)}`,
  );

  // ---- F7, PART 1: THE EXIT TEXTS SAY WHAT THE CODE ACTUALLY DOES.
  //
  // `CENSUS_EXIT_BASIS[0]` used to read "the monotonicity verdict is MONOTONE or UNDETERMINED", which was stale: an
  // UNDETERMINED range ALWAYS yields 5 by the documented precedence, so a 0 is reachable only with a MONOTONE verdict
  // and no region. A basis that lists an unreachable condition is a manual that argues with the program.
  check(
    'I27',
    'the-exit-basis-states-only-the-conditions-that-are-REACHABLE-and-the-evaluate-overlap-is-disclosed-not-glossed',
    // The 0 basis no longer offers UNDETERMINED as a producer of 0, and says why.
    !/MONOTONE or UNDETERMINED/.test(s2.CENSUS_EXIT_BASIS['0']) &&
      /UNDETERMINED is NOT among the conditions that produce a 0/.test(s2.CENSUS_EXIT_BASIS['0']) &&
      /always yields 5/.test(s2.CENSUS_EXIT_BASIS['0']) &&
      // The 5 basis still explains the hole, because the hole is the reason 5 exists at all.
      /hole/.test(s2.CENSUS_EXIT_BASIS['5']) &&
      // `is_an_evaluate_exit_code: false` is true of the SET and was overstating as a claim about NUMBERS. The
      // structural discriminator is now on the record: the numeric overlap is named, 3 is excluded from both, and no
      // ledger is written.
      s2.CENSUS_EXIT_RULE.is_an_evaluate_exit_code === false &&
      JSON.stringify(s2.CENSUS_EXIT_RULE.evaluate_numeric_overlap) === '[0,2]' &&
      /numerically identical/.test(s2.CENSUS_EXIT_RULE.evaluate_numeric_overlap_is_not_identity) &&
      s2.CENSUS_EXIT_RULE.exit_3_never_emitted_by_either_command === true &&
      s2.CENSUS_EXIT_RULE.no_ledger_is_written === true &&
      ![0, 1, 2, 4, 5].includes(3) &&
      // The precedence is unchanged and still decides every code.
      s2.CENSUS_EXIT_RULE.order.join(',') === 'ERROR,UNDETERMINED,FINDING',
    `basis0=${s2.CENSUS_EXIT_BASIS['0'].slice(0, 80)} overlap=${JSON.stringify(s2.CENSUS_EXIT_RULE.evaluate_numeric_overlap)}`,
  );

  // ---- F7, PART 2: THE GENERATED_PATH SUB-RULE IS REACHABLE, AND IT IS NOT A CLASSIFICATION.
  //
  // The `allGenerated` / `readsGenerated` trigger fires beside SOURCE_CHANGE every time, because PREDICATE_DESIGN is a
  // COMPETING rule and never suppresses the residual. So the classification is always INCONCLUSIVE there. What was
  // missing is any statement of that, and `subrule` reads like a label. Both are now fields.
  const i27GeneratedOnly = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['dist/state.js'],
    signatureBefore: ['ok'],
    signatureAfter: ['ok'],
  });
  const i27GeneratedConfig = s2.censusClassifyTransition({
    ...i27Base,
    changedPaths: ['src/state.js'],
    signatureBefore: ['ok'],
    signatureAfter: ['ok'],
    scriptValueChanged: true,
  });
  check(
    'I27',
    'the-GENERATED_PATH-sub-rule-is-REACHABLE-and-is-named-a-trigger-and-never-a-classification',
    // The trigger fires, the sub-rule is named, and the classification is INCONCLUSIVE with the reason ON the record.
    i27GeneratedOnly.subrules.PREDICATE_DESIGN?.subrule === 'GENERATED_PATH' &&
      i27GeneratedOnly.subrules.PREDICATE_DESIGN?.subrule_is_a_trigger_not_a_classification === true &&
      /always INCONCLUSIVE/.test(i27GeneratedOnly.subrules.PREDICATE_DESIGN?.classification_always_inconclusive ?? '') &&
      i27GeneratedOnly.fired.includes('PREDICATE_DESIGN') &&
      i27GeneratedOnly.fired.includes('SOURCE_CHANGE') &&
      i27GeneratedOnly.classification === 'INCONCLUSIVE' &&
      // ...and the sub-rule is NEVER the reported classification, which is the claim that was unreachable as a label.
      i27GeneratedOnly.classification !== i27GeneratedOnly.subrules.PREDICATE_DESIGN.subrule &&
      i27GeneratedOnly.rule === null &&
      // A CONFIGURATION trigger reports itself and claims nothing about the generated path, so the field that is
      // INCONCLUSIVE-by-construction is null rather than misleadingly filled.
      i27GeneratedConfig.subrules.PREDICATE_DESIGN?.subrule === 'CONFIGURATION' &&
      i27GeneratedConfig.subrules.PREDICATE_DESIGN?.classification_always_inconclusive === null,
    `generated=${i27GeneratedOnly.classification} subrule=${i27GeneratedOnly.subrules.PREDICATE_DESIGN?.subrule} config=${i27GeneratedConfig.subrules.PREDICATE_DESIGN?.subrule}`,
  );

  // ---- F6: THE ORDER-COUPLED RESIDUAL IS CARRIED INTO THE CENSUS, WHERE IT IS WORSE.
  //
  // `CENSUS_LIMITATIONS` carried only "a single observation per commit cannot distinguish a flaky predicate from a
  // real difference", and grepping a produced artifact for `parity`, `trial-index`, `order-coupled`, `interleav` and
  // `exchangeab` returned nothing. A census measures every commit exactly once in a fixed oldest->newest order —
  // precisely the schedule the interleaving fix was built to defeat for `regress` — and it has no counterpart.
  const i27Limitations = s2.CENSUS_LIMITATIONS.join(' ');
  check(
    'I27',
    'the-census-carries-the-ORDER-COUPLED-residual-that-its-fixed-single-trial-schedule-creates',
    s2.CENSUS_LIMITATIONS.some((line) => /ORDER-COUPLED RESIDUAL/.test(line)) &&
      // One trial per commit, in a FIXED order, named as the schedule itself.
      /FIXED oldest-to-newest order/.test(i27Limitations) &&
      /no rotation, no interleaving and no second trial/.test(i27Limitations) &&
      // The three couplings that survive any schedule, named as a comparison cannot name them.
      /PARITY/.test(i27Limitations) &&
      /ABSOLUTE ORDER/.test(i27Limitations) &&
      /one-shot resource/.test(i27Limitations) &&
      // ...and the standing assumption, with the words a reader greps for.
      /exchangeability: assumed, unverified/.test(i27Limitations) &&
      // The order is a DISCLOSURE, never a classification input — otherwise the disclosure would be a hidden input.
      /DISCLOSURE, never a classification input/.test(i27Limitations) &&
      /CANNOT be distinguished from a real difference/.test(i27Limitations) &&
      // The pre-existing single-observation limitation is still there, and neither sentence was softened away.
      s2.CENSUS_LIMITATIONS.some((line) => /a census commit is ONE trial/.test(line)) &&
      /worktree is not a security boundary/.test(i27Limitations) &&
      /same-principal writer/.test(i27Limitations),
    `orderResidual=${/ORDER-COUPLED RESIDUAL/.test(i27Limitations)} parity=${/PARITY/.test(i27Limitations)} exchangeability=${/exchangeability: assumed, unverified/.test(i27Limitations)}`,
  );

  // ---- F4: THE REPLAY FIDELITY RECORD, AND THE FIELDS IT NAMES.
  check(
    'I27',
    'the-replay-fidelity-record-names-every-derivation-input-and-says-which-two-fields-are-not-persisted',
    Array.isArray(s2.CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs) &&
      // The two that were read back and never written are the two that made a replay disagree with a fresh run.
      s2.CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs.includes('signature') &&
      s2.CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs.includes('installed_tree_fingerprint_tier') &&
      s2.CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs.every((field) => typeof field === 'string') &&
      // The two that are NOT persisted are named, and they are whole attestation blobs no derivation reads.
      JSON.stringify(s2.CENSUS_REPLAY_FIDELITY.not_persisted) ===
        JSON.stringify(s2.CENSUS_ROW_FIELDS_NOT_PERSISTED) &&
      s2.CENSUS_ROW_FIELDS_NOT_PERSISTED.every((field) => s2.CENSUS_REPLAY_FIDELITY.not_persisted.includes(field)) &&
      s2.CENSUS_ROW_FIELDS_NOT_PERSISTED.includes('environment_record') &&
      s2.CENSUS_ROW_FIELDS_NOT_PERSISTED.includes('workspace_state') &&
      // The basis says what the record cannot claim: a worktree is not a security boundary, and this is not
      // authenticity — a resumed census reporting the same account is a property of the log, not of the history.
      /never re-measured/.test(s2.CENSUS_REPLAY_FIDELITY.basis) &&
      /rather than degrading silently/.test(s2.CENSUS_REPLAY_FIDELITY.basis) &&
      !/\b(stable|confirmed|reproducible)\b/i.test(s2.CENSUS_REPLAY_FIDELITY.basis),
    `persisted=${s2.CENSUS_REPLAY_FIDELITY.persisted_derivation_inputs.length} notPersisted=${s2.CENSUS_REPLAY_FIDELITY.not_persisted.join(',')}`,
  );

  // ---- F7, PART 3: BOTH INHERITED FLAGS ARE REFUSED BY NAME, AT THE BOUNDARY.
  check(
    'I27',
    'an-unrecognised---fingerprint-or---gate-env-is-a-NAMED-refusal-and-not-a-silent-fallback',
    s2.CENSUS_REFUSAL_NAMES.includes('unknown_fingerprint_tier') &&
      s2.CENSUS_REFUSAL_NAMES.includes('unknown_gate_env_policy') &&
      // The names are published, so a caller reads a reason without parsing prose.
      s2.CENSUS_REFUSAL_NAMES.length === new Set(s2.CENSUS_REFUSAL_NAMES).size &&
      // The two flags are real, and the refusal can quote them, so this is not a check against invented constants.
      s2.TREE_FINGERPRINT_TIERS.join(',') === 'metadata,content' &&
      s2.GATE_ENV_POLICIES.includes('sanitised') &&
      // `code_3_never_emitted` covers the refusal code as well as the finding code: every refusal is 2.
      s2.CENSUS_EXIT_USAGE === 2 &&
      !s2.CENSUS_EXIT_USAGE.toString().includes('3'),
    `tiers=${s2.TREE_FINGERPRINT_TIERS.join(',')} policies=${s2.GATE_ENV_POLICIES.join(',')} refusals=${s2.CENSUS_REFUSAL_NAMES.length}`,
  );

  // (d) UNDEFINED IS ENUMERATED, NON-RESOLVING, AND NEVER A FAIL. The block is what makes a hole visible instead of
  //     quietly narrowing the range, and the adjacency rule is what stops a transition being read ACROSS one.
  const i27Unresolved = s2.censusUnresolvedBlock({ rows: i27ReversalAndGap.rows, transitions: [] });
  check(
    'I27',
    'UNDEFINED-and-INCONCLUSIVE-are-ENUMERATED-and-non-resolving-and-a-transition-is-never-read-across-one',
    i27Unresolved.undefined_commits.length === 1 &&
      i27Unresolved.undefined_commits[0].commit === i27Sha(3) &&
        // A step the manifests do not declare spawned NOTHING: that is recorded, and `gate_exit_code` is an explicit null.
        i27Unresolved.undefined_commits[0].spawned === false &&
        i27Unresolved.undefined_commits[0].reason === 'script_not_declared' &&
      i27Unresolved.undefined_commits[0].gate_exit_code === null &&
      i27Unresolved.non_resolving === true &&
      i27Unresolved.transitions_bridged_a_gap === false &&
      // The five states, with UNDEFINED distinct from INCONCLUSIVE and from FAIL.
      s2.CENSUS_STATES.join(',') === 'PASS,FAIL,UNDEFINED,INCONCLUSIVE,ERROR' &&
      !s2.CENSUS_STATES.includes('CULPRIT') &&
      /whose 125 means "exclude this commit and keep searching"/.test(i27Unresolved.basis) &&
      /exactly the narrowing this command does not do/.test(i27Unresolved.basis) &&
      // The matrix keeps the hole: an UNDEFINED commit is a row with a state, not a missing row.
      i27ReversalAndGap.rows.length === 4 &&
      i27ReversalAndGap.rows[3].state === 'UNDEFINED' &&
      i27ReversalAndGap.rows[3].gate_exit_code === null,
    `undefined=${i27Unresolved.undefined_commits.length} rows=${i27ReversalAndGap.rows.length}`,
  );

  // (e) THE EXIT SET AND THE TERMINOLOGY, as DATA. `3` is never emitted, the precedence is 4 > 5 > 1, none of these is
  //     an evaluate exit code, and a refused removal never demotes the code it did not replace.
  const i27ExitCodes = [
    s2.CENSUS_EXIT_NO_FINDING,
    s2.CENSUS_EXIT_FINDING,
    s2.CENSUS_EXIT_USAGE,
    s2.CENSUS_EXIT_COMMIT_ERROR,
    s2.CENSUS_EXIT_UNDETERMINED,
  ];
  check(
    'I27',
    'the-census-publishes-its-own-command-local-exit-set-with-3-never-emitted-and-a-documented-precedence',
    i27ExitCodes.join(',') === '0,1,2,4,5' &&
      !i27ExitCodes.includes(3) &&
      new Set(i27ExitCodes).size === 5 &&
      s2.CENSUS_EXIT_RULE.error_outranks_undetermined === true &&
      s2.CENSUS_EXIT_RULE.undetermined_outranks_finding === true &&
      s2.CENSUS_EXIT_RULE.cleanup_refusal_never_demotes === true &&
      s2.CENSUS_EXIT_RULE.printed_exit_equals_process_exit === true &&
      s2.CENSUS_EXIT_RULE.code_3_never_emitted === true &&
      s2.CENSUS_EXIT_RULE.is_an_evaluate_exit_code === false &&
      // Every code carries its own basis, so the printed number and the manual cannot contradict each other.
      Object.keys(s2.CENSUS_EXIT_BASIS).join(',') === '0,1,2,4,5' &&
      Object.values(s2.CENSUS_EXIT_BASIS).every((text) => typeof text === 'string' && text.length > 40) &&
      // Every refusal has a NAME in the published list, so a caller reads a reason without parsing prose.
      Array.isArray(s2.CENSUS_REFUSAL_NAMES) &&
      s2.CENSUS_REFUSAL_NAMES.includes('not_an_ancestor_path') &&
      s2.CENSUS_REFUSAL_NAMES.includes('range_too_long') &&
      s2.CENSUS_REFUSAL_NAMES.includes('census_session_rebound'),
    `codes=${i27ExitCodes.join(',')}`,
  );

  const i27CensusText = [
    s2.CENSUS_NOT_A_SEARCH,
    s2.CENSUS_TRANSITION_NOT_A_CAUSE,
    s2.CENSUS_CLASSIFICATION_BASIS,
    s2.CENSUS_MONOTONICITY_BASIS,
    s2.CENSUS_NO_INFORMATION_BASIS,
    s2.CENSUS_MAX_COMMITS_BASIS,
    ...s2.CENSUS_LIMITATIONS,
    ...Object.values(s2.CENSUS_ERROR_MODES),
  ].join(' ');
  check(
    'I27',
    'the-census-says-in-the-same-words-everywhere-that-a-transition-is-not-a-cause-and-that-it-is-not-a-search',
    /A TRANSITION IS NOT A CAUSE/.test(s2.CENSUS_TRANSITION_NOT_A_CAUSE) &&
      /never named as the responsible party/.test(s2.CENSUS_TRANSITION_NOT_A_CAUSE) &&
      /candidate can be the boundary and still be innocent/.test(s2.CENSUS_TRANSITION_NOT_A_CAUSE) &&
      /NOT a search/.test(s2.CENSUS_NOT_A_SEARCH) &&
      /no flag and no stub/.test(s2.CENSUS_NOT_A_SEARCH) &&
      // The forbidden word appears NOWHERE in the census's own vocabulary — not in the sources, not in the fields, not
      // in the error modes. A rule that has to name the thing it forbids in order to forbid it has already used it.
      !/\bculprit\b/i.test(i27CensusText) &&
      // And a classification is never presented as a cause, in the data or in the prose.
      /not a cause/i.test(s2.CENSUS_CLASSIFICATION_BASIS) &&
      // The standing limitations are carried UNCHANGED and un-softened.
      /worktree is not a security boundary/.test(i27CensusText) &&
      /historical reproducibility is not result authenticity/.test(i27CensusText) &&
      /same-principal writer/.test(i27CensusText) &&
      // "stable", "confirmed" and "reproducible" are never predicate claims here.
      !/\b(stable|confirmed|reproducible)\b/i.test(s2.CENSUS_NOT_A_SEARCH) &&
      !/\b(stable|confirmed|reproducible)\b/i.test(s2.CENSUS_MONOTONICITY_BASIS) &&
      // The scope of the verdict is stated in the record, not left to the reader to reconstruct.
      /MEASURED RANGE/.test(s2.CENSUS_MONOTONICITY_BASIS),
    `culprit_in_text=${/\bculprit\b/i.test(i27CensusText)}`,
  );

  // (f) NOT A SEARCH, ASSERTED AGAINST THE RUNTIME ITSELF rather than against prose: there is no flag, no subcommand
  //     and no stub. A census that could narrow would make every one of the sentences above a promise rather than a fact.
  // The help is read as FLATTENED PROSE: a documentation assertion is about the SENTENCE, not about where the
  // renderer broke the line, and the census block is wrapped by the formatter.
  const i27Help = flattenProse(runHarness(REAL_REPO_ROOT, ['--help'], join(REAL_REPO_ROOT, '.harness')).stdout);
  check(
    'I27',
    'the-census-emits-no-midpoint-no-narrowing-and-no-first-bad-commit-and-automatic-boundary-search-remains-unreachable',
    /history census/.test(i27Help) &&
      /census --from=<ref> --to=<ref> --step=<name> --task=<id>/.test(i27Help) &&
      /failure REGIONS and classified CANDIDATES/.test(i27Help) &&
      /NOT A SEARCH/.test(i27Help) &&
      /it never narrows, halves, samples or selects a midpoint/.test(i27Help) &&
      /it emits no "first bad commit"/.test(i27Help) &&
      /Automatic boundary search of any kind remains a recorded NO-GO with no command, no flag and no stub/.test(i27Help) &&
      // The CLI surface offers no way to reach an automatic boundary search — asserted against the WHOLE help, which is
      // also the pre-existing P5 rule and therefore cannot be weakened here.
      !/bisect/i.test(i27Help) &&
      !/--first-bad/.test(i27Help) &&
      // The five states and the exit set are in the help a reader actually opens.
      /PASS \| FAIL \| UNDEFINED \| INCONCLUSIVE \| ERROR/.test(i27Help) &&
      /0 no failure region \| 1 at least one failure region \| 2 usage\/refused \| 4 a commit is ERROR \| 5 the range is UNDETERMINED/.test(
        i27Help,
      ) &&
      // The range is bounded and the refusal says who narrows it.
      s2.CENSUS_MAX_COMMITS > 0 &&
      Number.isInteger(s2.CENSUS_MAX_COMMITS) &&
      /will not split the range, will not sample it/.test(s2.CENSUS_MAX_COMMITS_BASIS) &&
      /only way past it is to name a SHORTER range yourself/.test(s2.CENSUS_MAX_COMMITS_BASIS),
    `help_has_census=${/history census/.test(i27Help)} help_reaches_a_search=${/bisect/i.test(i27Help)}`,
  );

  // ---- F9: this run's own temporary roots, cleaned and MEASURED before the report is written.
  //
  // The assertion is the normal path's claim, checked against the real roots this run created rather than against a
  // count: after the cleanup call, none of them exists. The exit handler is the second line of defence and the sweep
  // covers a run this process could not clean at all (SIGKILL, power loss) — neither is what makes the suite
  // idempotent, because both were added after the leak; what makes it idempotent is that the last line of a passing run
  // deletes what the run created.
  // Read the roots BEFORE the cleanup, so the assertion below can check the filesystem afterwards for each one.
  const rootsCreatedByThisRun = suiteTempRoots();
  const f9Cleanup = cleanupSuiteTempDirs();
  const f9Sweep = sweepStaleSuiteTempDirs();

  check(
    'I24',
    'the-suite-leaves-no-temporary-fixture-behind-on-the-normal-path',
    f9Cleanup.failed.length === 0 &&
      f9Cleanup.removed === f9Cleanup.attempted &&
      f9Cleanup.attempted > 0 &&
      // Every root it claims to have removed is GONE from the filesystem, not merely un-registered.
      rootsCreatedByThisRun.every((directory) => !existsSync(directory)),
    `attempted=${f9Cleanup.attempted} removed=${f9Cleanup.removed} failed=${f9Cleanup.failed.length}`,
  );
  check(
    'I24',
    'a-stale-root-from-a-killed-run-is-swept-and-a-fresh-one-is-left-alone',
    f9Sweep.scanned === true &&
      f9Sweep.failed.length === 0 &&
      // The conservative property that makes the sweep safe to run at all: a concurrent run's fixtures are young, so
      // the sweep refuses them rather than pulling them out from under it.
      f9Sweep.removed <= f9Sweep.considered - f9Sweep.refused_too_young,
    `considered=${f9Sweep.considered} removed=${f9Sweep.removed} too_young=${f9Sweep.refused_too_young}`,
  );

  // ---- I28: the AGENT-FIRST surface. Six changes, and this group asserts the PURE parts of them here because they are
  // functions of their inputs and can therefore be driven with no repository, no install and no gate; the E26 family
  // drives the real CLI over real disposable git fixtures. Nothing here is a restatement of a comment: each assertion
  // reads the value the runtime will actually use.
  //
  // The group exists because the defects it covers were not missing features. They were ways the harness could be
  // MISREAD by an autonomous agent, and an agent cannot detect a misreading from the output.
  const i28Scope = (over) =>
    s2.evaluateVerdictScope({
      runGate: true,
      gateIncompatible: false,
      stepMode: false,
      stepState: null,
      stepsRun: 5,
      stepsTotal: 5,
      gateName: s2.CANONICAL_GATE,
      ...over,
    });

  check(
    'I28',
    'the-verdict-scope-derivation-separates-the-seven-outcomes-Experiment-E-depends-on',
    // The whole of Experiment E in one derivation: the canonical gate at 5 of 5 is FULL_GATE, and `check:fast` at 3 of
    // 3 is SUBSET_GATE even though BOTH pass and both exit 0. The discriminator is a comparison against the canonical
    // gate's own step count, computed here in-process because `GATES` is a module-local constant and the canonical step
    // list is recorded nowhere durable.
    i28Scope({}) === 'FULL_GATE' &&
      i28Scope({ gateName: 'check:fast', stepsRun: 3, stepsTotal: 3 }) === 'SUBSET_GATE' &&
      i28Scope({ stepsRun: 3, stepsTotal: 5 }) === 'PARTIAL_FAIL_FAST' &&
      i28Scope({ stepMode: true, stepState: 'runnable', stepsRun: 1, stepsTotal: 5 }) === 'SINGLE_STEP' &&
      i28Scope({ stepMode: true, stepState: 'UNDEFINED', stepsRun: 0, stepsTotal: 5 }) === 'UNDEFINED' &&
      i28Scope({ gateIncompatible: true, stepsRun: 0, stepsTotal: 5 }) === 'GATE_INCOMPATIBLE' &&
      i28Scope({ runGate: false, stepsRun: 0, stepsTotal: 5 }) === 'NO_GATE' &&
      s2.CANONICAL_STEP_COUNT === 5 &&
      // The ORDER is the argument: a per-step run is SINGLE_STEP whatever else is true, and an UNDEFINED one is never
      // relabelled — both are checked above with a `gateIncompatible` shape that would otherwise win.
      i28Scope({ stepMode: true, stepState: 'UNDEFINED', gateIncompatible: true }) === 'UNDEFINED' &&
      i28Scope({ stepMode: true, stepState: 'runnable', gateIncompatible: true }) === 'SINGLE_STEP' &&
      // Every value the derivation can produce is one the published enumeration names, so a new branch cannot ship an
      // undocumented scope.
      new Set(
        [
          i28Scope({}),
          i28Scope({ gateName: 'check:fast', stepsRun: 3, stepsTotal: 3 }),
          i28Scope({ stepsRun: 3, stepsTotal: 5 }),
          i28Scope({ stepMode: true, stepState: 'runnable' }),
          i28Scope({ stepMode: true, stepState: 'UNDEFINED' }),
          i28Scope({ gateIncompatible: true }),
          i28Scope({ runGate: false }),
        ],
      ).size === s2.VERDICT_SCOPES.length &&
      s2.VERDICT_SCOPES.every((scope) => typeof scope === 'string' && scope.length > 0),
    `scopes=${[
      i28Scope({}),
      i28Scope({ gateName: 'check:fast', stepsRun: 3, stepsTotal: 3 }),
      i28Scope({ stepsRun: 3, stepsTotal: 5 }),
    ].join(',')} canonical=${s2.CANONICAL_STEP_COUNT}`,
  );

  check(
    'I28',
    'only-a-whole-gate-run-can-be-a-GATE_PASS-and-the-VERSION-and-NOT_A_GATE_PASS-vocabulary-is-closed',
    s2.VERDICT_SCHEMA === 'harness.evaluate.verdict/1' &&
      s2.VERDICT_VALUES.length === 3 &&
      s2.evaluateVerdictValue('FULL_GATE', 0) === 'GATE_PASS' &&
      // B2. This conjunct used to read `=== 'GATE_PASS'`, which is the assertion's OWN LABEL contradicted by its own
      // body: the label has always said "only a whole-gate run can be a GATE_PASS" and the body said a strict subset
      // could. The adversarial review reproduced the consequence on a tree whose UI tests fail:
      // `--gate=check:fast --json` exited 0 with `verdict: GATE_PASS`, so the two signals a hurried reader takes first
      // — the word and the exit code — were both green while the project did not validate. The label is the
      // specification; the body was the defect. It now asserts what the label says, which is strictly more.
      s2.evaluateVerdictValue('SUBSET_GATE', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('FULL_GATE', 1) === 'GATE_FAIL' &&
      s2.evaluateVerdictValue('SUBSET_GATE', 1) === 'GATE_FAIL' &&
      // "The step passed" and "the gate passed" cannot collapse into one word. This is the load-bearing value.
      s2.evaluateVerdictValue('SINGLE_STEP', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('PARTIAL_FAIL_FAST', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('UNDEFINED', null) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('GATE_INCOMPATIBLE', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('NO_GATE', null) === 'NOT_A_GATE_PASS' &&
      // Even a `GATE_FAIL` on a subset is a failure OF A SUBSET, and it is never dressed as a whole-gate failure by the
      // value vocabulary — the scope carries that, and the scope is mandatory.
      s2.VERDICT_VALUES.every((value) => typeof value === 'string' && value.length > 0),
    `values=${s2.VERDICT_VALUES.join('|')}`,
  );

  check(
    'I28',
    'the-prior-observation-summariser-reports-a-COUNT-and-a-DISAGREEMENT-and-asserts-nothing',
    // One observation cannot disagree with itself, and an empty group is never vacuously "contradicted".
    s2.summariseExitCodes([]).n === 0 &&
      s2.summariseExitCodes([]).contradicted === false &&
      s2.summariseExitCodes([0]).contradicted === false &&
      s2.summariseExitCodes([0, 0, 0]).contradicted === false &&
      s2.summariseExitCodes([0, 1]).contradicted === true &&
      s2.summariseExitCodes([1, 0]).contradicted === true &&
      s2.summariseExitCodes([0, 1, 2]).distinct_gate_exit_codes.join(',') === '0,1,2' &&
      s2.summariseExitCodes([0, 1]).n === 2 &&
      // No rate, no bound, and none of the three words that would turn a memory into a guarantee. The basis states the
      // residuals it inherits, because inheriting them silently is how a memory becomes a claim.
      !/\b\d+(\.\d+)?\s?%/.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /\bno exchangeability assumption\b/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /trial-index parity/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /absolute order of gate executions/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /one-shot resource/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      s2.PRIOR_OBSERVATIONS_MAX_STREAMS > 0 &&
      Number.isInteger(s2.PRIOR_OBSERVATIONS_MAX_STREAMS),
    `basis_has_percent=${/\d\s?%/.test(s2.PRIOR_OBSERVATIONS_BASIS)}`,
  );

  check(
    'I28',
    'the-prior-observation-KEY-separates-states-by-commit-contract-source-status-gate-and-step',
    // A different commit, a different contract, a different dirty state, a different gate or a different step is a
    // DIFFERENT state, and two different states must never join one group. This is the correction the experiments
    // forced: the key reads run_started because run_finished leaves two of these null on some records.
    s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) !==
      s2.priorObservationKey({ judged_commit: 'z', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) &&
      s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) !==
        s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'z', judged_source_status_hash: 'c', gate: 'check' }) &&
      s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) !==
        s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'z', gate: 'check' }) &&
      s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) !==
        s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check:fast' }) &&
      s2.priorObservationKey({
        judged_commit: 'a',
        contract_digest: 'b',
        judged_source_status_hash: 'c',
        gate: 'check',
        step_scope: { requested: 'lint' },
      }) !== s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) &&
      // The same state IS the same state, or nothing would ever group.
      s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) ===
        s2.priorObservationKey({ judged_commit: 'a', contract_digest: 'b', judged_source_status_hash: 'c', gate: 'check' }) &&
      // Absent fields normalise to null rather than to `undefined`, so a historical record and a new one can group.
      s2.priorObservationKey({}) === s2.priorObservationKey({ judged_commit: null, contract_digest: null }),
    'key-collapses-two-different-states',
  );

  check(
    'I28',
    'the-flag-allowlist-is-PER-COMMAND-covers-every-dispatched-command-and-duplicates-nothing',
    // The regression net, stated as data: every command the CLI dispatches has an entry, each subcommand has one, no
    // allowlist repeats a flag, and `s2.flagAllowlistFor` resolves both a bare command and a subcommand.
    ['evaluate', 'regress', 'census', 'report', 'modes', 'predicates', 'handoff', 'telemetry', 'workspace', 'ledger', 'contract'].every(
      (command) => Array.isArray(s2.COMMAND_FLAG_ALLOWLIST[command]) || typeof s2.COMMAND_FLAG_ALLOWLIST[command] === 'object',
    ) &&
      ['prepare', 'remove', 'prune', 'show', 'list'].every((sub) => Array.isArray(s2.flagAllowlistFor('workspace', sub))) &&
      ['init', 'set', 'show', 'forensic'].every((sub) => Array.isArray(s2.flagAllowlistFor('ledger', sub))) &&
      Array.isArray(s2.flagAllowlistFor('contract', 'init')) &&
      // An unknown command resolves to null and is therefore NOT checked, rather than to an empty list that would refuse
      // everything it was given.
      s2.flagAllowlistFor('no-such-command', null) === null &&
      // Every ALLOWLIST, as a list of lists. A single `flatMap` would mix a top-level array (whose elements are flag
      // NAMES) with a per-subcommand object (whose elements are lists), and the shape check would then be applied to a
      // string — which passes or fails for reasons that have nothing to do with the allowlist.
      Object.values(s2.COMMAND_FLAG_ALLOWLIST)
        .map((entry) => (Array.isArray(entry) ? [entry] : Object.values(entry)))
        .flat()
        .every((list) => new Set(list).size === list.length && list.every((name) => /^[a-z][a-z0-9-]*$/.test(name))) &&
      // The flags the historical commands carry, all present where they are read. One of these is the design's own
      // falsifier: `workspace prepare` is documented to receive `--step` from `regress` and `census`.
      ['fingerprint', 'gate-env', 'repeat-session', 'keep', 'out', 'json'].every((name) =>
        s2.flagAllowlistFor('regress', null).includes(name),
      ) &&
      ['fingerprint', 'gate-env', 'census-session', 'keep', 'out', 'json', 'step', 'no-gate'].every((name) =>
        s2.flagAllowlistFor('census', null).includes(name),
      ) &&
      ['accept-inherited-env', 'accept-lockfile-version', 'accept-pm-mismatch', 'build-command', 'stale-after'].every(
        (name) => name === 'stale-after' ? s2.flagAllowlistFor('workspace', 'prune').includes(name) : s2.flagAllowlistFor('workspace', 'prepare').includes(name),
      ) &&
      s2.flagAllowlistFor('workspace', 'prepare').includes('step') &&
      ['artifact-integrity', 'verifier-verdict', 'acceptance', 'no-gate', 'no-contract', 'quiet', 'workspace', 'ledger', 'task', 'claim'].every(
        (name) => s2.flagAllowlistFor('evaluate', null).includes(name),
      ) &&
      // No command takes a positional except the two that dispatch a subcommand, and both consume it before the parse.
      Object.entries(s2.COMMAND_POSITIONAL_POLICY).every(([command, limit]) => limit === 0 && s2.COMMAND_FLAG_ALLOWLIST[command] !== undefined),
    `commands=${Object.keys(s2.COMMAND_FLAG_ALLOWLIST).join(',')}`,
  );

  check(
    'I28',
    'an-unknown-flag-and-a-stray-positional-are-REFUSED-BY-NAME-with-the-allowlist-printed',
    // The refusal is a THROW of the usage error the top level maps to exit 2, and the message names the offending flag,
    // prints what WOULD have been accepted, and says the reason — so a caller can act on it without reading the source.
    (() => {
      try {
        s2.assertKnownFlags('evaluate', null, { acceptence: 'pass' }, []);

        return false;
      } catch (error) {
        const message = String(error.message);

        return (
          /unknown flag for `evaluate`: --acceptence/.test(message) &&
          /accepted by `evaluate`: --acceptance/.test(message) &&
          message.includes(s2.UNKNOWN_FLAG_BASIS.slice(0, 80)) &&
          /exit: 2/.test(message)
        );
      }
    })() &&
      (() => {
        try {
          s2.assertKnownFlags('regress', null, {}, ['COMPAT']);

          return false;
        } catch (error) {
          return /`regress` takes no positional argument, but got: COMPAT/.test(String(error.message));
        }
      })() &&
      // A KNOWN flag with a known subcommand passes through untouched, and a command with no allowlist is not checked.
      (() => {
        const flags = { task: 'X', gate: 'check' };

        return s2.assertKnownFlags('evaluate', null, flags, []) === flags && s2.assertKnownFlags('nope', null, flags, ['x']) === flags;
      })() &&
      s2.UNKNOWN_FLAG_EXIT === 2,
    'the-refusal-message-lost-its-name-its-allowlist-or-its-reason',
  );

  check(
    'I28',
    'the-evaluate-exit-table-is-COMPLETE-covers-both-zero-rows-and-agrees-with-its-own-basis',
    // The table is ONE constant, `--help` prints it and the exit site is documented against it, so the help and the code
    // cannot drift into disagreeing about what a number means. Two rows return 0 — a whole gate and a single step — and
    // that is the change: a passing `--step` used to exit 1, which made a pass and a failure of the SAME measurement
    // indistinguishable by exit code alone.
    s2.EVALUATE_EXIT_TABLE.length >= 6 &&
      s2.EVALUATE_EXIT_TABLE.every(([code, meaning, scope]) => ['0', '1', '2', '3'].includes(code) && meaning.length > 20 && scope.length > 0) &&
      s2.EVALUATE_EXIT_TABLE.filter(([code]) => code === '0').length === 2 &&
      s2.EVALUATE_EXIT_TABLE.filter(([code]) => code === '0').some((row) => /SINGLE_STEP/.test(row[2])) &&
      s2.EVALUATE_EXIT_TABLE.some((row) => row[0] === '1' && /SINGLE_STEP/.test(row[2])) &&
      s2.EVALUATE_EXIT_TABLE.some((row) => row[0] === '2' && /no run stream/.test(row[2])) &&
      s2.EVALUATE_EXIT_TABLE.some((row) => row[0] === '3' && /GATE_INCOMPATIBLE/.test(row[2])) &&
      // `3` is never emitted by `regress` or `census`, and the table says which set is whose.
      !s2.EVALUATE_EXIT_TABLE.some((row) => /regress|census/.test(row[1]) && row[0] === '3') &&
      /It does not gain a code and it loses none/.test(s2.EVALUATE_EXIT_BASIS) &&
      /Exactly one row changed meaning/.test(s2.EVALUATE_EXIT_BASIS) &&
      /can never be read as a whole-gate pass/.test(s2.EVALUATE_EXIT_BASIS) &&
      /a per-step run still derives NO terminal state/i.test(s2.EVALUATE_EXIT_BASIS) &&
      s2.EVALUATE_EXIT_BASIS.length > 400,
    `rows=${s2.EVALUATE_EXIT_TABLE.length} zeros=${s2.EVALUATE_EXIT_TABLE.filter(([code]) => code === '0').length}`,
  );

  check(
    'I28',
    'a-contractless-task-invents-NO-criterion-and-declares-NO-baseline',
    // `s2.CONTRACTLESS_TASK` carries the field NAMES the run stream uses and nulls every value that would be a claim. A
    // plausible default here would be a fabricated baseline, which is the one thing a current-tree run must not have.
    s2.CONTRACTLESS_TASK.id === 'CONTRACTLESS' &&
      s2.CONTRACTLESS_TASK.source_commit === null &&
      Array.isArray(s2.CONTRACTLESS_TASK.acceptance) &&
      s2.CONTRACTLESS_TASK.acceptance.length === 0 &&
      s2.CONTRACTLESS_TASK.category === null &&
      typeof s2.CONTRACTLESS_TASK.workspace === 'object' &&
      // The seed caveat travels with the command that writes the seed, and says the thing that matters: a criterion
      // nobody wrote is not a criterion, so the verdict stays `unknown` until a human supplies one.
      /SEED, not a specification/.test(s2.CONTRACT_SEED_BASIS) &&
      /reports `acceptance: unknown`/.test(s2.CONTRACT_SEED_BASIS) &&
      /never the verdict/.test(s2.CONTRACT_SEED_BASIS),
    `task=${JSON.stringify(s2.CONTRACTLESS_TASK).slice(0, 200)}`,
  );

  check(
    'I28',
    'the-verdict-ENVIRONMENT-block-labels-every-digest-with-what-it-is-NOT',
    // Experiment D: the drift was detected and invisible. The block exists so two runs of one commit can be compared
    // without opening either stream — and every digest keeps the basis that says what it does not attest, because a
    // digest printed without its basis is an authority claim.
    (() => {
      const empty = s2.verdictEnvironment(null, 'sanitised');

      return empty.installed_state_digest === null &&
        empty.installed_state_digest_source === null &&
        empty.gate_env_policy === 'sanitised' &&
        /declared_by_npm/.test(empty.installed_state_digest_basis);
    })() &&
      (() => {
        const full = s2.verdictEnvironment(
          {
            installed_state_digest: 'abc123',
            installed_state_digest_source: 'package_lock_v3',
            installed_tree_fingerprint: 'def456',
            installed_tree_fingerprint_tier: 'metadata',
            build_state: { digest: 'aaa' },
            node: { version: 'v24.0.0' },
            package_manager: { name: 'npm', version: '12.0.1' },
            platform: { os: 'linux', arch: 'x64' },
            env: { vars_digest: 'bbb' },
            gate_env_policy: 'inherited',
          },
          'sanitised',
        );

        return full.installed_state_digest === 'abc123' &&
          full.installed_tree_fingerprint_tier === 'metadata' &&
          full.build_state_digest === 'aaa' &&
          full.node === 'v24.0.0' &&
          full.package_manager === 'npm 12.0.1' &&
          full.platform === 'linux/x64' &&
          // The record's own policy wins over the argument, because the record is what the run actually used.
          full.gate_env_policy === 'inherited';
      })(),
    'the-environment-block-dropped-a-field-or-lost-its-basis',
  );

  // ---- I29 — THE ADVERSARIAL FIX PASS. Every check here is a regression of a specific reproduction an independent
  // reviewer ran against the previous build, and the pure functions are driven directly so the claim is about the
  // FUNCTION rather than about one lucky run. The behavioural counterparts, on real disposable git fixtures, are the
  // E27 family in `.harness/tests/compatibility.mjs`.

  check(
    'I29',
    'GATE_PASS-is-reserved-for-the-canonical-whole-gate-and-a-subset-pass-is-NOT_A_GATE_PASS',
    // THE HEADLINE FALSE PASS. `--gate=check:fast` on a tree whose UI tests fail exited 0 with `GATE_PASS`; those
    // are the two signals a hurried reader takes first, and only `scope` (field 3) and `steps_total` (field 8) said
    // otherwise. The word now matches the scope.
    s2.evaluateVerdictValue('FULL_GATE', 0) === 'GATE_PASS' &&
      s2.evaluateVerdictValue('SUBSET_GATE', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('SINGLE_STEP', 0) === 'NOT_A_GATE_PASS' &&
      s2.evaluateVerdictValue('NO_GATE', null) === 'NOT_A_GATE_PASS' &&
      // A FAILURE is not suppressed, on any real-gate scope: suppressing `GATE_FAIL` would lose information to buy
      // nothing, because a failure is not what a hurried reader mistakes for a pass.
      s2.evaluateVerdictValue('SUBSET_GATE', 1) === 'GATE_FAIL' &&
      s2.evaluateVerdictValue('PARTIAL_FAIL_FAST', 1) === 'GATE_FAIL' &&
      s2.evaluateVerdictValue('FULL_GATE', 1) === 'GATE_FAIL' &&
      // Exhaustive: no scope and no exit code can produce a token outside the closed vocabulary, and no scope other
      // than FULL_GATE can produce GATE_PASS.
      s2.VERDICT_SCOPES.every((scope) => s2.VERDICT_VALUES.includes(s2.evaluateVerdictValue(scope, 0))) &&
      s2.VERDICT_SCOPES.every((scope) => s2.VERDICT_VALUES.includes(s2.evaluateVerdictValue(scope, 1))) &&
      s2.VERDICT_SCOPES.every((scope) => s2.evaluateVerdictValue(scope, 0) !== 'GATE_PASS' || scope === 'FULL_GATE') &&
      s2.VERDICT_SCOPES.every((scope) => s2.evaluateVerdictValue(scope, 1) !== 'GATE_PASS' || scope === 'FULL_GATE'),
    `FULL_GATE=${s2.evaluateVerdictValue('FULL_GATE', 0)} SUBSET_GATE=${s2.evaluateVerdictValue('SUBSET_GATE', 0)}`,
  );

  check(
    'I29',
    'gate_exit_code-is-never-0-where-nothing-ran-a-gate_incompatible-run-reports-an-explicit-null',
    // B1. `gateExit` is initialised to 0 before the loop, so a `gate_incompatible` run recorded `gate_exit_code: 0`
    // at process exit 3: a consumer branching on `=== 0` concluded the gate passed on a run where it never ran.
    s2.evaluatedGateExitCode({ stepScope: null, stepExitCode: 0, runGate: true, gateIncompatible: true, gateExit: 0 }) === null &&
      // A gate that DID run reports what it did, byte-identical to before.
      s2.evaluatedGateExitCode({ stepScope: null, stepExitCode: 0, runGate: true, gateIncompatible: false, gateExit: 0 }) === 0 &&
      s2.evaluatedGateExitCode({ stepScope: null, stepExitCode: 0, runGate: true, gateIncompatible: false, gateExit: 1 }) === 1 &&
      // `--no-gate` never reported a number and still does not.
      s2.evaluatedGateExitCode({ stepScope: null, stepExitCode: 0, runGate: false, gateIncompatible: false, gateExit: 0 }) === null &&
      // A per-step run reports the STEP's own code, and an UNDEFINED step an explicit null, in the same function.
      s2.evaluatedGateExitCode({ stepScope: {}, stepExitCode: 0, runGate: true, gateIncompatible: true, gateExit: 0 }) === 0 &&
      s2.evaluatedGateExitCode({ stepScope: {}, stepExitCode: null, runGate: true, gateIncompatible: false, gateExit: 0 }) === null &&
      // Every shape returns an integer or an explicit null — never `undefined`, never a boolean, on any combination.
      [
        { runGate: true, gateIncompatible: false },
        { runGate: true, gateIncompatible: true },
        { runGate: false, gateIncompatible: false },
        { runGate: false, gateIncompatible: true },
      ].every((shape) =>
        [0, 1, 7, 255].every((gateExit) => {
          const whole = s2.evaluatedGateExitCode({ stepScope: null, stepExitCode: null, ...shape, gateExit });
          const stepped = s2.evaluatedGateExitCode({ stepScope: {}, stepExitCode: null, ...shape, gateExit });
          const undefinedStep = s2.evaluatedGateExitCode({
            stepScope: { state: 'UNDEFINED' },
            stepExitCode: null,
            ...shape,
            gateExit,
          });

          return [whole, stepped, undefinedStep].every(
            (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 255),
          );
        }),
      ),
    'evaluatedGateExitCode returned something other than an integer or null',
  );

  check(
    'I29',
    'every-allowed-flag-is-either-a-VALUE-flag-or-a-BOOLEAN-flag-and-the-two-sets-are-disjoint',
    // B5. Enumerating the VALUE flags is safe in the loud direction: a flag nobody classified is refused on its bare
    // form, never silently ignored. The partition is what makes that claim checkable rather than aspirational.
    (() => {
      const pairs = [];

      // A command with subcommands declares its flags PER SUBCOMMAND, so the partition is checked per subcommand and
      // the command's own flat list is checked only where there is one.
      for (const [command, entry] of Object.entries(s2.COMMAND_FLAG_ALLOWLIST)) {
        const perSub = Array.isArray(entry) ? [[null, entry]] : Object.entries(entry);

        for (const [subcommand, allowlist] of perSub) {
          const values = s2.valueFlagsFor(command, subcommand) ?? [];
          const booleans = s2.booleanFlagsFor(command, subcommand) ?? [];

          for (const flag of allowlist) {
            pairs.push([`${command} ${subcommand ?? ''} --${flag}`, values.includes(flag), booleans.includes(flag)]);
          }
        }
      }

      return (
        pairs.length > 0 &&
        pairs.every(([, isValue, isBoolean]) => isValue !== isBoolean) &&
        // The two the reviewer used, and the whole class they stand for.
        s2.COMMAND_VALUE_FLAGS.evaluate.includes('ledger') &&
        s2.COMMAND_VALUE_FLAGS.evaluate.includes('task') &&
        s2.COMMAND_BOOLEAN_FLAGS.evaluate.includes('json') &&
        s2.COMMAND_BOOLEAN_FLAGS.evaluate.includes('no-contract')
      );
    })(),
    'a flag is in both sets, or in neither',
  );

  check(
    'I29',
    'the-bare-flag-refusal-is-decided-per-command-and-per-subcommand-not-from-a-single-flat-list',
    // A refusal that only worked for the one command it was written for would leave the class open. The regression
    // net is the same shape as the allowlist's: every dispatched command resolves, and a subcommand resolves to its
    // own list rather than to the command's.
    s2.valueFlagsFor('evaluate', null).includes('step') &&
      s2.valueFlagsFor('regress', null).includes('good') &&
      s2.valueFlagsFor('census', null).includes('from') &&
      s2.valueFlagsFor('workspace', 'prepare').includes('commit') &&
      !s2.valueFlagsFor('workspace', 'remove').includes('npm-cache') &&
      s2.valueFlagsFor('ledger', 'forensic').includes('run-id') &&
      !s2.valueFlagsFor('ledger', 'forensic').includes('json') &&
      s2.valueFlagsFor('contract', 'init').includes('title') &&
      s2.valueFlagsFor('report', null).includes('out') &&
      s2.valueFlagsFor('no-such-command', null) === null,
    'valueFlagsFor returned the wrong list for a command or subcommand',
  );

  check(
    'I29',
    'the-fence-neutralises-the-LITERAL-schema-token-and-never-produces-the-greppable-form',
    // B6. The fence already defeated LINE-PREFIX matching; a grep for the schema token still reached a forged
    // verdict object FIRST. The token is neutralised, not escaped: the threat is a substring search.
    s2.VERDICT_SCHEMA === 'harness.evaluate.verdict/1' &&
      !s2.VERDICT_SCHEMA_NEUTRALISED.includes(s2.VERDICT_SCHEMA) &&
      s2.neutraliseVerdictToken(`{"schema":"${s2.VERDICT_SCHEMA}","verdict":"GATE_PASS"}`).includes(
        s2.VERDICT_SCHEMA_NEUTRALISED,
      ) &&
      // Exactly one character differs, so the neutralised text is still recognisable to a reader who looks.
      s2.VERDICT_SCHEMA_NEUTRALISED.length === s2.VERDICT_SCHEMA.length &&
      [...s2.VERDICT_SCHEMA].filter((ch, i) => ch !== s2.VERDICT_SCHEMA_NEUTRALISED[i]).length === 1 &&
      // Idempotent, and every occurrence is replaced, not just the first.
      s2.neutraliseVerdictToken(s2.neutraliseVerdictToken(`a ${s2.VERDICT_SCHEMA} b ${s2.VERDICT_SCHEMA}`)) ===
        s2.neutraliseVerdictToken(`a ${s2.VERDICT_SCHEMA} b ${s2.VERDICT_SCHEMA}`) &&
      !s2.neutraliseVerdictToken(`a ${s2.VERDICT_SCHEMA} b ${s2.VERDICT_SCHEMA}`).includes(s2.VERDICT_SCHEMA) &&
      // Text that is not the token is untouched, so the fence still prints the gate's own words verbatim.
      s2.neutraliseVerdictToken('mechanically_verified: yes') === 'mechanically_verified: yes',
    'neutraliseVerdictToken did not neutralise, or neutralised something else',
  );

  check(
    'I29',
    'the-machine-surface-contract-is-ONE-statement-and-names-both-halves-the-last-line-and-the-token',
    // B6 asked for a choice to be made and documented. The choice: the machine surface is the LAST line of stdout,
    // and the literal token appears on that line only.
    /LAST line of stdout/.test(s2.MACHINE_SURFACE_BASIS) &&
      /harness\.evaluate\.verdict\/1/.test(s2.MACHINE_SURFACE_BASIS) &&
      /only/i.test(s2.MACHINE_SURFACE_BASIS) &&
      // A presentation boundary, never an authenticity claim: saying so keeps the fence from being over-read.
      /not an authenticity claim|never claims/i.test(s2.MACHINE_SURFACE_BASIS) &&
      s2.MACHINE_SURFACE_BASIS.length > 200 &&
      s2.MACHINE_SURFACE_BASIS.length < 2000,
    `length=${s2.MACHINE_SURFACE_BASIS.length}`,
  );

  check(
    'I29',
    'the-exit-BASIS-prose-agrees-with-OBSERVED-behaviour-and-no-longer-claims-a-missing---task-exits-1',
    // The reviewer verified the current build exits 2 for a missing `--task` and the basis still documented 1. A
    // basis that describes a build which no longer exists is worse than no basis: it is a specification.
    /exits 2 uniformly/.test(s2.EVALUATE_EXIT_BASIS) &&
      !/no --task exiting 1/.test(s2.EVALUATE_EXIT_BASIS) &&
      // And the claim the fix had to make true is now stated AND true: a subset gate is not a whole-gate pass.
      /SUBSET/.test(s2.EVALUATE_EXIT_BASIS) &&
      /NOT_A_GATE_PASS/.test(s2.EVALUATE_EXIT_BASIS) &&
      // The scope-travelling claim survives, and still covers `--step`.
      /SINGLE_STEP, never FULL_GATE/.test(s2.EVALUATE_EXIT_BASIS) &&
      // A bare value-flag is a refusal at 2, named explicitly.
      /--ledger/.test(s2.EVALUATE_EXIT_BASIS),
    'EVALUATE_EXIT_BASIS still documents a behaviour the code does not have',
  );

  check(
    'I29',
    'the-exit-TABLE-row-for-0-says-ONLY-FULL_GATE-is-GATE_PASS-and-still-names-both-scopes',
    // The table is one constant, `--help` prints it, and E26-06 checks it against OBSERVED behaviour. A row that
    // says "FULL_GATE or SUBSET_GATE" and nothing more is how the false pass survived the documentation review.
    s2.EVALUATE_EXIT_TABLE.some(
      ([code, meaning, scope]) =>
        code === '0' && /FULL_GATE/.test(scope) && /SUBSET_GATE/.test(scope) && /GATE_PASS/.test(scope) && /NOT_A_GATE_PASS/.test(scope),
    ) &&
      // No row anywhere pairs exit 0 with a claim that a non-FULL_GATE scope is a gate pass.
      !s2.EVALUATE_EXIT_TABLE.some(
        ([code, , scope]) => code === '0' && /SUBSET_GATE/.test(scope) && /→ GATE_PASS|is GATE_PASS\b/.test(scope),
      ) &&
      // The `3` row still says no step ran, which is what makes `gate_exit_code: null` correct.
      s2.EVALUATE_EXIT_TABLE.some(([code, , scope]) => code === '3' && /no step ran/i.test(scope)),
    'the exit table does not carry the GATE_PASS reservation',
  );

  check(
    'I29',
    'the-prior_observations-caveat-is-a-SIBLING-of-the-boolean-and-is-true-at-n-1',
    // The reviewer measured the printed sentence at n=1: "those prior runs agreed with each other". One run cannot
    // agree with anything, and the sentence reads as corroboration. The human line is asserted in E27-07; what
    // belongs here is the FIELD, because the whole complaint is that a consumer reading fields got an unqualified
    // `contradicted: false` with the residual 900 bytes away.
    typeof s2.PRIOR_OBSERVATIONS_CAVEAT === 'string' &&
      s2.PRIOR_OBSERVATIONS_CAVEAT.length > 0 &&
      s2.PRIOR_OBSERVATIONS_CAVEAT.length < 400 &&
      typeof s2.PRIOR_OBSERVATIONS_CAVEAT_CODE === 'string' &&
      /^[a-z_]+$/.test(s2.PRIOR_OBSERVATIONS_CAVEAT_CODE) &&
      /n<2/.test(s2.PRIOR_OBSERVATIONS_CAVEAT) &&
      // It makes no claim, and in particular it is not a test-edit or masking detector: none is built, and saying so
      // is what keeps it from reading as one.
      !/\b(stable|confirmed|reproducible|detected|masked)\b/i.test(s2.PRIOR_OBSERVATIONS_CAVEAT) &&
      /not a test-edit detector/i.test(s2.PRIOR_OBSERVATIONS_CAVEAT) &&
      s2.PRIOR_OBSERVATIONS_CAVEAT_BASIS.length > 200,
    `caveat=${s2.PRIOR_OBSERVATIONS_CAVEAT.length} code=${s2.PRIOR_OBSERVATIONS_CAVEAT_CODE}`,
  );

  check(
    'I29',
    'the-prior_observations-BASIS-still-contains-every-phrase-E26-08-asserts-after-being-tightened',
    // The basis was shortened to pay for the new fields inside E26-04's measured byte budget. Shortening prose is
    // only safe while the phrases a test asserts on survive, so they are asserted HERE as well: a later edit that
    // tightens it again fails in the self-test rather than in the slower compatibility suite.
    !/\d+(\.\d+)?\s?%/.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /\bno exchangeability assumption\b/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /trial-index parity/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /absolute order of gate executions/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /one-shot resource/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /cannot be told from a real difference/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      /resolves nothing in either direction/i.test(s2.PRIOR_OBSERVATIONS_BASIS) &&
      s2.PRIOR_OBSERVATIONS_BASIS.length < 1000,
    `basis=${s2.PRIOR_OBSERVATIONS_BASIS.length}`,
  );

  // ---- I30: F-1 and F-2, the two findings from the final validation of a completed cycle. Both are the same defect class
  // in different clothes — a DOCUMENT that said something the bytes do not do, and a COMMAND that did something the
  // document promised it would not — so the group asserts the claim AND the mechanism from the same constants, and then
  // checks that the four documents and this file cannot drift apart on either.
  const floor = s2.verdictHeadByteFloor();
  const headOrder = s2.VERDICT_HEAD_FIELDS.join(',');
  const refusalFor = (raw) => s2.unknownGateEnvPolicyRefusal(raw);
  const evaluateRefusal = refusalFor('wide-open');
  const otherRefusal = refusalFor('something-else');
  const coerced = [];
  s2.assertGateEnvFlagValue({ 'gate-env': 'wide-open' }, (refusal) => coerced.push(refusal.name));
  s2.assertGateEnvFlagValue({ 'gate-env': 'sanitised' }, (refusal) => coerced.push(`COERCED-VALID:${refusal.name}`));
  s2.assertGateEnvFlagValue({}, (refusal) => coerced.push(`COERCED-ABSENT:${refusal.name}`));
  const schemasDoc = flattenProse(readFileSync(join(REAL_REPO_ROOT, '.harness/docs/schemas.md'), 'utf8'));
  const roomodesDoc = readFileSync(join(REAL_REPO_ROOT, '.roomodes'), 'utf8');

  check(
    'I30',
    'an-unrecognised---gate-env-is-ONE-refusal-payload-for-every-command-and-no-valid-value-is-ever-coerced',
    s2.GATE_ENV_REFUSAL_NAME === 'unknown_gate_env_policy' &&
      s2.CENSUS_REFUSAL_NAMES.includes(s2.GATE_ENV_REFUSAL_NAME) &&
      // The census keeps its own refusal vocabulary, and this name is the one it already published: the same refusal.
      evaluateRefusal.name === otherRefusal.name &&
      // ONE sentence for every value: the refusal differs only where it NAMES what the operator typed, so two commands
      // cannot drift apart on why they refuse. That is the property `E28-02` then checks through two real CLIs.
      otherRefusal.reason === evaluateRefusal.reason.replace('wide-open', 'something-else') &&
      evaluateRefusal.reason.includes('does not fall back to a default') &&
      evaluateRefusal.reason.includes('wide-open') &&
      otherRefusal.reason.includes('something-else') &&
      evaluateRefusal.lines.some((line) => line.includes('policies accepted: sanitised, inherited')) &&
      evaluateRefusal.lines.some((line) => line.includes('default when the flag is absent: sanitised')) &&
      // The reason states the thing a reader would otherwise get wrong about it: the fallback was SAFE, so this was
      // never a false pass. A refusal documented as if it had been a false pass would be its own falsehood.
      /never a false pass/i.test(s2.GATE_ENV_REFUSAL_BASIS) &&
      /attest/i.test(s2.GATE_ENV_REFUSAL_BASIS) &&
      // Only the unrecognised value is refused: neither policy value and not passing the flag at all.
      coerced.length === 1 && coerced[0] === s2.GATE_ENV_REFUSAL_NAME,
    `name=${s2.GATE_ENV_REFUSAL_NAME} observed=${JSON.stringify(coerced)}`,
  );

  check(
    'I30',
    'the-verdict-head-is-an-ORDERED-PREFIX-and-a-seven-key-head-cannot-fit-in-200-bytes-under-ANY-values',
    headOrder ===
      'schema,verdict,scope,run_id,measured_at,judged_commit,declared_source_commit,judged_source_status_hash,commits_since_source' &&
      s2.VERDICT_HEAD_FIELDS.length === 9 &&
      // The floor is COMPUTED here, from the key list, and it is the arithmetic the documents quote. If a key is added,
      // shortened or reordered, every number below moves and this check fails rather than letting the prose go stale.
      floor.keys === 7 &&
      floor.emptyPrefixBytes === 112 &&
      floor.commitValues === 80 &&
      floor.unavoidable === 192 &&
      floor.budgetLeft === 8 &&
      floor.schemaValueBytes === 28 &&
      floor.withSchemaOnly === 218 &&
      floor.overshootWithSchemaOnly === 18 &&
      // The load-bearing claim: the window is exceeded unconditionally, so no assignment of values rescues it.
      floor.overshootWithSchemaOnly > 0 &&
      // 192 is UNDER 200 only because four of the seven values are still empty here; filling in `schema` alone is what
      // puts the head over, and `schema` is the one value that can never be empty. Hence the overshoot assertion above.
      floor.unavoidable < 200 && floor.withSchemaOnly > 200,
    `floor=${JSON.stringify({ ...floor, emptyPrefix: '<prefix>' })}`,
  );

  check(
    'I30',
    'the-documents-state-the-head-as-an-ORDER-rather-than-the-false-200-BYTE-window-and-quote-this-floor',
    // Every document that used to carry the false sentence now carries the corrected one, and none of them still claims
    // that six named fields sit inside the first 200 bytes. This is a documentation assertion about a CLAIM, which is
    // the only kind of thing F-1 was: the code was right, the trade was right, and three published sentences were not.
    // LAYER OWNERSHIP (S1). The POSITIVE claims — the ORDER, the floor, the two numbers — are required of the documents
    // that OWN them: the two full harness documents and, for the ORDER alone, the condensed mode summary. The NEGATIVE
    // scan below is deliberately NOT repointed: the measured-false sentence must never reappear in layer-0 either, and
    // that check holds whatever the agent-facing entry point goes on to carry.
    // The ORDER is the claim, so every document that describes the head states it, including the mode file.
    [readmeDoc, schemasDoc, roomodesDoc].every((doc) => /ordered list of NINE keys|ordered list of nine keys/i.test(doc)) &&
      // The floor is quoted with the function that computes it in the two full harness documents; `.roomodes` is a
      // condensed mode summary and carries the ORDER and the conclusion, not the arithmetic.
      [readmeDoc, schemasDoc].every((doc) => /verdictHeadByteFloor/.test(doc)) &&
      [readmeDoc, schemasDoc].every((doc) => /192/.test(doc) && /218/.test(doc)) &&
      /not a 200-byte window|not one the format can honour|is an ORDER, not a byte window/i.test(roomodesDoc) &&
      // The old claim, in the form it was published. "in the first 200 bytes" as a description of the whole head is
      // gone; the historical narrative about B3/B4 keeps its own, differently-worded sentences.
      ![agentsDoc, readmeDoc, schemasDoc, roomodesDoc].some((doc) =>
        /first 200 bytes (deliberately )?carry/i.test(doc),
      ) &&
      // The pre-B4 five-key claim about BOTH commits inside 200 is the one that is actually false and is corrected.
      !/Both commit names land inside the \*\*first 200 bytes\*\*/.test(schemasDoc),
    'a document still claims the 200-byte window, or lost the corrected sentence',
  );
  check(
    'I30',
    'S1-SITE6-the-verdict-head-ORDER-the-floor-function-and-both-numbers-are-OWNED-by-the-harness-layer',
    // Named replacement for the three `AGENTS.md` conjuncts repointed out of the assertion above. The SAME literals and
    // the SAME positive check, now asked of the documents that own them — each of the two full harness documents for the
    // floor and both numbers, and the mode summary additionally for the ORDER. The agent-facing entry point is no longer
    // required to restate the head, which is what lets that prose move later without reddening this check.
    [readmeDoc, schemasDoc].every(
      (doc) =>
        /ordered list of NINE keys|ordered list of nine keys/i.test(doc) &&
        /verdictHeadByteFloor/.test(doc) &&
        /192/.test(doc) &&
        /218/.test(doc),
    ) &&
      /ordered list of NINE keys|ordered list of nine keys/i.test(roomodesDoc) &&
      // The measured-false window sentence stays absent from layer-0 too, so the repoint is not a licence to restore it.
      !/first 200 bytes (deliberately )?carry/i.test(agentsDoc),
    JSON.stringify({
      readme_order: /ordered list of NINE keys/i.test(readmeDoc),
      readme_floor: /verdictHeadByteFloor/.test(readmeDoc),
      readme_192_218: /192/.test(readmeDoc) && /218/.test(readmeDoc),
      schemas_order: /ordered list of NINE keys/i.test(schemasDoc),
      schemas_floor: /verdictHeadByteFloor/.test(schemasDoc),
      schemas_192_218: /192/.test(schemasDoc) && /218/.test(schemasDoc),
      roomodes_order: /ordered list of NINE keys/i.test(roomodesDoc),
      layer0_false_window: /first 200 bytes (deliberately )?carry/i.test(agentsDoc),
    }),
  );

  check(
    'I30',
    'every-state-home-the-harness-writes-is-gitignored-except-the-one-documented-tasks-exception',
    // F-3: the validator could not confirm the residue was ignored, so the homes are ENUMERATED and asked about
    // mechanically, by `git check-ignore`, rather than by reading the ignore file and believing it. The homes are read
    // out of the runtime's own source, so a home added later is covered without remembering to add it here.
    (() => {
      // The homes are READ OUT OF THE RUNTIME'S OWN SOURCE — both the `const X_DIR = join(STATE_DIR, 'x')`
      // definitions and any direct `join(STATE_DIR, 'x')` call — so a home added later is covered by this check
      // without anybody remembering to add it to a list here. That is the difference between a checked invariant and
      // a comment.
      const source = readFileSync(join(REAL_REPO_ROOT, '.harness/runtime/harness.mjs'), 'utf8');
      const homes = new Set([...source.matchAll(/join\(\s*STATE_DIR,\s*'([^']+)'/g)].map((match) => match[1]));

      if (homes.size === 0) return false;
      // The set must actually be the set: a check that passes on two homes proves nothing about the other seven.
      if (homes.size < 8) return false;

      const documentedException = 'tasks';

      for (const home of homes) {
        const probe = spawnSync('git', ['check-ignore', '-q', `.harness/state/${home}/probe`], { cwd: REAL_REPO_ROOT });

        if (home === documentedException) {
          if (probe.status === 0) return false;
          continue;
        }

        if (probe.status !== 0) return false;
      }

      // And the exception is EXCEPTIONALLY ignored on purpose: task contracts are tracked operator inputs, and the
      // ignore file says so in the same words this check would otherwise be asserting.
      return /task contracts are tracked operator inputs/.test(
        readFileSync(join(REAL_REPO_ROOT, '.gitignore'), 'utf8'),
      );
    })(),
    'a state home is neither ignored nor the documented exception',
  );

  // ---- I31: the LAYER-0 PLACEMENT RATCHET.
  //
  // WHAT THIS IS. `AGENTS.md` and `.roo/rules/01-project-conventions.md` are the LAYER-0 set: the only project prose the
  // agent platform injects into every session, in every mode. A later step relocates the harness measurement prose out of
  // layer-0 into the specialist `.harness/` layer. That deletion must be OBSERVABLE, not silent, so it is ratcheted here.
  //
  // WHY A RATCHET AND NOT A ZERO. Asserting "the harness-token count in layer-0 is 0" would have been red on arrival,
  // because at the time this group landed the prose had not moved yet; a gate that cannot go green on the tree it ships
  // with is not a gate. So each count was asserted `<=` a NAMED BASELINE LITERAL equal to the value measured BEFORE the
  // relocation, and every failure detail carried the MEASURED value beside the baseline, so one failure line was enough
  // to diagnose it. THE RELOCATION STEP (I2b) THEN LOWERED EVERY LITERAL TO THE POST-RELOCATION MEASUREMENT, and every
  // one of them is now ZERO: the measurement vocabulary does not appear in layer-0 at all. A ratchet that only tightens
  // is not a weakened assertion — it is a stronger one, and it is the same shape the documented totals already use.
  //
  // WHAT IT DOES NOT CLAIM. `<=` is a one-sided bound on its own. The floor items — that an ordinary task is still
  // SOLVABLE from layer-0, and that the prose landed somewhere rather than being deleted everywhere — are asserted as
  // facts by the I32 group, not here.
  const LAYER0_FILES = ['AGENTS.md', '.roo/rules/01-project-conventions.md'];
  const layer0Text = (relative) => readFileSync(join(REAL_REPO_ROOT, relative), 'utf8');
  /** Case-sensitive plain substring count, summed across the layer-0 set. */
  const layer0Count = (needle) =>
    LAYER0_FILES.reduce((sum, relative) => sum + layer0Text(relative).split(needle).length - 1, 0);
  /** Per-file breakdown, so a failure names the file that moved rather than only the total. */
  const layer0Breakdown = (needle) =>
    Object.fromEntries(LAYER0_FILES.map((relative) => [relative, layer0Text(relative).split(needle).length - 1]));
  /** Distinct markdown link targets across layer-0, anchors stripped, repo-root-relative. */
  const layer0LinkTargets = () => {
    const targets = new Set();

    for (const relative of LAYER0_FILES) {
      const text = layer0Text(relative);

      for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.add(match[1].split('#')[0]);
      for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) targets.add(match[1].split('#')[0]);
    }

    return [...targets].sort();
  };

  // BASELINE LITERALS, RE-BASELINED BY THE RELOCATION STEP (I2b). Every literal below is now the count MEASURED on the
  // tree the harness prose actually left, so each ceiling sits exactly at today's value and any growth fails again. The
  // pre-relocation literal is recorded beside it, because a ratchet that tightened from 14 to 0 is a different claim from
  // one that was always 0, and a reader has to be able to tell which happened.
  // OLD -> NEW, in the order the tokens are listed: INCONCLUSIVE 14->0, NON-RESOLVING 1->0, execution_order 2->0,
  // verdictHeadByteFloor 1->0, build_state 1->0, installed_state_digest 1->0, installed_tree_fingerprint 1->0,
  // 'workspace prepare' 6->0, '--repeat=' 3->0, '--step=' 4->0, census 8->0, comparison_sourced_runs 1->0,
  // Clopper 1->0, exchangeability 3->0, '81165e6' 1->0, '143 commits' 3->0, '40/40' 2->0,
  // 'skip-suppresses-the-culprit' 1->0, bisect 9->0. EVERY measurement-vocabulary token is now ZERO, which is what lets
  // the I32 group assert the absence as a FACT rather than as a bound.
  const I31_TOKEN_BASELINES = {
    INCONCLUSIVE: 0, // (14) measurement-vocabulary token; all 14 occurrences are in AGENTS.md.
    'NON-RESOLVING': 0,
    execution_order: 0,
    verdictHeadByteFloor: 0,
    build_state: 0,
    installed_state_digest: 0,
    installed_tree_fingerprint: 0,
    'workspace prepare': 0,
    '--repeat=': 0,
    '--step=': 0,
    census: 0,
    comparison_sourced_runs: 0,
    Clopper: 0,
    exchangeability: 0,
    '81165e6': 0,
    '143 commits': 0,
    '40/40': 0,
    'skip-suppresses-the-culprit': 0,
    bisect: 0,
  };
  const I31_BISECT_BASELINE = 0; // The same measurement as the `bisect` token above, asserted separately and by name: the
  // recorded NO-GO is the specialist layer's vocabulary, so its layer-0 floor is now zero rather than a bound.
  const I31_LINK_TARGET_BASELINE = 4; // Distinct layer-0 link targets: 7 -> 4. The four that survive are `docs/architecture.md`,
  // `.harness/README.md`, the specialist capability file, and the performance findings document.
  // WAS A MEASURED FACT, NOT A ZERO; NOW A ZERO. Layer-0 linked into `.harness/docs/` six times before the relocation
  // and links there zero times now, so the bound that used to need a prose explanation carries only the number.
  const I31_HARNESS_DOCS_LINK_BASELINE = 0;
  // RE-BASELINED THREE TIMES. I2a: 52624 -> 52778 bytes and 606 -> 608 lines, for the ONE sentence it was authorised to
  // add to `AGENTS.md` ("a verdict file can be handed to you by a third party, so read `scope` before believing one: a
  // non-`FULL_GATE` result is not whole-project validation"). I2b: 52778 -> 11976 bytes and 608 -> 187 lines, for the
  // relocation of the harness prose out of the always-loaded set. B2: 11976 -> 12359 bytes and 187 -> 188 lines, and the
  // movement is a NET LOSS as well as a gain: the research-corpus router sentence is gone (−184 B) and the agent-scratch
  // rule is in (+467 B). It was written in both always-on files, not only here, because a rule that lives only in
  // `AGENTS.md` is a rule some modes never read — and the failure it prevents is a lint run that stalls, which is
  // exactly the kind an agent that never read the rule is the one to cause. The scratch directory is named in a CODE
  // SPAN rather than as a link, so adding the rule did not add a fifth document to the layer-0 hop set (A4).
  // B9: 12359 -> 12590 bytes and 188 -> 192 lines, for FOUR reviewer-mandated corrections, each of which adds content
  // rather than moving prose around: the tool-surface sentence gets its OWN HEADING (it was filed under
  // `### Agent scratch`, so a reader who came for the scratch rule read a security-boundary claim as part of it, +2
  // lines); the `errorInterceptor`-owns-5xx clause is added to the UI hard rules (+2 lines, and the long form lives in
  // the equally-always-loaded rules file, so the copy here is the short one); the performance-forensics bullet gets its
  // §4.1/§4.2 figures and the "causes not established" verdict back, which a reviewer found had been lost; and
  // `npm run harness -- list` moves below the everyday block it contradicted. None of the four is optional and none is
  // padding, so the baseline moves — the mechanism the paragraph above describes, applied deliberately rather than
  // worked around by deleting a reviewer-requested sentence.
  // Each re-baselining is a TIGHTENING: the ceiling sits exactly at the measured size, so any further growth fails again.
  // The HARD ceiling (14000 bytes / 210 lines) is carried independently by the I32 group's A5 check, so the two bounds
  // fail separately and name different things.
  const I31_AGENTS_BYTES_BASELINE = 12590; // `AGENTS.md` byte size. The hard ceiling is enforced by I32's A5.
  const I31_AGENTS_LINES_BASELINE = 192; // `AGENTS.md` line count (`wc -l` semantics: count of newline characters).

  const i31TokenRows = Object.entries(I31_TOKEN_BASELINES).map(([token, baseline]) => {
    const measured = layer0Count(token);

    return { token, measured, baseline, ok: measured <= baseline, per_file: layer0Breakdown(token) };
  });
  const i31Violations = i31TokenRows.filter((row) => !row.ok);
  check(
    'I31',
    'no-harness-measurement-token-grew-in-the-layer-0-set-and-each-count-prints-its-measured-value-beside-its-baseline',
    i31TokenRows.length > 0 && i31Violations.length === 0,
    `baseline_tightened_by=the-relocation-step; violating=${JSON.stringify(i31Violations)}; all=${JSON.stringify(i31TokenRows)}`,
  );

  const i31BisectMeasured = layer0Count('bisect');
  check(
    'I31',
    'the-git-bisect-NO-GO-vocabulary-in-layer-0-did-not-grow',
    i31BisectMeasured <= I31_BISECT_BASELINE,
    `token=bisect measured=${i31BisectMeasured} baseline=${I31_BISECT_BASELINE} per_file=${JSON.stringify(layer0Breakdown('bisect'))} baseline_tightened_by=the-relocation-step`,
  );

  const i31Links = layer0LinkTargets();
  check(
    'I31',
    'the-layer-0-set-grew-no-new-markdown-link-target',
    i31Links.length <= I31_LINK_TARGET_BASELINE,
    `measured=${i31Links.length} baseline=${I31_LINK_TARGET_BASELINE} measured_set=${JSON.stringify(i31Links)} baseline_tightened_by=the-relocation-step`,
  );

  // Which layer-0 files link into `.harness/docs/`, and how often. The per-file breakdown is kept in the detail so a
  // failure names the file that moved rather than only the total.
  const i31HarnessDocLinks = LAYER0_FILES.map((relative) => ({
    file: relative,
    count: [...layer0Text(relative).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
      .map((match) => match[1].split('#')[0])
      .filter((target) => target.includes('.harness/docs/')).length,
  }));
  const i31HarnessDocTotal = i31HarnessDocLinks.reduce((sum, entry) => sum + entry.count, 0);
  check(
    'I31',
    'the-layer-0-sets-links-into-the-harness-docs-directory-did-not-grow',
    i31HarnessDocTotal <= I31_HARNESS_DOCS_LINK_BASELINE,
    `measured_total=${i31HarnessDocTotal} baseline=${I31_HARNESS_DOCS_LINK_BASELINE} per_file=${JSON.stringify(i31HarnessDocLinks)} was_6_before_the_relocation_and_is_0_now`,
  );

  const i31AgentsBytes = Buffer.byteLength(layer0Text('AGENTS.md'), 'utf8');
  check(
    'I31',
    'AGENTS.md-did-not-grow-in-bytes',
    i31AgentsBytes <= I31_AGENTS_BYTES_BASELINE,
    `measured=${i31AgentsBytes} baseline=${I31_AGENTS_BYTES_BASELINE} was=52778 note=ratchet-tightened-by-the-relocation-step hard_ceiling=14000 is_enforced_by=I32-A5`,
  );

  const i31AgentsLines = (layer0Text('AGENTS.md').match(/\n/g) ?? []).length;
  check(
    'I31',
    'AGENTS.md-did-not-grow-in-lines',
    i31AgentsLines <= I31_AGENTS_LINES_BASELINE,
    `measured=${i31AgentsLines} baseline=${I31_AGENTS_LINES_BASELINE} semantics=wc-l baseline_tightened_by=the-relocation-step`,
  );

  // THE ANTI-OVER-REACH ASSERTION. S1 repointed nine prose-coupling assertion sites off `AGENTS.md`; the digits coupling is
  // Class 1 and is DELIBERATELY still in place, because adding an assertion changes the totals and this is what forces the
  // documented numbers to stay truthful. If the relocation step ever takes the harness prose out of `AGENTS.md` and takes
  // this digits coupling with it, the documented totals stop being checkable and this group says so.
  // FLATTENED, exactly like the Class-1 check it mirrors: the compatibility literal is written across a LINE BREAK in
  // `AGENTS.md` (`**215 compatibility\ncases**`), so a raw-text regex reads a formatter wrap as a missing coupling. This
  // is the same reason `flattenProse` exists, and the same shape of hazard.
  const i31AgentsTotals = flattenProse(readFileSync(join(REAL_REPO_ROOT, 'AGENTS.md'), 'utf8'));
  check(
    'I31',
    'the-Class-1-digits-coupling-is-INTACT-the-decoupling-did-not-over-reach',
    /\*\*(\d+) self-test assertions across (\d+) invariant groups\*\*/.test(i31AgentsTotals) &&
      /\*\*(\d+) compatibility cases\*\*/.test(i31AgentsTotals) &&
      /read the numbers off the run instead of trusting a remembered literal/.test(i31AgentsTotals),
    `self_test_totals=${
      /\*\*(\d+) self-test assertions across (\d+) invariant groups\*\*/.exec(i31AgentsTotals)?.slice(1).join('/') ?? 'ABSENT'
    } compatibility=${/\*\*(\d+) compatibility cases\*\*/.exec(i31AgentsTotals)?.[1] ?? 'ABSENT'} note=Class-1-is-never-relocated`,
  );

  // ---- I32: THE LAYER SEPARATION, asserted as mechanics rather than as a convention.
  //
  // WHAT THIS IS. The harness measurement prose left the always-loaded layer-0 set (`AGENTS.md` +
  // `.roo/rules/01-project-conventions.md`) and went to a specialist capability that loads only for one mode. A
  // convention can be ignored silently and still read as compliance; these checks make both halves of the claim
  // mechanical. Test A: an ordinary feature or bugfix task must be SOLVABLE from layer-0 alone. Test B: an ordinary
  // task must not have to read any harness document. Test C: a historical regression task must NOT be solvable from
  // layer-0, and must reach the specialist capability instead. Test D: once that capability is loaded, everything the
  // task needs is real — a real command, a real flag, a link that resolves. Test E: every link in every shipped
  // document resolves, file-relative first then repo-root, and every line anchor it carries points at a line that
  // exists.
  //
  // WHY C MIRRORS B RATHER THAN REPLACING IT. B1 and C1 assert the SAME absence, and that redundancy is the point:
  // B alone would pass by DELETING the prose everywhere, and C alone would pass by never putting it anywhere. Only
  // the pair forces the prose to LAND in a named place, which is the only version of this change that is worth
  // anything. A deletion-only 'win' fails D and fails C3.
  const SPECIALIST_FILES = [
    '.roo/rules-harness-evaluator/01-harness-capability.md',
  ];

  // A missing directory is a FINDING and not a crash: this is the only place in the group that asks about a directory,
  // and a throw here would abort the whole suite instead of failing one named check.
  const dirExists = (absolute) => {
    try {
      return statSync(absolute).isDirectory();
    } catch {
      return false;
    }
  };
  // The measurement vocabulary, as a NAME list. Deliberately not a regex: these are the tokens whose presence in an
  // always-loaded file is the symptom this change exists to remove, and a substring matcher on a list of one
  // vocabulary would be a weaker test than a substring matcher on a list of many.
  const HARNESS_TOKENS = [
    'INCONCLUSIVE',
    'NON-RESOLVING',
    'execution_order',
    'verdictHeadByteFloor',
    'build_state',
    'installed_state_digest',
    'installed_tree_fingerprint',
    'workspace prepare',
    '--repeat=',
    '--step=',
    'census',
    'comparison_sourced_runs',
    'Clopper',
    'exchangeability',
    '81165e6',
    '143 commits',
    '40/40',
    'skip-suppresses-the-culprit',
    'bisect',
  ];

  /** Markdown link targets in one repository-relative file, anchors stripped, distinct and sorted. */
  const linkTargetsOf = (relative) => {
    const text = layer0Text(relative);
    const targets = new Set();

    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
      targets.add(match[1].split('#')[0]);
    for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm))
      targets.add(match[1].split('#')[0]);

    return [...targets].sort();
  };
  /**
   * FIX B2 — does a markdown link target resolve? BOTH FORMS ARE TRIED, in markdown's order, and either resolving is
   * enough.
   *
   * THE DISAGREEMENT THIS REMOVES. Markdown resolves a link target RELATIVE TO THE FILE THAT CONTAINS IT, not
   * relative to the repository root. The probe resolved `join(REAL_REPO_ROOT, target)` only — repo-root relative. So
   * `D3`/`F3` demanded repo-root form from documents that markdown reads as file-relative, and the only way to make
   * them agree was to write links that are DEAD AS RENDERED: an agent clicking `.harness/README.md` from
   * `.roo/rules-harness-evaluator/01-harness-capability.md` lands on `<repo>/.harness/README.md`, which is not where
   * the file is. The suite was green on links that do not work, and "the check demanded the wrong form" was the
   * reason the documents were left wrong.
   *
   * So the probe now asks the question markdown asks — first `dirname(file)`, then the repo root — and accepts
   * EITHER. The order is markdown's, so the diagnostic reports the form that actually worked.
   *
   * WHAT IS NOT GIVEN UP. A path that resolves under NEITHER base is still a failure, and the detail prints BOTH
   * attempted paths, so a genuinely dead link is still diagnosable from the failure line alone. The companion check
   * is the one that stops this from degenerating into "anything passes": it requires that at least one link in the
   * checked set resolves ONLY through its own directory, which repo-root resolution alone could never satisfy.
   *
   * A DIRECTORY counts as a resolution. `AGENTS.md` links `docs/architecture.md` and `product-analysis/`, and a
   * target that is a directory rather than a file is a working link; a file-only probe would report it as dead.
   *
   * `fromFile` is the repository-relative path of the file CONTAINING the link. It is required rather than optional,
   * because a link resolved without knowing its container is not a link — it is a string.
   */
  const linkResolvesFrom = (fromFile, target) => {
    const attempts = [resolve(REAL_REPO_ROOT, dirname(fromFile), target), resolve(REAL_REPO_ROOT, target)];

    for (const candidate of attempts) {
      try {
        if (existsSync(candidate)) return { resolved: true, via: candidate, form: candidate === attempts[0] ? 'file-relative' : 'repo-root-relative' };
      } catch {
        // A stat that throws is a path that does not resolve; the next base is tried.
      }
    }

    return { resolved: false, via: null, form: 'UNRESOLVED', attempts };
  };
  const repoFileExists = (fromFile, target) => linkResolvesFrom(fromFile, target).resolved;
  // Headings of a repository-relative markdown file, markdown markers stripped, lower-cased. `null` when the file is
  // not readable, which callers must treat as 'cannot resolve' rather than 'no headings'.
  const headingsOf = (relative) => {
    try {
      return readFileSync(join(REAL_REPO_ROOT, relative), 'utf8')
        .split('\n')
        .filter((line) => /^#{1,6}\s/.test(line))
        .map((line) =>
          line
            .replace(/^#{1,6}\s+/, '')
            .replace(/[`*_]/g, '')
            .toLowerCase(),
        );
    } catch {
      return null;
    }
  };
  /**
   * The target a `§` reference on this line points at: the LAST markdown link target on the line, else the last
   * backticked repository path. `last` rather than `first` because a line routinely names the manual and then the
   * file being referenced, and because in a sentence of the form 'in [x](a/b.md) §7 and `c/d.ts`' the anchor belongs
   * to the link. Returns `null` when the line names no file at all.
   */
  const nearestTargetOnLine = (line) => {
    const links = [...line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
      (match) => match[1].split('#')[0],
    );

    if (links.length > 0) return links[links.length - 1];

    const paths = [
      ...line.matchAll(/`([^`\n]*\.(?:md|json|mjs|ts|yml|toml))`/g),
    ].map((match) => match[1]);

    return paths.length > 0 ? paths[paths.length - 1] : null;
  };

  /**
     * Every `§` reference in a file, with the target its line names. THREE accepted forms: `§'anchor'`, `§7` (a
     * numbered heading) and `§Commands` (a named heading). A reference whose line names no file is RECORDED with
     * `target: null` and fails the caller — a `§` nobody can resolve is the stale-pointer class this exists to catch,
     // and silently skipping it would make the check pass on the very thing it is for.
     */
  const sectionRefsOf = (relative) => {
    const refs = [];
    const fileLines = layer0Text(relative).split('\n');

    for (const [index, line] of fileLines.entries()) {
      for (const match of line.matchAll(
        // The number branch, which is a SECTION rather than a plain number for one reason the proof run established:
        // `§2b.3a` must be ONE anchor. Written as a single greedy `\d+(?:\.[0-9a-z]+)*` the engine BACKTRACKS when the
        // trailing lookahead fails, re-matches the shorter `2b`, and the ambiguity conjunct then reports against a
        // number the author never wrote — while `§2a.2b` and `§7.2` are captured correctly by luck of the alternative
        // order. Anchoring each segment (`\d+[a-z]?` | `\d+(?:\.\d+)*`, then `(?:\.(?:\d+[a-z]?))*`) removes the
        // backtracking path, and `(?!\d)` then only ever sees a real continuation.
        //
        // The lookahead is `(?!\d)`, NOT `(?!\w)` and NOT `(?![.\w])`: `(?![.\w])` made a sentence-final `§2b.` match
        // NOTHING at all, so the very reference this check exists to police was invisible and the gate stayed green
        // with D1's bug restored. Punctuation after a number is sentence punctuation, not part of the anchor.
        /§"([^"]+)"|§((?:\d+[a-z]?|\d+(?:\.\d+)*)(?:\.(?:\d+[a-z]?))*)(?!\d)|§([A-Za-z][\w-]*)/g,
      )) {
        const anchor = match[1] ?? match[2] ?? match[3];
        // A TITLE in double quotes immediately after a bare-number reference is the DISAMBIGUATION this change
        // introduces: the convention is `§2b "Repeated evaluation"` rather than `§2b`, and a resolver that could not
        // see the title would report every such reference as ambiguous — declaring the fix itself broken. The title
        // is a QUALIFIER on the reference, never a replacement for the anchor: `§"History workspaces"` still resolves
        // by title alone (that is match[1]), while `§2b "History census artifacts"` resolves by number and is
        // additionally narrowed by the title.
        // The qualifier may WRAP: prettier reflows markdown, so `§2b "Repeated` / `evaluation"` is one qualifier split
        // across two lines. Requiring it on one line made the fix itself fail the gate after a `prettier --write`, which
        // is the formatter being tested rather than the documents — so the continuation line is joined in before the
        // title is read.
        // The join is followed by `flattenProse` because the wrap leaves the title's internal spaces INTACT and adds the
        // line break's indentation to them — `"Repeated     evaluation"` — which matches no heading. The assertion is
        // about the title, not about where the renderer broke the line, and `flattenProse` is the helper that already
        // encodes that distinction for every other documentation check in this suite.
        const after = match[2] ? flattenProse(`${line.slice(match.index + match[0].length)} ${fileLines[index + 1] ?? ''}`) : '';
        const qualifier = match[2] ? /^\s*"([^"]+)"/.exec(after)?.[1] ?? null : null;

        refs.push({ line: index + 1, anchor, qualifier, target: nearestTargetOnLine(line) });
      }
    }

    return refs;
  };
  /**
   * The headings of `target` an anchor matches, with the KIND of match. Numbered anchors match a heading that STARTS
   * with the number; a titled anchor matches a heading that CONTAINS it.
   *
   * Returned as a list rather than a boolean because a bare-number reference to a number that OCCURS TWICE resolves to
   * two different sections depending on which the reader reaches first, and "it resolved to one of them" is exactly
   * the false green this now refuses. `schemas.md` carries three such numbers by deliberate owner decision
   * (`2b`, `2b.6`, `3`) — it is not renumbered, so the fix is on the reference side: name the heading title.
   */
  const anchorMatches = (anchor, target, fromFile = null, qualifier = null) => {
    // A reference inside `.harness/docs/` names its SIBLING with a file-relative path (`ledger.md`), which
    // `headingsOf` — which joins the repository root — would look for at the root and not find. Resolving relative to
    // the file that carries the reference is the same rule the link check already uses, and without it every
    // harness-layer reference reports `no_target`, which is a vacuous pass wearing a failure's clothes.
    const sibling = fromFile?.startsWith('.harness/') && target && !target.includes('/') ? `.harness/docs/${target}` : null;
    // A SELF-REFERENCE (`target === null`, the anchor names a section of the document it sits in) resolves against that
    // document. Passing `null` through to `headingsOf` would report every self-reference as unresolvable.
    const self = target === null && fromFile ? fromFile : null;
    const headings = headingsOf(target) ?? (sibling === null ? headingsOf(self) : headingsOf(sibling));

    if (headings === null) return { state: 'no_target', matches: [] };

    const needle = String(anchor).toLowerCase();
    // A NUMBERED heading number, which in these documents may carry a letter suffix at any level: `2b`, `2a.2b`, `3a`.
    // Recognising only pure digits would classify `2b` as a named heading and exempt it from the uniqueness conjunct
    // entirely — which is exactly the collision the conjunct exists to catch.
    const numeric = /^(?:\d+[a-z]?|\d+(?:\.\d+)*)(?:\.(?:\d+[a-z]?))*$/.test(needle);
    const matches = numeric
      ? headings.filter((heading) => heading.startsWith(needle))
      : headings.filter((heading) => heading.includes(needle));

    if (matches.length === 0) return { state: 'no_match', matches };
    // THE UNIQUENESS CONJUNCT, and the distinction it turns on. A numeric reference is satisfied by PREFIX (`4.1` names
    // `4.1 …`, and would also prefix a hypothetical `4.10 …`), because that is how a dotted numbering scheme reads, and a
    // DESCENDANT is not a collision: `§2b` legitimately names the `2b` section that owns `2b.1` … `2b.9`. What is NOT
    // legitimate is the SAME number token opening MORE THAN ONE heading at the SAME level — the token then names two
    // siblings, and a bare reference to it resolves to whichever the reader reaches first. A token is followed either by
    // the end of the number, or by one of the separators this suite's documents use before a title (`.`, ` `, `—`, `-`).
    // `schemas.md` carries three such sibling collisions by deliberate owner decision (`2b`, `2b.6`, `3`): the first
    // `2b` is "Repeated evaluation" and the second is "History census artifacts", and both `2b.6` headings are different
    // sections. A reference to one of those is therefore reported AMBIGUOUS, and the fix is on the reference side — name
    // the heading title as well as the number.
    //
    // The separator must not itself continue the number, which is what distinguishes a SIBLING from a DESCENDANT: `2b.1`
    // is a child of `2b` (`.` then a digit) and does not make `§2b` ambiguous, while `2b. repeated evaluation` and
    // `2b. history census artifacts` both do (`.` then a space).
    if (numeric) {
      const token = new RegExp(`^${needle.replace(/\./g, '\\.')}(?=$|[\\s.:;,—–-](?![0-9a-z]))`);
      const siblings = matches.filter((heading) => token.test(heading));

      if (siblings.length > 1) {
        // A QUALIFIER picks one of the siblings by its heading title. That is the disambiguation this change requires
        // of every reference to a duplicated number, and it is checked rather than assumed: the qualifier must match
        // exactly one of the colliding headings, so a title that names none of them is still AMBIGUOUS.
        if (qualifier) {
          const disambiguated = siblings.filter((heading) => heading.includes(String(qualifier).toLowerCase()));

          if (disambiguated.length === 1) return { state: 'unique', matches: disambiguated };
        }

        return { state: 'ambiguous', matches: siblings };
      }
    }

    return { state: 'unique', matches };
  };

  /** True when `anchor` names exactly ONE heading of `target`. Ambiguity is a failure, not a resolution. */
  const anchorResolves = (anchor, target, fromFile = null, qualifier = null) =>
    anchorMatches(anchor, target, fromFile, qualifier).state === 'unique';

  // ---- Test A: an ordinary feature task is solvable from the always-loaded set alone.
  const aLinks = LAYER0_FILES.flatMap((file) =>
    linkTargetsOf(file).map((target) => ({ file, target })),
  );
  // FIX B2: resolved the way markdown resolves it, from the file that carries the link. Layer 0 happens to sit at the
  // repository root, so both bases coincide there and this check is unchanged in substance — it is routed through the
  // shared probe so the three link checks cannot drift apart again.
  const aBrokenLinks = aLinks.filter(({ file, target }) => !repoFileExists(file, target));
  check(
    'I32',
    'A1-every-markdown-link-target-in-layer-0-resolves-on-disk-anchors-stripped',
    aBrokenLinks.length === 0,
    `links=${JSON.stringify(aLinks)} unresolvable=${JSON.stringify(aBrokenLinks)} ` +
      'semantics=markdown-relative-to-the-containing-file-DIRNAME-first-then-the-repo-root-either-may-resolve',
  );

  // The tokens an ordinary implementation agent must not have to look up. Each is named in the failure detail WITH
  // the file that is missing it, because 'a token is absent somewhere in a two-file set' is not diagnosable and the
  // point of the list is to be actionable.
  const A2_REQUIRED_TOKENS = [
    'rxResource',
    'ProjectRefStore',
    'Signal Forms',
    'ui-milkdown-editor',
    'Spartan',
    'zValidator',
    'hono/jwt',
    'getErrorMessage',
    'injectToasts',
    'npm run check',
    'settle(',
    'clickUntil',
    '22.1.2',
    'wrangler pages deploy ui/dist/ui/browser',
    'MONGODB_URI',
  ];
  // The requirement is that the always-loaded SET carries each token, not that EVERY file in it does: a token in
  // `AGENTS.md` satisfies it, and demanding it in the short rules copy too was a stricter test than the requirement,
  // which failed on correct content. The detail still names the token and the set, plus which files carry it, so a
  // real absence stays diagnosable from the failure line alone.
  const a2Missing = A2_REQUIRED_TOKENS.filter(
    (token) => !LAYER0_FILES.some((file) => layer0Text(file).includes(token)),
  ).map((token) => ({ token, carried_by: LAYER0_FILES.filter((file) => layer0Text(file).includes(token)) }));
  check(
    'I32',
    'A2-layer-0-alone-carries-every-token-an-ordinary-implementation-agent-needs',
    a2Missing.length === 0,
    a2Missing.length === 0
      ? `tokens=${A2_REQUIRED_TOKENS.length} every_token_present_in_the_layer_0_set=${JSON.stringify(LAYER0_FILES)}`
      : `MISSING=${JSON.stringify(a2Missing)} note=each entry names the token and the set it is absent from requirement=the-token-appears-in-at-least-one-layer-0-file`,
  );

  // ONE hop, and the only harness document reachable from the everyday layer is the operator manual. A layer-0 link
  // into `.harness/docs/` would be a SECOND route to the machinery, which is precisely what Test C forbids.
  const aHarnessLinks = aLinks.filter(({ target }) =>
    target.startsWith('.harness/'),
  );
  const aHarnessDocsLinks = aHarnessLinks.filter(({ target }) =>
    target.startsWith('.harness/docs/'),
  );
  check(
    'I32',
    'A3-layer-0-links-into-no-harness-docs-and-at-most-one-harness-target-which-is-the-operator-manual',
    aHarnessDocsLinks.length === 0 &&
      aHarnessLinks.length <= 1 &&
      aHarnessLinks.every(({ target }) => target === '.harness/README.md'),
    `harness_docs_links=${JSON.stringify(aHarnessDocsLinks)} harness_links=${JSON.stringify(aHarnessLinks)} allowed=<=.harness/README.md only`,
  );

  const aDistinct = [...new Set(aLinks.map(({ target }) => target))].sort();
  check(
    'I32',
    'A4-the-always-loaded-set-opens-at-most-four-distinct-documents',
    aDistinct.length <= 4,
    `measured=${aDistinct.length} ceiling=4 set=${JSON.stringify(aDistinct)} meaning=one-hop-routing-not-a-second-index`,
  );

  const a5Bytes = Buffer.byteLength(layer0Text('AGENTS.md'), 'utf8');
  const a5Lines = (layer0Text('AGENTS.md').match(/\n/g) ?? []).length;
  check(
    'I32',
    'A5-AGENTS.md-is-within-its-byte-and-line-ceiling',
    a5Bytes <= 14000 && a5Lines <= 210,
    `measured_bytes=${a5Bytes} byte_ceiling=14000 measured_lines=${a5Lines} line_ceiling=210 semantics=wc-l`,
  );

  // ---- Test B: an ordinary bugfix does not require reading any harness document.
  const b1Hits = HARNESS_TOKENS.flatMap((token) =>
    LAYER0_FILES.filter((file) => layer0Text(file).includes(token)).map(
      (file) => ({ token, file }),
    ),
  );
  check(
    'I32',
    'B1-no-harness-measurement-token-occurs-anywhere-in-the-always-loaded-set',
    b1Hits.length === 0,
    `tokens=${HARNESS_TOKENS.length} hits=${JSON.stringify(b1Hits)} per_file_totals=${JSON.stringify(
      Object.fromEntries(
        LAYER0_FILES.map((file) => [file, HARNESS_TOKENS.length]),
      ),
    )}`,
  );

  // A COPY-PASTEABLE command line is a `harness <subcommand>` that is followed by a flag. Scoped to inline code spans
  // on purpose: the point is what a reader can lift and run, and matching the same two words in English prose would
  // flag 'the harness layer' and 'Agent-harness gate' — a false positive that trains a reader to ignore the check.
  const b2CodeSpans = (relative) =>
    [...layer0Text(relative).matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1])
      .join('\n');
  const b2Offenders = LAYER0_FILES.flatMap((file) =>
    [
      ...b2CodeSpans(file).matchAll(
        /harness (regress|census|workspace|evaluate)\s+--/g,
      ),
    ].map((match) => ({
      file,
      line: match[0],
    })),
  );
  check(
    'I32',
    'B2-layer-0-contains-no-copy-pasteable-harness-command-line',
    b2Offenders.length === 0,
    `offenders=${JSON.stringify(b2Offenders)} scope=inline-code-spans-only note=prose-mentions-are-not-commands`,
  );

  // Scoped to the `developer` BLOCK, parsed the way `cmdModes()` parses the file — a line scanner over `- slug:`,
  // `customInstructions: |` and the indented body — and not a blind regex over the whole file. A blind regex would
  // read the `harness-evaluator` block's prose as a violation of the `developer` block, which is the relocation
  // working, not failing.
  // A TWO-PASS parse over each COMPLETED block. The first pass records where `customInstructions: |` starts; the
  // second reads its indented body out of the FINISHED block. Scanning the body during the first pass reads an array
  // that holds only the lines seen SO FAR and yields an EMPTY body — a check that can never fail, which is worse than
  // no check at all because it reports compliance. The B3 detail prints the byte count it measured, so an empty body
  // is visible rather than silent.
  // Every metadata field a mode is LOADED with, and therefore every one the B3 scan must read. `roleDefinition`,
  // `whenToUse` and `description` reach the selected mode alongside `customInstructions`, so a token in any of them is
  // as visible to an agent as one in the field that happened to be scanned. Scanning four fields is what makes the B3
  // assertions a statement about the mode as the harness presents it, rather than about one field of it.
  const B3_SCANNED_FIELDS = ['roleDefinition', 'whenToUse', 'description', 'customInstructions'];
  const roomodesBlocks = (() => {
    const blocks = [];
    let current = null;

    for (const raw of layer0Text('.roomodes').split('\n')) {
      const line = raw.replace(/\s+#.*$/, '');

      if (/^\s*-\s+slug:\s*\S+/.test(line)) {
        if (current !== null) blocks.push(current);
        current = { slug: line.split(':')[1].trim(), groups: [], body: [], inGroups: false, at: -1, atFields: {}, inlineFields: {} };
        continue;
      }
      if (current === null) continue;

      current.body.push(line);

      // FIX C3 WIDENED THE CAPTURED FIELDS. `roleDefinition`, `whenToUse`, `description` and `customInstructions` are
      // ALL loaded for the selected mode, so a token in any of them reaches the agent exactly as a token in
      // `customInstructions` does. Recording only the one that happened to be scanned would leave the other three as
      // holes a future edit could carry vocabulary through unseen. A block-scalar field (`name: |`) records its body
      // index; an INLINE scalar (`description: some text`) records the value, because `description` is written inline in
      // `.roomodes` and a parser that read only `|` would measure it as empty.
      //
      // Both of these `continue` for exactly the reason `cmdModes()` does. Without it, the `groups:` key itself falls
      // through to the group scan, does not match a group name, is not blank and is not one of the keys that may legally
      // follow a group list — so it resets `inGroups` and the group's own entries are then never collected. That bug
      // made D6 read an empty group list for a block whose groups are present.
      const blockField = line.match(/^\s*(roleDefinition|whenToUse|description|customInstructions):\s*\|\s*$/);
      if (blockField !== null) {
        if (blockField[1] === 'customInstructions') current.at = current.body.length - 1;
        current.atFields[blockField[1]] = current.body.length - 1;
        continue;
      }
      const inlineField = line.match(/^\s*(roleDefinition|whenToUse|description|customInstructions):\s*(\S.*)$/);
      if (inlineField !== null) {
        current.inlineFields[inlineField[1]] = inlineField[2];
        continue;
      }
      if (/^\s*groups:\s*$/.test(line)) {
        current.inGroups = true;
        continue;
      }

      if (current.inGroups) {
        const group = line.match(/^\s*-\s+([a-z]+)\s*$/);

        if (group !== null) current.groups.push(group[1]);
        else if (line.trim() !== '' && !/^\s*(name|whenToUse|description|customInstructions|source):/.test(line))
          current.inGroups = false;
      }
    }
    if (current !== null) blocks.push(current);

    for (const block of blocks) {
      block.instructions = [];

      if (block.at === -1) continue;

      for (let index = block.at + 1; index < block.body.length; index += 1) {
        const body = block.body[index];

        // A blank line ends the block scalar; a deeper-indented line is part of it. Anything shallower is the next key.
        if (body.trim() === '' || /^\s{6,}\S/.test(body)) {
          block.instructions.push(body);
          continue;
        }
        break;
      }
    }

    // FIX C3: the same forward walk, run once per SCANNED metadata field rather than only for `customInstructions`. A
    // block-scalar field is walked from its recorded index; an inline scalar (`description: text`) is taken as-is,
    // because `description` is written inline in `.roomodes` and a `|`-only reader would measure it as empty.
    for (const block of blocks) {
      block.fieldText = {};

      for (const field of B3_SCANNED_FIELDS) {
        const body = [];
        const at = block.atFields[field];

        if (at === undefined) {
          if (block.inlineFields[field] !== undefined) body.push(block.inlineFields[field]);
        } else {
          for (let index = at + 1; index < block.body.length; index += 1) {
            const body_line = block.body[index];

            if (body_line.trim() === '' || /^\s{6,}\S/.test(body_line)) {
              body.push(body_line);
              continue;
            }
            break;
          }
        }
        block.fieldText[field] = body;
      }
    }

    return blocks;
  })();

  const roomodesBlock = (slug) =>
    roomodesBlocks.find((block) => block.slug === slug);
  // FIX B7 EXTENDED THE SCOPE FROM ONE BLOCK TO ALL SEVEN, and the token list was chosen from a CENSUS of the actual
  // file rather than from what the check happened to look at. FIX C3 THEN WIDENED THE SCOPE FROM ONE FIELD TO FOUR, so
  // the census below is over `roleDefinition`, `whenToUse`, `description` AND `customInstructions` rather than over
  // `customInstructions` alone. The measured census: `harness-evaluator` carries 14 of the 19 tokens (INCONCLUSIVE,
  // NON-RESOLVING, execution_order, verdictHeadByteFloor, build_state, workspace prepare, --repeat=, --step=, census,
  // Clopper, exchangeability, 143 commits, 40/40, bisect) and the other SIX carry NONE in any of the four fields.
  // The count is PRINTED by both assertions below as `exception_carries=`, beside this comment's own number, so the two
  // cannot silently disagree again — the defect this figure had, where the prose said 13 and its own parenthetical
  // listed 14.
  //
  // So the specialist mode is the ONE declared exception, and it is an exception by DESIGN rather than by concession:
  // it is the mode whose entire subject is measurement forensics, and the relocation put that vocabulary there on
  // purpose. Demanding it be clean too would be demanding the relocation be undone. The six ORDINARY modes are the ones
  // an agent is handed for an ordinary task, and none of them may carry the vocabulary.
  //
  // The exception is ASSERTED, not assumed: the specialist block must be PRESENT in the scan and must actually carry
  // tokens. A scan that quietly excluded the block entirely — the way a "no hits" result would be obtained by simply not
  // looking — fails the assertion below, because an excluded block with no tokens is indistinguishable from an
  // included clean one unless the check says the vocabulary is supposed to be there.
  const B3_MEASUREMENT_MODE = 'harness-evaluator';
  const b3BlockText = (slug) => {
    const block = roomodesBlock(slug);

    if (block === undefined) return '';

    return B3_SCANNED_FIELDS.map((field) => (block.fieldText[field] ?? []).join('\n')).join('\n');
  };
  const b3FieldText = (slug, field) => (roomodesBlock(slug)?.fieldText[field] ?? []).join('\n');
  const b3OrdinarySlugs = roomodesBlocks.map((block) => block.slug).filter((slug) => slug !== B3_MEASUREMENT_MODE);
  const b3PerBlock = roomodesBlocks.map((block) => {
    const text = b3BlockText(block.slug);
    const hits = HARNESS_TOKENS.filter((token) => text.includes(token));
    const perField = Object.fromEntries(
      B3_SCANNED_FIELDS.map((field) => [
        field,
        { bytes: Buffer.byteLength(b3FieldText(block.slug, field), 'utf8'), hits: HARNESS_TOKENS.filter((token) => b3FieldText(block.slug, field).includes(token)).length },
      ]),
    );

    return { slug: block.slug, bytes: Buffer.byteLength(text, 'utf8'), hits, perField };
  });
  const b3OrdinaryHits = b3PerBlock.filter((row) => row.slug !== B3_MEASUREMENT_MODE && row.hits.length > 0);
  const b3SpecialistTokens = b3PerBlock.find((row) => row.slug === B3_MEASUREMENT_MODE)?.hits ?? [];
  // `VERDICT:` is deliberately NOT in `HARNESS_TOKENS` and never will be. It appears in the two verifier modes and in
  // the specialist mode, and there it is the mode's own output contract — the single line a verifier must finish with.
  // Adding it would make this check refuse a correct instruction, which is the failure mode a token list earns by
  // being grown without a census. `harness`, `digest` and `security boundary` are likewise absent: the first two are
  // ordinary English in an integrity sentence, and the third is a boundary claim rather than a measurement token.
  check(
    'I32',
    'B3-no-harness-measurement-token-occurs-in-ANY-scanned-field-roleDefinition-whenToUse-description-customInstructions-of-ANY-ORDINARY-mode-block',
    b3OrdinarySlugs.length >= 6 && b3OrdinaryHits.length === 0 && b3SpecialistTokens.length > 0,
    `scanned_fields=${JSON.stringify(B3_SCANNED_FIELDS)} ordinary_blocks=${JSON.stringify(b3OrdinarySlugs)} (${b3OrdinarySlugs.length}) offending=${JSON.stringify(b3OrdinaryHits)} ` +
      `declared_exception=${B3_MEASUREMENT_MODE} carries=${JSON.stringify(b3SpecialistTokens)} ` +
      `per_block=${JSON.stringify(b3PerBlock.map((row) => `${row.slug}:${row.hits.length}`))} ` +
      `per_field_bytes_and_hits=${JSON.stringify(b3PerBlock.map((row) => [row.slug, row.perField]))} ` +
      'note=the-specialist-mode-is-the-one-block-whose-subject-is-measurement-so-its-vocabulary-is-required-not-forbidden',
  );
  // THE COMPENSATING ASSERTION, and what keeps the six above from being satisfied by scanning two blocks. It requires
  // that all SEVEN blocks were read, that the six ordinary ones carry no token, that the specialist one carries a
  // SUBSTANTIAL vocabulary, and that every block body was non-empty when measured — the last because a parse that
  // yielded nothing would report zero hits for every block and look exactly like a clean scan.
  check(
    'I32',
    'B3-the-seven-block-FOUR-FIELD-scan-is-NOT-vacuous-every-block-and-every-scanned-field-was-READ-and-non-empty-and-the-exception-really-carries-vocabulary',
    b3PerBlock.length === 7 &&
      b3PerBlock.every((row) => row.bytes > 0) &&
      b3PerBlock.every((row) => B3_SCANNED_FIELDS.some((field) => row.perField[field].bytes > 0)) &&
      b3SpecialistTokens.length >= 10 &&
      b3PerBlock.filter((row) => row.hits.length > 0).every((row) => row.slug === B3_MEASUREMENT_MODE),
    `blocks_read=${b3PerBlock.length} (expected 7) scanned_fields=${JSON.stringify(B3_SCANNED_FIELDS)} bytes_per_block=${JSON.stringify(Object.fromEntries(b3PerBlock.map((row) => [row.slug, row.bytes])))} ` +
      `blocks_with_tokens=${JSON.stringify(b3PerBlock.filter((row) => row.hits.length > 0).map((row) => row.slug))} ` +
      `exception_carries=${b3SpecialistTokens.length} tokens (floor 10) comment_says=14 ` +
      'note=an-empty-body-parse-reports-zero-hits-for-every-block-and-looks-identical-to-a-clean-scan',
  );
  // The exception cannot be widened to make the scan vacuous, and this is the assertion that says so. Exempting a SECOND
  // mode is only sound if that mode genuinely has no vocabulary to strip; a mode that DOES carry a token cannot be
  // exempted by editing this list, because `b3PerBlock.filter((row) => row.hits.length > 0).every((row) => row.slug
  // === B3_MEASUREMENT_MODE)` above requires that EVERY block carrying a token IS the one declared exception. Adding a
  // second exempt slug without stripping its vocabulary therefore reddens this suite, which is the intended outcome.
  const b3UnexpectedTokenBlocks = b3PerBlock.filter((row) => row.hits.length > 0 && row.slug !== B3_MEASUREMENT_MODE);
  check(
    'I32',
    'B3-the-declared-exception-cannot-be-WIDENED-without-stripping-vocabulary-because-only-the-named-mode-may-carry-a-token',
    b3UnexpectedTokenBlocks.length === 0 && b3SpecialistTokens.length > 0,
    `declared_exception=${B3_MEASUREMENT_MODE} unexpected_token_blocks=${JSON.stringify(b3UnexpectedTokenBlocks.map((row) => [row.slug, row.hits]))} ` +
      `exception_carries=${b3SpecialistTokens.length} ` +
      'note=exempting-a-second-mode-requires-removing-its-vocabulary-first-otherwise-this-assertion-fails',
  );

  const b4Bisect = LAYER0_FILES.filter((file) =>
    layer0Text(file).includes('bisect'),
  );
  check(
    'I32',
    'B4-neither-layer-0-file-contains-the-word-bisect',
    b4Bisect.length === 0,
    `files_containing_bisect=${JSON.stringify(b4Bisect)} reason=the-recorded-NO-GO-belongs-to-the-specialist-layer`,
  );

  // ---- Test C: a historical regression task is NOT solvable from the always-loaded set, and needs the capability.
  check(
    'I32',
    'C1-the-gap-C-asserts-is-real-the-measurement-vocabulary-is-absent-from-layer-0',
    b1Hits.length === 0 && HARNESS_TOKENS.length > 0,
    `absent_from_layer0=${JSON.stringify(HARNESS_TOKENS)} mirror_of=B1 note=C-asserts-the-gap-B-asserts-the-landing-place`,
  );

  const cHarnessPaths = aDistinct.filter((target) =>
    target.startsWith('.harness/'),
  );
  // The name states what the predicate MEASURES, and nothing more. It counts `.harness/`-prefixed link targets in the
  // always-loaded set, and the manual is the only one: layer 0 links this file AND the specialist capability file, so a
  // name claiming "exactly one harness path" of any kind would be false on the documents while true of the predicate. The
  // predicate's strength is unchanged — it still fails on a second `.harness/` route to the machinery.
  check(
    'I32',
    'C2-layer-0-names-exactly-one-dot-harness-path-the-manual-so-there-is-no-second-route-into-the-machinery-itself',
    cHarnessPaths.length === 1,
    `measured=${cHarnessPaths.length} paths=${JSON.stringify(cHarnessPaths)} ` +
      'note=counts-.harness/-prefixed-link-targets-only-the-capability-file-is-linked-but-is-not-a-.harness/-path',
  );

  // FIX B4 EXTENDED THIS SET, and the reason is that the old one did not enforce what its own NAME claimed.
  //
  // The check is called "the specialist capability carries the procedure, the vocabulary and the link", and thirteen of
  // its thirteen required literals were command and flag tokens: `workspace prepare`, `--good=`, `--target=`, and so
  // on. Three were vocabulary. A file could be gutted of every safety claim it makes and this check would stay green,
  // which a reviewer demonstrated by deleting four of the five §2 limitation bullets and watching `C3` and `D5` both
  // pass. A check whose name says "vocabulary" and which asserts mostly command syntax is a check that reads as
  // coverage and measures nothing.
  //
  // So the set now carries what the file actually promises, quoted at the length a sentence is recognisable by rather
  // than by a single word: the contradiction rule AND the no-vote statement as two separate requirements, because
  // "disagreements make it INCONCLUSIVE" without "a vote is never taken" is a weaker rule than the file states, and
  // the second half is the half that is easy to drop. Declared-vs-observed. The environment-reproducibility claim. The
  // tamper-and-replay claim. The same-principal sentence and the worktree sentence. "A claim is not verification" and
  // "not a sandbox". `GATE_PASS` reserved for `FULL_GATE`, and `NOT_A_GATE_PASS`. `UNDEFINED` is not red. `ERROR`
  // versus `INCONCLUSIVE`. A candidate is not the responsible party. A transition is not a cause. The invocation
  // prefix, the five `check` step names, the census bound, and the `git bisect` NO-GO with its falsifier pointer.
  //
  // The five step names are required INDIVIDUALLY on purpose. The file could name four of five and still be wrong in
  // the way that matters — an agent reading it would believe a step runs that does not, and would read its absence as
  // an UNDEFINED rather than as a documentation gap.
  const c3Required = [
    // The procedure: how to invoke, and what to invoke.
    'workspace prepare',
    'evaluate --json',
    '--good=',
    '--target=',
    '--repeat=',
    '--step=',
    'census --from=',
    'contract init',
    'check:harness',
    '.harness/README.md',
    // The invocation prefix. A bare `harness` is not on PATH, and a procedure that omits the prefix is a procedure
    // that cannot be followed by copying it.
    'npm run harness --',
    // The vocabulary, which is what the check was named for.
    'INCONCLUSIVE',
    'NON-RESOLVING',
    'ANY disagreement among the trials makes the side `INCONCLUSIVE`',
    'a vote is never taken',
    '`ERROR` is a statement about the tool; `INCONCLUSIVE` is a statement about the evaluated state',
    '`UNDEFINED` is not red',
    '`GATE_PASS` is reserved for `scope: FULL_GATE`',
    'NOT_A_GATE_PASS',
    'Declared is not observed',
    'A claim is not verification',
    'A candidate is never the responsible party',
    'A transition is not a cause',
    // The safety claims, which are the sentences an ordinary reader never sees and therefore cannot recover.
    'A worktree is not a security boundary',
    'by the same principal that wrote it',
    'Historical reproducibility is not result authenticity',
    'Tamper and replay are detectable, not prevented',
    'not a sandbox',
    // The numbers a procedure is followed literally against.
    'at 299 commits',
    // The five `check` steps, individually.
    '`typecheck:shared+server`',
    '`typecheck:ui`',
    '`test:server`',
    '`test:ui`',
    // The recorded NO-GO and where its falsifier is.
    'git bisect',
    'falsifier',
  ];
  const c3Exists = SPECIALIST_FILES.every((file) => existsSync(join(REAL_REPO_ROOT, file)));
  const c3Text = c3Exists
    ? readFileSync(join(REAL_REPO_ROOT, SPECIALIST_FILES[0]), 'utf8')
    : '';
  const c3Missing = c3Required.filter((required) => !c3Text.includes(required));
  check(
    'I32',
    'C3-the-specialist-capability-carries-the-procedure-the-vocabulary-and-the-link',
    c3Exists && c3Missing.length === 0,
    `exists=${c3Exists} required=${c3Required.length} missing=${JSON.stringify(c3Missing)} file=${SPECIALIST_FILES[0]} ` +
      'note=FIX-B4-the-set-now-carries-the-safety-vocabulary-not-only-command-and-flag-tokens',
  );
  // THE COMPENSATING ASSERTION AGAINST GUTTING, and the reason `D5`'s byte budget alone is not enough. `D5` bounds the
  // file from ABOVE; it says nothing about a floor, so a file reduced to a title and a usage line would sit comfortably
  // inside a 12 000-byte ceiling while carrying neither a limitation section nor a vocabulary section. The required set
  // above resists that, but only as long as the set and the sections agree — so this asserts the SHAPE directly: a
  // limitations section carrying at least three bullets, a vocabulary section carrying at least six, and a byte floor
  // high enough that the two sections cannot both be deleted and the remainder still pass.
  //
  // The counts are the reason this is not a restatement of `C3`. `C3` asks whether specific SENTENCES are present; this
  // asks whether the file is still the document those sentences live in. A file that keeps every required sentence but
  // deletes the sections around them, or that keeps the sections and empties them of the sentences, fails one check or
  // the other — and neither can be satisfied by making the other vacuous.
  const c3SectionBullets = (heading) => {
    const start = c3Text.indexOf(heading);
    if (start < 0) return -1;
    const rest = c3Text.slice(start + heading.length);
    const end = rest.search(/\n## /);
    const body = end === -1 ? rest : rest.slice(0, end);

    return (body.match(/^- \*\*/gm) ?? []).length;
  };
  const c3LimitationBullets = c3SectionBullets('## 2.');
  const c3VocabularyBullets = c3SectionBullets('## 4.');
  const c3Bytes = Buffer.byteLength(c3Text, 'utf8');
  check(
    'I32',
    'C3-the-capability-cannot-be-shrunk-below-a-floor-that-still-carries-a-limitation-AND-a-vocabulary-section',
    c3LimitationBullets >= 3 && c3VocabularyBullets >= 6 && c3Bytes >= 6000,
    `limitation_bullets=${c3LimitationBullets} (floor 3) vocabulary_bullets=${c3VocabularyBullets} (floor 6) ` +
      `bytes=${c3Bytes} (floor 6000, ceiling 13000 is D5) ` +
      'note=D5-bounds-from-above-only-so-a-gutted-file-would-sit-inside-its-ceiling-with-nothing-left-to-justify-it',
  );

  // `.roo/rules/` is the generic directory the platform loads for EVERY mode. `.roo/rules-harness-evaluator/` is a
  // DIFFERENT directory that loads for one mode, so only the generic one is swept — sweeping both would be a check
  // that can never pass.
  const genericRuleFiles = readdirSync(join(REAL_REPO_ROOT, '.roo/rules'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `.roo/rules/${name}`);
  const c4Hits = genericRuleFiles.flatMap((file) =>
    HARNESS_TOKENS.filter((token) =>
      readFileSync(join(REAL_REPO_ROOT, file), 'utf8').includes(token),
    ).map((token) => ({ file, token })),
  );
  check(
    'I32',
    'C4-the-generic-rules-directory-loaded-by-every-mode-carries-no-harness-measurement-token',
    genericRuleFiles.length > 0 && c4Hits.length === 0,
    `files=${JSON.stringify(genericRuleFiles)} hits=${JSON.stringify(c4Hits)} note=.roo/rules-harness-evaluator-is-a-different-directory`,
  );

  // REACHABILITY. 'Not in the always-loaded set' must never mean 'unavailable'. A pure assertion over the runtime
  // SOURCE TEXT — the `case` arms of `main()` and the exit-set constants, read as text. Nothing is executed: a
  // reachability check that had to run the thing it is proving would be circular.
  const c5Arms = ['regress', 'census', 'workspace'].map(
    (command) => `case '${command}':`,
  );
  const c5ExitSets = [
    'REGRESS_EXIT_RULE',
    'REGRESS_EXIT_FIVE_BASIS',
    'CENSUS_EXIT_RULE',
    'CENSUS_EXIT_BASIS',
    'WORKSPACE_EXIT_USAGE',
  ];
  const c5MissingArms = c5Arms.filter((arm) => !runtimeSource.includes(arm));
  const c5MissingExits = c5ExitSets.filter(
    (name) => !runtimeSource.includes(name),
  );
  check(
    'I32',
    'C5-the-measurement-commands-and-their-exit-sets-are-still-published-by-the-runtime',
    c5MissingArms.length === 0 &&
      c5MissingExits.length === 0 &&
      s2.COMMAND_FLAG_ALLOWLIST.regress !== undefined &&
      s2.COMMAND_FLAG_ALLOWLIST.census !== undefined &&
      s2.COMMAND_FLAG_ALLOWLIST.workspace !== undefined,
    `missing_arms=${JSON.stringify(c5MissingArms)} missing_exit_sets=${JSON.stringify(c5MissingExits)} allowlists=${[
      'regress',
      'census',
      'workspace',
    ]
      .filter((command) => s2.COMMAND_FLAG_ALLOWLIST[command] !== undefined)
      .join(',')} method=source-text-only-nothing-executed`,
  );

  // ---- Test D: once the specialist capability is loaded, everything it names is real.
  // The command set is DERIVED from the `case '<name>':` arms of `main()`, so this is a derivation and not a second
  // hand-written list that could drift away from the dispatcher without anything noticing.
  const runtimeMain =
    /function main\(\) \{[\s\S]*?\n\}/.exec(runtimeSource)?.[0] ?? '';
  //
  // THE HELP SHORT-CIRCUIT IS A REAL INVOCATION SURFACE, AND IT IS DERIVED, NOT HARDCODED. `main()` implements
  // `--help`, `-h` and `help <command>` BEFORE the `switch`, so none of the three is a `case` arm and none is in
  // `COMMAND_FLAG_ALLOWLIST` — deliberately, and I33 is the assertion that pins that deliberateness. But D1/F1 derived
  // the command set from the `case` arms alone, so the capability file was forbidden from naming a form that works, and
  // D2/F2 derived the flag set from the allowlist union alone, so `--help` was refused as an unallowlisted flag. Both
  // were FALSE NEGATIVES, and together they made the suite forbid the truth.
  //
  // The two sets are therefore widened from the SAME place the runtime implements them, read out of `main()`'s own text:
  //   - HELP_SHORT_CIRCUIT_COMMANDS: the leading token of each pre-switch `if (command === '<tok>' && rest.length > 0)`
  //     guard — this is where `harness help <command>` is intercepted, and it yields `help`.
  //   - HELP_SHORT_CIRCUIT_FLAGS: each `rest.includes('--<tok>')` / `rest.includes('-<tok>')` test in the same
  //     pre-switch region — this is where `--help` and `-h` are consumed, and it yields the flag names `help` and `h`.
  //
  // THE DERIVATION FAILS IF THE SHORT-CIRCUIT IS REMOVED, which is the property that makes this a derivation rather than
  // a second hand-written list. `HELP_SHORT_CIRCUIT_FOUND` is true only if at least one of those two guard shapes is
  // present; D1, D2, F1 and F2 all require it, so deleting the short-circuit turns those four assertions RED rather than
  // silently reducing them to the narrower switch-only sets. The guard is anchored to the text BEFORE the `switch (`
  // line and to the END of `main()`, so an unrelated `rest.includes(...)` further down the body cannot be mistaken for
  // the help path.
  const mainSwitchIndex = runtimeMain.indexOf('switch (');
  const mainPreSwitch =
    mainSwitchIndex === -1 ? '' : runtimeMain.slice(0, mainSwitchIndex);
  const HELP_SHORT_CIRCUIT_COMMANDS = new Set(
    [...mainPreSwitch.matchAll(/command === '([a-z][a-z-]*)' && rest\.length/g)].map(
      (match) => match[1],
    ),
  );
  const HELP_SHORT_CIRCUIT_FLAGS = new Set(
    [...mainPreSwitch.matchAll(/rest\.includes\('(-{1,2}[a-z][a-z-]*)'\)/g)].map(
      (match) => match[1].replace(/^-+/, ''),
    ),
  );
  const HELP_SHORT_CIRCUIT_FOUND =
    HELP_SHORT_CIRCUIT_COMMANDS.size > 0 || HELP_SHORT_CIRCUIT_FLAGS.size > 0;
  const HARNESS_COMMANDS = new Set([
    ...[...runtimeMain.matchAll(/^\s{4}case '([a-z][a-z-]*)':/gm)].map(
      (match) => match[1],
    ),
    // Invocation forms the runtime implements OUTSIDE the switch, so a capability file that names a working form is not
    // reported as naming a fictitious one.
    ...HELP_SHORT_CIRCUIT_COMMANDS,
  ]);
  const d1Tokens = [...c3Text.matchAll(/harness ([a-z][a-z-]*)/g)].map(
    (match) => match[1],
  );
  const d1Unknown = [
    ...new Set(d1Tokens.filter((token) => !HARNESS_COMMANDS.has(token))),
  ];
  check(
    'I32',
    'D1-every-harness-subcommand-named-in-the-capability-is-a-real-dispatcher-arm-OR-a-derived-help-short-circuit-form',
    HELP_SHORT_CIRCUIT_FOUND && d1Unknown.length === 0,
    `commands_derived_from_main=${JSON.stringify([...HARNESS_COMMANDS].sort())} switch_arms_only=${JSON.stringify([...runtimeMain.matchAll(/^\s{4}case '([a-z][a-z-]*)':/gm)].map((match) => match[1]).sort())} help_short_circuit_commands=${JSON.stringify([...HELP_SHORT_CIRCUIT_COMMANDS].sort())} help_short_circuit_found=${HELP_SHORT_CIRCUIT_FOUND} tokens_in_capability=${JSON.stringify([...new Set(d1Tokens)].sort())} unknown=${JSON.stringify(d1Unknown)} note=the-set-is-the-switch-arms-UNION-the-help-short-circuit-commands-derived-from-main-preSwitch-and-it-goes-RED-if-the-short-circuit-is-deleted`,
  );

  // Flags are attributed PER LINE to a command named on that same line — a sentence, in this file, names two commands
  // and both own their flags. A line carrying a flag and naming NO command is a failure, not a skip: a flag with no
  // owner is exactly the typo class the runtime refuses by name.
  const d2Unknown = [];
  // THE DISJUNCTION, WRITTEN OUT RATHER THAN LEFT IMPLICIT IN A `Set`. A `--flag` token in the capability file is
  // ADMITTED if and only if EITHER
  //   (a) a command named on the same list item allows it in `COMMAND_FLAG_ALLOWLIST`, OR
  //   (b) it is one of the help tokens the pre-switch short-circuit in `main()` consumes (`--help`, `-h`).
  // NOTHING ELSE IS ADMITTED. A token allowed only by an UNRELATED command's allowlist is still refused, because
  // attribution stays per list item; a token in neither arm lands in `d2Unknown` exactly as it did before. I33 is what
  // keeps arm (b) from becoming a hole: `help` is in NO allowlist entry, and every other unknown flag is still refused
  // by name at `UNKNOWN_FLAG_EXIT`.
  const d2Admitted = (flag, allowed) =>
    allowed.has(flag) || HELP_SHORT_CIRCUIT_FLAGS.has(flag);
  // The unit is a LIST ITEM, not a physical line. A formatter wrap moved `--no-gate` and `--repeat=<n>` off the line
  // that names their command, which made two legitimate lines look unattributed; the markdown item is the sentence the
  // requirement means, and it is stable under reformatting in a way a line is not. An item may name TWO commands, and a
  // flag is owned if EITHER of them allows it.
  const d2Units = [];

  for (const line of c3Text.split('\n')) {
    if (line.trim() === '' || /^(?:\s*[-*] |\s*\d+\. )/.test(line) || d2Units.length === 0) d2Units.push(line);
    else d2Units[d2Units.length - 1] += ` ${line.trim()}`;
  }
  d2Units.forEach((unit, index) => {
    const flags = [...new Set([...unit.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]))];

    if (flags.length === 0) return;

    const owners = [
      ...new Set([
        ...[...unit.matchAll(/harness ([a-z][a-z-]*)/g)].map((match) => match[1]),
        ...[...HARNESS_COMMANDS].filter((command) => new RegExp(`\\b${command}\\b`).test(unit)),
      ]),
    ];
    const allowed = new Set(
      owners.flatMap((command) => {
        const entry = s2.COMMAND_FLAG_ALLOWLIST[command];

        return Array.isArray(entry) ? entry : Object.values(entry ?? {}).flat();
      }),
    );

    for (const flag of flags) {
      if (!d2Admitted(flag, allowed))
        d2Unknown.push({
          unit: index + 1,
          flag,
          owners,
          allowed_for_owners: [...allowed],
          admitted_only_by_the_help_short_circuit: HELP_SHORT_CIRCUIT_FLAGS.has(flag),
          text: unit.slice(0, 140),
        });
    }
  });
  check(
    'I32',
    'D2-every-flag-in-the-capability-is-allowlisted-for-a-command-named-on-the-same-line-OR-is-a-derived-help-token',
    HELP_SHORT_CIRCUIT_FOUND && d2Unknown.length === 0,
    `violations=${JSON.stringify(d2Unknown)} note=attributed-per-list-item-because-an-item-can-name-two-commands-and-a-formatter-wrap-must-not-change-ownership`,
  );

  // FIX B2: the specialist set is checked for the same reason, and with the same probe as layer 0 — a file that is
  // right can still be unchecked, and unchecked is indistinguishable from unchecked-and-wrong until something breaks.
  const D3_LINK_FILES = [...SPECIALIST_FILES];
  const d3Links = D3_LINK_FILES.flatMap((file) => linkTargetsOf(file).map((target) => ({ file, target })));
  const d3Resolved = d3Links.map((link) => ({ ...link, ...linkResolvesFrom(link.file, link.target) }));
  const d3Broken = d3Resolved.filter((link) => !link.resolved);
  check(
    'I32',
    'D3-every-markdown-link-in-the-specialist-capability-resolves-on-disk',
    d3Links.length > 0 && d3Broken.length === 0,
    `links=${JSON.stringify(d3Links)} unresolvable=${JSON.stringify(d3Broken.map((link) => ({ file: link.file, target: link.target, tried: link.attempts })))} ` +
      `resolved_via=${JSON.stringify(d3Resolved.map((link) => `${link.file}:${link.target}=${link.form}`))} ` +
      `note=markdown-resolves-a-link-against-the-file-containing-it-so-the-file-relative-form-is-the-one-a-reader-follows`,
  );
  // THE COMPENSATING ASSERTION, and the reason the fallback above cannot degenerate into "anything passes". At least one
  // link in the checked set must resolve ONLY through its own directory — a target that is not also a valid repo-root
  // path. Repo-root-only resolution can never satisfy that, so a probe that had quietly degraded back to one base
  // would fail here rather than keep reporting every link green.
  const d3FileRelativeOnly = d3Resolved.filter(
    (link) => link.resolved && link.form === 'file-relative' && !existsSync(join(REAL_REPO_ROOT, link.target)),
  );
  check(
    'I32',
    'D3-the-both-ways-fallback-cannot-degenerate-at-least-one-link-resolves-ONLY-from-its-own-directory',
    d3FileRelativeOnly.length > 0,
    `file_relative_only=${JSON.stringify(d3FileRelativeOnly.map((link) => `${link.file}:${link.target}`))} ` +
      `all_forms=${JSON.stringify(d3Resolved.map((link) => `${link.file}:${link.target}=${link.form}`))} ` +
      'note=if-this-is-empty-the-probe-is-only-testing-the-repo-root-base-again-and-the-both-ways-rule-is-not-tested',
  );

  const d4Refs = SPECIALIST_FILES.flatMap((file) =>
    sectionRefsOf(file).map((ref) => ({ file, ...ref })),
  );
  const d4Unresolved = d4Refs.filter(
    (ref) => ref.target === null || !anchorResolves(ref.anchor, ref.target, ref.file, ref.qualifier),
  );
  check(
    'I32',
    'D4-every-section-reference-in-the-specialist-capability-matches-a-heading-in-its-target-file',
    d4Refs.length > 0 && d4Unresolved.length === 0,
    `refs=${JSON.stringify(d4Refs)} unresolved=${JSON.stringify(d4Unresolved)} note=a-ref-with-no-file-on-its-line-fails`,
  );

  const d5Bytes = Buffer.byteLength(c3Text, 'utf8');
  check(
    'I32',
    // What the ceiling protects is that the capability file stays a PROCEDURE and not an essay: it may carry the
    // safety claims an ordinary reader never sees, and it may not grow into a second copy of the runtime manual.
    //
    // Ceiling history: 8000 -> 12000 (workspace-safety record, vocabulary, assumptions, exit tables) -> 13000 (the
    // file sat at exactly 12000, so naming the archived record had no headroom) -> 12000 (B3). B3 removed the
    // vendor-implementation paragraph the 13000 headroom had been spent on, so the ceiling is re-tightened to 12000
    // — a thin headroom rather than the 16 % the old literal allowed. The EXACT measured size is not restated here
    // on purpose: the failure detail already prints `measured_bytes` on every run, so a figure in this comment could
    // only ever rot. The floor is unchanged and still guards the opposite failure, a stub that carries no
    // procedure at all.
    'D5-the-specialist-capability-is-within-its-byte-budget',
    d5Bytes >= 3000 && d5Bytes <= 12000,
    `measured_bytes=${d5Bytes} floor=3000 ceiling=12000 note=a-stub-cannot-carry-the-procedure-an-essay-fails-the-budget ` +
      'ceiling_history=8000->12000(workspace-safety-record,vocabulary,assumptions,exit-tables)->13000(the-file-sat-at-exactly-12000-so-naming-the-archived-record-had-no-headroom)->12000(B3-removed-the-vendor-implementation-paragraph)',
  );

  const d6Block = roomodesBlock('harness-evaluator');
  const d6Directory = dirExists(
    join(REAL_REPO_ROOT, '.roo/rules-harness-evaluator'),
  );
  check(
    'I32',
    'D6-the-capability-is-reachable-through-a-mode-with-read-and-command-and-no-mcp-group',
    d6Block !== undefined &&
      d6Block.groups.includes('read') &&
      d6Block.groups.includes('command') &&
      !d6Block.groups.includes('mcp') &&
      d6Directory,
    `block_found=${d6Block !== undefined} groups=${JSON.stringify(d6Block?.groups ?? [])} directory_exists=${d6Directory} note=a-narrower-tool-surface-is-not-a-security-boundary`,
  );
  // FIX B6: D6 CHECKED THE DOOR BUT NOT THE SIGN. It asserted that the mode exists, has the right groups, and that the
  // directory is on disk — and NOT that the mode's instructions tell an agent to read the capability file. Those are
  // different properties, and a reviewer demonstrated the gap by deleting the one routing sentence: `.roomodes` was then
  // left with no occurrence of `rules-harness-evaluator` anywhere, the directory still existed, the groups were still
  // right, and every assertion stayed green. A mode with the right tool groups and no instruction to read the procedure
  // is a mode that grants access to a file nobody opens.
  //
  // The path is required IN THE BLOCK, not merely in the file: a routing sentence in a different mode's instructions
  // would not be read by the agent this mode exists for.
  const d6Routing = (d6Block?.instructions ?? []).join('\n');
  const d6RoutingRole = d6Block?.roleDefinition ?? '';
  const D6_CAPABILITY_PATH = '.roo/rules-harness-evaluator/01-harness-capability.md';
  check(
    'I32',
    'D6-the-harness-evaluator-mode-block-itself-NAMES-the-capability-file-so-the-procedure-is-actually-routed-to',
    d6Block !== undefined && (d6Routing.includes(D6_CAPABILITY_PATH) || d6RoutingRole.includes(D6_CAPABILITY_PATH)),
    `block_found=${d6Block !== undefined} ` +
      `names_capability_in_instructions=${d6Routing.includes(D6_CAPABILITY_PATH)} ` +
      `names_capability_in_roleDefinition=${d6RoutingRole.includes(D6_CAPABILITY_PATH)} ` +
      'note=the-groups-and-the-directory-are-the-door-the-routing-sentence-is-the-sign-and-D6-only-checked-the-door',
  );
  // THE COMPENSATING ASSERTION, and the general form of the same hole. A routing instruction naming a `.roo/` rules path
  // is a CLAIM that the file is there, and nothing checked it: a typo, a rename or a moved file would leave an ordinary
  // agent following an instruction to a path that does not exist. This asserts the claim for EVERY mode, over EVERY
  // `.roo/` path any block names — not only the harness-evaluator one, because the same mistake is available to any
  // future mode and a check scoped to the single known instance is a check that has to be widened again for the next one.
  const d6AllRulesPaths = roomodesBlocks.flatMap((block) =>
    [
      ...`${block.roleDefinition ?? ''}\n${(block.instructions ?? []).join('\n')}`.matchAll(
        /\.roo\/rules[A-Za-z0-9-]*\/[A-Za-z0-9._-]+\.md/g,
      ),
    ].map((match) => ({ slug: block.slug, path: match[0] })),
  );
  const d6DeadRulesPaths = d6AllRulesPaths.filter((entry) => !existsSync(join(REAL_REPO_ROOT, entry.path)));
  check(
    'I32',
    'every--roo-rules-path-named-by-ANY-mode-block-exists-on-disk',
    d6AllRulesPaths.length > 0 && d6DeadRulesPaths.length === 0,
    `named=${JSON.stringify(d6AllRulesPaths)} (${d6AllRulesPaths.length}) dead=${JSON.stringify(d6DeadRulesPaths)} ` +
      'note=a-routing-instruction-naming-a-path-is-a-claim-the-file-is-there-and-a-typo-would-send-an-agent-nowhere',
  );

  // ---- Test E: EVERY MARKDOWN LINK IN EVERY SHIPPED DOCUMENT RESOLVES, AND EVERY LINE ANCHOR IT CARRIES POINTS AT A
  // LINE THAT EXISTS. This assertion REPLACES the four research-corpus link assertions it descends from (E2, E7, E7b,
  // E7c) and it is a STRICTLY LARGER SCOPE than the four it replaces: those scanned 18 documents inside one directory
  // that has since been deleted, and they are replaced by the whole shipped document set. The property they asserted was
  // never a property of the corpus — it was a property of DOCUMENTS, and the corpus was merely where documents happened
  // to live. Restating it over the shipped set keeps the property and drops the dead dependency, which is the whole
  // point of this pass: a corpus-only assertion must go WITH the corpus, and its coverage must not go with it.
  //
  // The deleted neighbours, and why each went with the corpus rather than surviving as a general rule:
  //   E1 (the everyday paths never name the corpus) was VACUOUS once the corpus was gone — "does not mention a
  //       directory that does not exist" is true of every file. Its intent survives in the two assertions that carry it
  //       for real: B1, which keeps the measurement vocabulary out of the always-loaded set, and B2, which keeps a
  //       copy-pasteable harness command out of it. A file can therefore still be wrong here; the properties are just no
  //       longer phrased as a mention of one path.
  //   E3 (the index is within its byte ceiling) was a budget for a document that no longer exists.
  //   E4, E4b, E4c (the index's status column) were about a table in that same deleted index, together with the
  //       `E4_STATUS_VOCABULARY` / `e4StatusCell` helpers that parsed it.
  //   E5 (the index links nothing outside the research and archive trees) was a containment rule whose allowed set was
  //       exactly those two trees. The property it protected — a document links only where it is meant to link — is now
  //       carried in full by the generalised link assertion below, over every shipped document instead of one index.
  //   E6 (the router names the index in words) made the router's corpus sentence load-bearing, and that sentence is
  //       gone with the corpus it routed to. An index nothing routes to is a real defect, and it has no subject here.
  const SHIPPED_DOC_FILES = [
  "AGENTS.md",
  ".roo/rules/01-project-conventions.md",
  ".roo/rules-harness-evaluator/01-harness-capability.md",
  ".harness/README.md",
  // Derived with `readdirSync`, never as a literal, so a document added to `.harness/docs/` is covered the day it
  // lands rather than the day somebody remembers to edit this assertion. The rest of the set is a literal because
  // those files are named individually by the router and by the always-loaded rules.
  ...readdirSync(join(REAL_REPO_ROOT, ".harness/docs"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `.harness/docs/${name}`),
  "tools/README.md",
  "docs/architecture.md",
  "README.md",
  "product-analysis/100-performance-optimizations.md",
  ];
  /** Every link in one shipped document, anchors KEPT — the anchor is half of what is being asserted. */
  const eLinksOf = (relative) => {
  const text = layer0Text(relative);
  const found = [];

  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
    found.push({ form: "markdown-link", target: match[1] });
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm))
    found.push({ form: "reference-link", target: match[1] });

  return found;
  };
  /** A target split into a path and a line anchor. `#L123` and `:123` are both accepted. */
  const eSplitTarget = (target) => {
  if (/^(https?:|mailto:)/.test(target) || target.startsWith("#"))
    return { path: "", line: null };
  const [path, hash = ""] = target.split("#");
  const hashLine = /^L(\d+)$/.exec(hash);
  if (hashLine) return { path, line: Number(hashLine[1]) };
  const colon = /^(.*):(\d+)$/.exec(path);
  if (colon) return { path: colon[1], line: Number(colon[2]) };
  return { path, line: null };
  };
  // The same `linkResolvesFrom` the other three link checks use, so all of them resolve the way markdown resolves:
  // file-relative first, then the repository root, either accepted. A DIRECTORY counts as a resolution — a link to a
  // directory is a working link, and a file-only probe would report it as dead.
  const eLinks = SHIPPED_DOC_FILES.flatMap((relative) =>
  eLinksOf(relative).map((link) => ({ file: relative, ...link })),
  );
  const eDead = [];
  const eBadAnchors = [];
  for (const { file, target, form } of eLinks) {
  const { path, line } = eSplitTarget(target);
  if (path === "") continue;
  const hit = linkResolvesFrom(file, path);
  if (!hit.resolved) {
    eDead.push({ file, target, form, attempts: hit.attempts });
    continue;
  }
  if (line === null) continue;
  let total = null;
  try {
    total = readFileSync(hit.via, "utf8").split("\n").length;
  } catch {
    // A directory carries no line numbers: there is no line for the anchor to miss.
    continue;
  }
  if (line > total) eBadAnchors.push({ file, target, line, total });
  }
  // THE NON-VACUITY GUARD, carried over from E7c and now covering the wider set. A scan of documents with no links in
  // them reports "nothing dead" and "nothing out of range" for a reason that has nothing to do with the documents being
  // correct, and the check would go green the moment its subject stopped existing. So the COVERAGE is required, not
  // just the outcome: at least one document, at least one link, and — because the anchor check is the half that a
  // resolution-only scan silently skips — at least one line anchor must have been examined. Without these the assertion
  // could only ever be red by finding a link, never red by failing to look.
  const eAnchorsSeen = eLinks.filter(
  ({ target }) => eSplitTarget(target).line !== null,
  ).length;
  check(
  "I32",
  "E1-every-markdown-link-in-every-file-of-the-enumerated-shipped-document-set-resolves-file-relative-then-repo-root-AND-every-line-anchor-it-carries-points-at-a-line-that-exists",
  SHIPPED_DOC_FILES.length > 0 &&
    eLinks.length > 0 &&
    eAnchorsSeen > 0 &&
    eDead.length === 0 &&
    eBadAnchors.length === 0,
  `documents=${JSON.stringify(SHIPPED_DOC_FILES)} (${SHIPPED_DOC_FILES.length}) links=${eLinks.length} anchors_seen=${eAnchorsSeen} ` +
    `dead=${JSON.stringify(eDead)} out_of_range=${JSON.stringify(eBadAnchors)} ` +
    "note=replaces-the-four-corpus-link-assertions-and-covers-a-larger-set-because-the-property-is-one-of-documents-not-of-a-corpus " +
    "note=harness-docs-derived-from-readdir-not-a-literal " +
    "note=resolution-alone-passes-a-file-that-resolves-with-a-line-anchor-past-EOF-so-the-anchor-is-checked-here-too " +
    "note=documents>0-and-links>0-and-anchors>0-are-required-so-this-cannot-pass-by-scanning-nothing",
  );
  // ---- I31 (FRESHNESS): the three always-loaded / specialist documents must not name anything that has stopped
  // existing. The placement ratchet above says the harness prose LEFT layer-0; these say the things that are still
  // there are TRUE — a renamed gate, a retired flag and a moved file are all the same failure wearing different
  // clothes, and none of them is caught by a count.
  const FRESHNESS_FILES = [...LAYER0_FILES, ...SPECIALIST_FILES];
  const freshText = (relative) => layer0Text(relative);
  /** Inline code spans of a file: what a reader can actually copy. */
  const freshCodeSpans = (relative) =>
    [...freshText(relative).matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1])
      .join('\n');
  const i32RuntimeSource = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
  const i32Main =
    /function main\(\) \{[\s\S]*?\n\}/.exec(i32RuntimeSource)?.[0] ?? '';
  //
  // F1/F2 DERIVE THEIR OWN SETS, INDEPENDENTLY OF D1/D2, and they are widened the same way for the same reason: the
  // help short-circuit in `main()` is a real invocation surface that is neither a `case` arm nor an allowlist entry, so
  // the freshness scan over the three documents refused to name `harness <command> --help` — a form that works. The
  // derivation is repeated here rather than imported from D1/D2, so this block carries no ordering dependency on that
  // one, and it is anchored the same way: the pre-`switch (` text of `main()` and nothing after it. `I32_FRESH_HELP_FOUND`
  // gates F1 and F2 exactly as `HELP_SHORT_CIRCUIT_FOUND` gates D1 and D2, so REMOVING THE SHORT-CIRCUIT turns all four
  // red instead of quietly narrowing them to the switch-only sets.
  const i32MainSwitchIndex = i32Main.indexOf('switch (');
  const i32MainPreSwitch =
    i32MainSwitchIndex === -1 ? '' : i32Main.slice(0, i32MainSwitchIndex);
  const I32_FRESH_HELP_COMMANDS = new Set(
    [
      ...i32MainPreSwitch.matchAll(
        /command === '([a-z][a-z-]*)' && rest\.length/g,
      ),
    ].map((match) => match[1]),
  );
  const I32_FRESH_HELP_FLAGS = new Set(
    [
      ...i32MainPreSwitch.matchAll(
        /rest\.includes\('(-{1,2}[a-z][a-z-]*)'\)/g,
      ),
    ].map((match) => match[1].replace(/^-+/, '')),
  );
  const I32_FRESH_HELP_FOUND =
    I32_FRESH_HELP_COMMANDS.size > 0 || I32_FRESH_HELP_FLAGS.size > 0;
  const i32Commands = new Set([
    ...[...i32Main.matchAll(/^\s{4}case '([a-z][a-z-]*)':/gm)].map(
      (match) => match[1],
    ),
    ...I32_FRESH_HELP_COMMANDS,
  ]);
  const i32FlagUnion = new Set([
    ...Object.values(s2.COMMAND_FLAG_ALLOWLIST).flatMap((entry) =>
      (Array.isArray(entry) ? entry : Object.values(entry ?? {}).flat()).filter(
        (flag) => typeof flag === 'string',
      ),
    ),
    // The same disjunction as D2, arm (b): the allowlist union, OR a token the pre-switch help short-circuit consumes.
    ...I32_FRESH_HELP_FLAGS,
  ]);

  const f1Tokens = FRESHNESS_FILES.flatMap((file) => [
    ...[
      ...freshCodeSpans(file).matchAll(
        /(?:^|[^A-Za-z0-9_-])harness ([a-z][a-z-]*)/g,
      ),
    ].map((match) => ({
      file,
      token: match[1],
    })),
    ...[...freshText(file).matchAll(/npm run harness -- ([a-z][a-z-]*)/g)].map(
      (match) => ({
        file,
        token: match[1],
      }),
    ),
  ]);
  const f1Unknown = f1Tokens.filter(({ token }) => !i32Commands.has(token));
  check(
    'I31',
    'F1-every-harness-subcommand-named-in-the-three-documents-is-a-real-dispatcher-arm-OR-a-derived-help-short-circuit-form',
    I32_FRESH_HELP_FOUND && f1Unknown.length === 0,
    `derived_set=${JSON.stringify([...i32Commands].sort())} help_short_circuit_commands=${JSON.stringify([...I32_FRESH_HELP_COMMANDS].sort())} help_short_circuit_found=${I32_FRESH_HELP_FOUND} violating=${JSON.stringify(f1Unknown)} tokens=${JSON.stringify(f1Tokens)} note=scoped-to-code-spans-so-prose-is-not-read-as-a-command`,
  );

  const f2Flags = FRESHNESS_FILES.flatMap((file) => [
    ...[
      ...new Set(
        [...freshText(file).matchAll(/--([a-z][a-z-]*)/g)].map(
          (match) => match[1],
        ),
      ),
    ].map((flag) => ({
      file,
      flag,
    })),
  ]);
  // The same disjunction, stated here too: ADMITTED iff it is in the allowlist union, OR it is one of the derived help
  // tokens. Nothing else. `help` is in no allowlist entry — I33 asserts that, and E29-06 asserts the refusal at exit 2
  // survives — so this widening cannot admit a misspelling of any other flag.
  const f2Unknown = f2Flags.filter(
    ({ flag }) => !i32FlagUnion.has(flag),
  );
  check(
    'I31',
    'F2-every-flag-named-in-the-three-documents-is-in-the-union-of-the-command-flag-allowlists-OR-is-a-derived-help-token',
    I32_FRESH_HELP_FOUND && f2Unknown.length === 0,
    `union_size=${i32FlagUnion.size} help_tokens=${JSON.stringify([...I32_FRESH_HELP_FLAGS].sort())} help_short_circuit_found=${I32_FRESH_HELP_FOUND} violating=${JSON.stringify(f2Unknown)} note=union-only-attribution-is-per-line-in-D2`,
  );

  // ---- F6a: A DOCUMENTED EXIT CODE MUST BE A REAL ONE. The defect this closes is concrete: a shipped document stated a
  // `report` exit code `1` that the runtime has never had — `cmdReport` has exactly one `return 0` plus its refusal
  // path — and every existing check stayed green, because nothing asked the runtime what codes exist. The allowed set
  // is therefore DERIVED from the runtime's own constants (`EVALUATE_EXIT_TABLE`, the `REGRESS_EXIT_*` / `CENSUS_EXIT_*`
  // / `WORKSPACE_EXIT_*` families and `UNKNOWN_FLAG_EXIT`), never from a hand-written list here: a hand-written list is
  // the same class of claim as the document it is meant to check, and would drift in the same direction.
  //
  // PER-COMMAND ATTRIBUTION, THEN THE UNION. A line that names a command is held to THAT command's set; a line that
  // names none is held to the union, because an exit claim with no command on it is a claim about the harness. This is
  // what makes the check specific rather than merely true: `5` is in the union (it is a real `workspace` and `census`
  // code) but NOT in `evaluate`'s, so a document that gave `evaluate` an exit `5` fails here and would not fail a
  // union-only scan.
  //
  // THE NEGATION GUARD, AND WHY IT IS A NARROWING RATHER THAN A CONVENIENCE. Two published forms state a NON-membership
  // rather than a membership, and reading them as memberships inverts them: "There is no exit `1`" (correct — `report`
  // has no `1`) and "neither ever emits `3`" (correct — `regress` and `census` publish no `3`). A mention of a code
  // inside the scope of `no` / `not` / `never` / `neither` / `non` asserts that the code is NOT in the command's set, so
  // membership is the wrong question for it and the mention is skipped rather than counted either way. Skipping is a
  // real loss of coverage and is recorded here deliberately: the alternative was an assertion that fires on the
  // capability file's own correct sentences, and an assertion that fires on correct text gets deleted rather than fixed.
  // The guard is applied to the text BETWEEN the word `exit` and the digit, so it is not a whole-line veto.
  const F6A_FILES = [...SPECIALIST_FILES, '.roomodes', 'AGENTS.md'];
  const f6aConstantFamilies = (prefix) =>
    new Set(
      [
        ...i32RuntimeSource.matchAll(
          new RegExp(`^const ${prefix}[A-Z_]* = (-?\\d+);`, 'gm'),
        ),
      ].map((match) => Number(match[1])),
    );
  // `EVALUATE_EXIT_TABLE` is an array of `[code, meaning, scope]` rows, and the codes are written at two different
  // indents, so the array literal is sliced and every leading code in it is read rather than a `^const` pattern.
  const f6aTableStart = i32RuntimeSource.indexOf('const EVALUATE_EXIT_TABLE = [');
  const f6aTableEnd = i32RuntimeSource.indexOf('\n];', f6aTableStart);
  const f6aEvaluate = new Set(
    [
      ...i32RuntimeSource
        .slice(f6aTableStart, f6aTableEnd)
        .matchAll(/\[\s*'(\d+)',/g),
    ].map((match) => Number(match[1])),
  );
  const f6aUnknownFlag = Number(
    /^const UNKNOWN_FLAG_EXIT = (\d+);/m.exec(i32RuntimeSource)?.[1],
  );
  const f6aPerCommand = {
    evaluate: f6aEvaluate,
    regress: f6aConstantFamilies('REGRESS_EXIT_'),
    census: f6aConstantFamilies('CENSUS_EXIT_'),
    workspace: f6aConstantFamilies('WORKSPACE_EXIT_'),
  };
  const f6aUnion = new Set([
    ...f6aEvaluate,
    ...f6aPerCommand.regress,
    ...f6aPerCommand.census,
    ...f6aPerCommand.workspace,
    f6aUnknownFlag,
  ]);
  const f6aCommands = [
    ...new Set([
      ...i32Commands,
      'report',
      'contract',
      'validate',
      'ledger',
    ]),
  ];
  // THE CLAUSE, THEN EVERY CODE IN IT — NOT THE FIRST CODE AFTER THE WORD. This was the first form written, and a
  // phantom-code proof run caught it failing open: a regex that consumed the word `exit` and the NEXT digit could not
  // see a third, fourth or phantom code in a published list, so a document could carry any number of invented codes
  // behind one real one. An exit table is a LIST, and a check that reads one entry of it is not reading the table.
  // So the word opens a clause, the clause ends at a sentence boundary, and every standalone digit in it is a claim.
  // `gate_exit_code: null` has no digit and cannot match, so a null-valued field is never read as a code.
  const F6A_CLAUSE = /(?:exit(?:s|ed)?|Exits?)\b([^.\n]{0,90})/gi;
  const F6A_DIGIT = /`(\d)`|(?<![\w.])(\d)(?![\w.])/g;
  const F6A_NEGATION = /\b(?:no|not|never|neither|non)\b/i;
  const f6aViolations = [];
  const f6aSkipped = [];
  for (const file of F6A_FILES) {
    for (const [index, line] of layer0Text(file).split('\n').entries()) {
      const named = f6aCommands.find((command) =>
        new RegExp(`\\b${command}\\b`).test(line),
      );
      const allowed = named !== undefined ? f6aPerCommand[named] ?? f6aUnion : f6aUnion;

      for (const clause of line.matchAll(F6A_CLAUSE)) {
        const scope = clause[1];

        if (F6A_NEGATION.test(scope)) {
          f6aSkipped.push({ file, line: index + 1, scope: scope.trim().slice(0, 80) });
          continue;
        }

        for (const digit of scope.matchAll(F6A_DIGIT)) {
          const code = Number(digit[1] ?? digit[2]);

          if (!allowed.has(code)) {
            f6aViolations.push({ file, line: index + 1, code, command: named ?? null, allowed: [...allowed].sort((a, b) => a - b) });
          }
        }
      }
    }
  }
  check(
    'I31',
    'F6a-every-exit-code-a-shipped-document-states-is-a-member-of-the-runtime-constant-set-for-that-command',
    f6aTableStart !== -1 &&
      f6aViolations.length === 0 &&
      f6aUnion.size > 0 &&
      f6aPerCommand.regress.size >= 4,
    `derived_union=${JSON.stringify([...f6aUnion].sort((a, b) => a - b))} per_command=${JSON.stringify(Object.fromEntries(Object.entries(f6aPerCommand).map(([name, set]) => [name, [...set].sort((a, b) => a - b)])))} unknown_flag_exit=${f6aUnknownFlag} scanned=${JSON.stringify(F6A_FILES)} violating=${JSON.stringify(f6aViolations)} negated_clauses_not_claimed=${JSON.stringify(f6aSkipped)} note=derived-from-the-runtime-not-hand-written-a-line-naming-a-command-is-held-to-that-command-set-and-every-code-in-an-exit-clause-is-read-not-just-the-first`,
  );

  // ---- F6b: A DOCUMENTED MODE SLUG MUST EXIST. The mirror image of `D6`, which checks the other direction: `D6` asks
  // whether the mode that routes to the capability file is well formed, and nothing asked whether a slug a document
  // NAMES is a mode at all. `AGENTS.md` names `harness-evaluator`; if that slug were renamed, the router would keep
  // reading as correct while pointing at nothing.
  //
  // THE SLUG SET IS READ FROM `.roomodes`, not from a literal, so a rename in the file is followed automatically and a
  // literal here could only ever be wrong in one direction.
  //
  // TWO NARROWINGS, BOTH FOR FALSE POSITIVES THE SCAN PRODUCED, BOTH RECORDED RATHER THAN DISMISSED. A slug-shaped
  // token (`<word>-<word>`) inside a backticked span is also how this corpus writes a COMMAND (`self-test`) and a
  // third-party flag (`working-directory`, `vite-utils`), so two forms are excluded: a token that is a real dispatcher
  // arm, and a token on a line that says nothing about modes. Neither exclusion can hide a bad slug claim, because a
  // document that claims `foo-bar` IS the `harness-evaluator` mode says `mode` on that line.
  const f6bSlugs = new Set(
    [
      ...layer0Text('.roomodes').matchAll(/^\s*- slug: ([a-z0-9-]+)$/gm),
    ].map((match) => match[1]),
  );
  const F6B_FILES = [...F6A_FILES, '.harness/README.md'];
  const f6bUnknown = [];
  const f6bChecked = [];
  for (const file of F6B_FILES) {
    for (const line of layer0Text(file).split('\n')) {
      const namesAMode = /\bmode\b/i.test(line) || /rules-[a-z0-9-]+/.test(line);

      for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        const token = span[1];

        if (!/^[a-z]+-[a-z]+$/.test(token)) continue;
        if (i32Commands.has(token)) continue;
        if (!namesAMode) continue;

        if (!f6bSlugs.has(token)) f6bUnknown.push({ file, token });
        else f6bChecked.push(`${file}:${token}`);
      }
    }
  }
  check(
    'I31',
    'F6b-every-mode-slug-named-in-a-shipped-document-exists-as-a--slug-entry-in-.roomodes',
    f6bSlugs.size > 0 && f6bUnknown.length === 0 && f6bChecked.length > 0,
    `derived_slugs=${JSON.stringify([...f6bSlugs].sort())} scanned=${JSON.stringify(F6B_FILES)} confirmed=${JSON.stringify(f6bChecked)} unknown=${JSON.stringify(f6bUnknown)} note=slug-shaped-tokens-that-are-a-dispatcher-arm-or-are-on-a-line-about-something-else-are-excluded-because-self-test-and-working-directory-are-not-mode-claims`,
  );

  // FIX B2: same both-ways resolution as `D3`, over a wider set — the pair is the coverage, and leaving one document out
  // of one of them would leave exactly the gap this pass closed.
  //
  // A10a: the two NORMATIVE harness documents are in this set as well. `.harness/README.md` and
  // `.harness/docs/schemas.md` are what a specialist reaches in one hop from here, so a dead link in either is
  // exactly the failure this probe exists to catch — and four of them sat there uncaught for the whole life of the
  // check, because the set was "the always-loaded files, the specialist file and the index" and never "the
  // documents the index and the specialist point at". The set is named by its contents rather than counted, so it
  // cannot go stale silently again.
  const NORMATIVE_HARNESS_DOCS = ['.harness/README.md', '.harness/docs/schemas.md'];
  const F3_LINK_FILES = [...FRESHNESS_FILES, ...NORMATIVE_HARNESS_DOCS];
  const f3Links = F3_LINK_FILES.flatMap((file) => linkTargetsOf(file).map((target) => ({ file, target })));
  const f3Resolved = f3Links.map((link) => ({ ...link, ...linkResolvesFrom(link.file, link.target) }));
  const f3Broken = f3Resolved.filter((link) => !link.resolved);
  const f3Norms = f3Links.filter((link) => NORMATIVE_HARNESS_DOCS.includes(link.file));
  check(
    'I31',
    'F3-every-markdown-link-in-the-always-loaded-specialist-research-and-normative-documents-resolves-on-disk',
    f3Links.length > 0 && f3Broken.length === 0,
    `links=${JSON.stringify(f3Links)} unresolvable=${JSON.stringify(f3Broken.map((link) => ({ file: link.file, target: link.target, tried: link.attempts })))} ` +
      `resolved_via=${JSON.stringify(f3Resolved.map((link) => `${link.file}:${link.target}=${link.form}`))} ` +
      `normative_docs_scanned=${JSON.stringify(NORMATIVE_HARNESS_DOCS)} normative_links=${JSON.stringify(f3Norms.map((link) => `${link.file}:${link.target}`))}`,
  );
  // The widening above is only real if the two new documents actually contribute links. A set that silently failed
  // to read either file would leave the probe green and narrow — exactly the condition this assertion was added to
  // close — so it is asserted directly: both normative documents are in the scanned set AND each contributes at
  // least one link. Without this, `NORMATIVE_HARNESS_DOCS` could be wrong, misspelled, or unreadable and `F3` would
  // still pass.
  check(
    'I31',
    'F3-the-two-normative-harness-documents-are-actually-scanned-AND-each-contributes-at-least-one-link',
    NORMATIVE_HARNESS_DOCS.every((file) => F3_LINK_FILES.includes(file)) &&
      NORMATIVE_HARNESS_DOCS.every((file) => f3Links.some((link) => link.file === file)),
    `scanned_files=${JSON.stringify(F3_LINK_FILES)} ` +
      `links_per_normative_doc=${JSON.stringify(
        NORMATIVE_HARNESS_DOCS.map((file) => ({ file, links: f3Links.filter((link) => link.file === file).length })),
      )} ` +
      'note=this-is-the-compensating-assertion-against-the-widening-silently-narrowing-back-because-a-path-was-misspelled',
  );

  // F4 catches a RENAMED GATE, which is the failure this whole layer would otherwise hide: a document that says
  // `npm run checkg` is still as plausible to a reader as one that says `npm run check`. A workspace-scoped command
  // resolves against that workspace's manifest, because `npm run dev --workspace=server` is a real invocation and
  // checking it against the root manifest would be a false positive, not a finding.
  const rootScripts =
    JSON.parse(readFileSync(join(REAL_REPO_ROOT, 'package.json'), 'utf8'))
      .scripts ?? {};
  const f4Invocations = FRESHNESS_FILES.slice(0, LAYER0_FILES.length).flatMap(
    (file) =>
      [
        ...freshText(file).matchAll(
          /npm (?:run |start\s+)([a-z][a-z0-9:]*)([^\n]*)/g,
        ),
      ].map((match) => ({
        file,
        script: match[1],
        workspace: /--workspace=([a-z0-9-]+)/.exec(match[2] ?? '')?.[1],
      })),
  );
  const f4Unknown = f4Invocations.filter(({ script, workspace }) => {
    if (workspace !== undefined) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(REAL_REPO_ROOT, workspace, 'package.json'), 'utf8'),
        );

        return (manifest.scripts ?? {})[script] === undefined;
      } catch {
        return true;
      }
    }

    return rootScripts[script] === undefined;
  });
  check(
    'I31',
    'F4-every-npm-script-named-in-layer-0-is-a-key-of-a-real-manifest',
    f4Unknown.length === 0,
    `invocations=${JSON.stringify(f4Invocations)} unknown=${JSON.stringify(f4Unknown)} root_script_count=${Object.keys(rootScripts).length} note=workspace-scoped-commands-resolve-against-that-workspace`,
  );

  const f5Refs = LAYER0_FILES.flatMap((file) =>
    sectionRefsOf(file).map((ref) => ({ file, ...ref })),
  );
  const f5Unresolved = f5Refs.filter(
    (ref) => ref.target === null || !anchorResolves(ref.anchor, ref.target, ref.file, ref.qualifier),
  );
  check(
    'I31',
    'F5-every-section-reference-in-layer-0-resolves-to-a-heading-in-the-file-its-line-names',
    f5Unresolved.length === 0,
    `refs=${JSON.stringify(f5Refs)} unresolved=${JSON.stringify(f5Unresolved)}`,
  );

  // ---- GROUP G: the HARNESS LAYER's own normative documents, checked AGAINST THE RUNTIME.
  //
  // WHY THIS GROUP EXISTS. Every link, section-reference and freshness check above is scoped to LAYER 0
  // (`AGENTS.md`, `.roo/rules/01-project-conventions.md`) or to the SPECIALIST capability file. The harness layer's own
  // normative documents — the manual and `docs/` — were checked for FORMAT and never for internal consistency with the
  // runtime they describe. That is the structural gap a reviewer demonstrated by letting the manual name a state home
  // the runtime stopped writing five cycles ago: nothing in the suite could have gone red, because nothing compared the
  // two. Each set below is DERIVED FROM THE RUNTIME SOURCE, never hand-written, so a home or a command added later is
  // covered without anybody remembering to update a list here.

  const G_RUNTIME_SOURCE = readFileSync(join(REAL_REPO_ROOT, '.harness/runtime/harness.mjs'), 'utf8');
  const G_MANUAL = readFileSync(join(REAL_REPO_ROOT, '.harness/README.md'), 'utf8');
  const G_HARNESS_DOCS = ['.harness/README.md', '.harness/docs/schemas.md', '.harness/docs/ledger.md'];

  // G1 — the state homes the manual names are the homes the runtime writes, and no others.
  const g1Homes = [...new Set([...G_RUNTIME_SOURCE.matchAll(/join\(\s*STATE_DIR,\s*'([^']+)'/g)].map((m) => m[1]))].sort();
  const g1ManualHomes = [...new Set([...G_MANUAL.matchAll(/`\.harness\/state\/([a-z-]+)\/`/g)].map((m) => m[1]))].sort();
  // The manual may name a home in order to say it is LEGACY, so a name absent from the runtime is a finding only when
  // the STATE-HOME LIST marks it. The list is located as a BLOCK — the run of consecutive lines that name homes — and
  // the mark must be inside that block. Two weaker scopes were tried and both failed the proof run, for the same
  // reason: (a) a character window over the whole manual is satisfied by an unrelated "legacy" hundreds of lines away,
  // and (b) a whole-document line scan is satisfied by the prose that discusses the deprecated script. Both left the
  // gate GREEN with D1's original bug restored, which is the only test that matters here.
  const g1ListStart = G_MANUAL.indexOf('- Input contracts: `.harness/state/tasks/`');
  const g1ListBlock = G_MANUAL.slice(g1ListStart, G_MANUAL.indexOf('\n## ', g1ListStart + 1));
  const g1Unmarked = g1ManualHomes.filter(
    (home) => !g1Homes.includes(home) && !new RegExp(`${home}[^\\n]*LEGACY|LEGACY[^\\n]*${home}`, 'i').test(g1ListBlock),
  );
  check(
    'G',
    'G1-the-state-homes-the-manual-names-are-the-homes-the-runtime-writes-except-explicitly-marked-legacy-ones',
    g1Homes.length >= 8 && g1Homes.every((home) => g1ManualHomes.includes(home)) && g1Unmarked.length === 0,
    `runtime_homes=${JSON.stringify(g1Homes)} manual_homes=${JSON.stringify(g1ManualHomes)} ` +
      `runtime_homes_absent_from_the_manual=${JSON.stringify(g1Homes.filter((h) => !g1ManualHomes.includes(h)))} ` +
      `manual_homes_absent_from_the_runtime=${JSON.stringify(g1Unmarked)} (only-a-marked-LEGACY-one-may-be-absent) ` +
      'derivation=join(STATE_DIR, <home>) in .harness/runtime/harness.mjs',
  );

  // G2 — every dispatcher command the manual's command list names EXISTS as a `case` arm. Forward direction, derived.
  // The dispatcher is bounded by the `default:` arm that ends it, NOT by end-of-file: the runtime contains three more
  // `switch` statements below the main one (the `contract`, `workspace` and `ledger` sub-dispatchers), and slicing to
  // EOF folds their 8 sub-commands into the arm count — which is how a check can be green about the wrong set.
  const g2SwitchStart = G_RUNTIME_SOURCE.indexOf('switch (command) {');
  const g2SwitchEnd = G_RUNTIME_SOURCE.indexOf('function printHelp()', g2SwitchStart);
  const g2Arms = [
    ...G_RUNTIME_SOURCE.slice(g2SwitchStart, g2SwitchEnd).matchAll(/^\s{4}case '([a-z-]+)':/gm),
  ].map((m) => m[1]);
  const g2Block = G_MANUAL.slice(G_MANUAL.indexOf('## Runtime commands'), G_MANUAL.indexOf('## The decision surface'));
  const g2Named = [...new Set([...g2Block.matchAll(/npm run harness -- ([a-z-]+)/g)].map((m) => m[1]))].sort();
  const g2Unknown = g2Named.filter((name) => !g2Arms.includes(name));
  check(
    'G',
    'G2-every-command-the-manual-commands-list-names-is-a-real-dispatcher-case-arm',
    g2Arms.length === 16 && g2Named.length >= 8 && g2Unknown.length === 0,
    `dispatch_arms=${JSON.stringify(g2Arms)} (${g2Arms.length}) manual_command_list=${JSON.stringify(g2Named)} ` +
      `named_but_not_an_arm=${JSON.stringify(g2Unknown)} ` +
      'derivation=the case arms of `switch (command)` in .harness/runtime/harness.mjs, plus the --help short-circuit ' +
      'before it; the arm count is stated rather than assumed so adding an arm without documenting it here goes red',
  );

  // G3 — the manual's own coverage claim is TRUE of the manual. The reverse direction of G2, and the guard on the
  // sentence that stood in for a coverage claim while being wrong in both halves.
  const g3Manual = flattenProse(G_MANUAL);
  // The claim is written in WORDS in the manual ("SIXTEEN", "SIX"), so the number is read through a word table rather
  // than a `\\d+` — a claim the check silently fails to read would read as a missing claim, which is the wrong
  // diagnosis for "the sentence says something else now".
  const G3_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  const g3Claim = /the dispatcher has (\w+) `case` arms, and only (\w+) of them have a section/i.exec(g3Manual);
  const g3ClaimedTotal = g3Claim ? G3_WORDS[g3Claim[1].toLowerCase()] ?? Number(g3Claim[1]) : NaN;
  const g3ClaimedSectioned = g3Claim ? G3_WORDS[g3Claim[2].toLowerCase()] ?? Number(g3Claim[2]) : NaN;
  // Which arms have a SECTION of their own, derived from the manual's OWN headings rather than from a list written
  // beside the claim. A heading counts only when it names the command the way a section title does — `harness <arm>` or
  // a heading whose backticked subject IS the arm. A bare backticked mention inside some other heading (the decision
  // surface names `list` among the things not to read first) is not a section, and counting it would make this check
  // agree with any claim, which is the property a coverage check must not have.
  const g3Tick = String.fromCharCode(96);
  const g3Headings = G_MANUAL.split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').toLowerCase());
  // A SIMPLE PLURAL counts, because the manual's ledger section is titled "Ledgers" and a check that only matched the
  // exact singular would report the coverage claim false over a section that plainly exists.
  const g3Sectioned = g2Arms.filter((arm) =>
    g3Headings.some((heading) => new RegExp(`(^|[^a-z-])${arm}(s|es)?([^a-z-]|$)`).test(heading)),
  );
  check(
    'G',
    'G3-the-manuals-case-arm-coverage-claim-agrees-with-the-arms-and-with-its-own-headings',
    g3Claim !== null && g3ClaimedTotal === g2Arms.length && g3ClaimedSectioned === g3Sectioned.length,
    `claimed_total=${g3ClaimedTotal} measured_arms=${g2Arms.length} ` +
      `claimed_with_a_section=${g3ClaimedSectioned} measured_with_a_section=${g3Sectioned.length} ` +
      `sectioned=${JSON.stringify(g3Sectioned)} claim_text=${JSON.stringify(g3Claim?.[0] ?? null)} ` +
      'derivation=arms from the dispatcher, sections from the manual\'s own heading text',
  );

  // G4 — the resolver reports AMBIGUITY rather than resolving a duplicated number, and the harness layer's own `§`
  // references are in scope of it. This is the conjunct that keeps C3 fixed, and the probe proves it fires.
  const g4AmbiguityProbe = anchorMatches('2b', '.harness/docs/schemas.md');
  const g4UniqueProbe = anchorMatches('2b.3a', '.harness/docs/schemas.md');
  const g4Refs = G_HARNESS_DOCS.flatMap((file) => sectionRefsOf(file).map((ref) => ({ file, ...ref })));
  // SCOPED PRECISELY: a BARE-NUMBER reference that NAMES A FILE. That is the C3 property — a duplicated number resolves
  // to two sections — and it is the only thing this check decides.
  //
  // Everything else in the harness layer is already owned, and re-deciding it here would only add a second, weaker
  // copy: a `§"quoted"` or `§Named` reference and a reference whose line names no file (a self-reference, which
  // `nearestTargetOnLine` records as `target: null` by design) are F5's and D4's property, and D4 is scoped to the
  // specialist capability file — so the harness DOCS' own self-references have no owner, and inventing one here
  // turned a correct `no_target` record into a false failure. That is the limit stated next to the mechanism.
  const g4Numeric = g4Refs.filter(
    (ref) => ref.target !== null && /^(?:\d+[a-z]?|\d+(?:\.\d+)*)(?:\.(?:\d+[a-z]?))*$/.test(String(ref.anchor)),
  );
  const g4Bad = g4Numeric
    .map((ref) => ({ ref, outcome: anchorMatches(ref.anchor, ref.target, ref.file, ref.qualifier) }))
    .filter(({ outcome }) => outcome.state !== 'unique');
  check(
    'G',
    'G4-a-bare-number-section-reference-resolving-to-more-than-one-heading-is-AMBIGUOUS-and-the-harness-layer-has-none',
    g4AmbiguityProbe.state === 'ambiguous' && g4AmbiguityProbe.matches.length > 1 &&
      g4UniqueProbe.state === 'unique' && g4Numeric.length > 0 && g4Bad.length === 0,
    `probe_ambiguous={anchor=2b state=${g4AmbiguityProbe.state} matches=${JSON.stringify(g4AmbiguityProbe.matches)}} ` +
      `probe_unique={anchor=2b.3a state=${g4UniqueProbe.state}} ` +
      `harness_layer_refs=${g4Refs.length} bare_number_refs_naming_a_file=${g4Numeric.length} ` +
      `not_unique=${JSON.stringify(g4Bad)} ` +
      'note=schemas.md keeps its duplicate numbers 2b/2b.6/3 by owner decision, so every reference carries the title ' +
      'note2=quoted-and-named-anchors-and-self-references-are-out-of-scope-here-and-belong-to-F5/D4',
  );

  // G5 — the operator scripts' deprecation is documented in the manual, not only in the scripts themselves. Both
  // wrappers exit 2 and create nothing; a reader who finds one in the file has no way to learn that from the manual.
  const g5Wrappers = readdirSync(join(REAL_REPO_ROOT, '.harness/operator')).filter((name) => name.endsWith('.sh')).sort();
  const g5Undocumented = g5Wrappers.filter((name) => !G_MANUAL.includes(name));
  check(
    'G',
    'G5-every-operator-wrapper-script-is-named-in-the-manual-alongside-its-deprecation',
    g5Wrappers.length >= 2 && g5Undocumented.length === 0 && /DEPRECATED|deprecated/.test(G_MANUAL),
    `wrappers=${JSON.stringify(g5Wrappers)} named_in_the_manual=${JSON.stringify(g5Wrappers.filter((n) => G_MANUAL.includes(n)))} ` +
      `undocumented=${JSON.stringify(g5Undocumented)} derivation=readdirSync(.harness/operator)`,
  );

  // F6 makes 'the harness is never inserted into the everyday gate' an ENFORCED invariant rather than a convention.
  // The whole `check` script graph is walked, following every `npm run <script>` reference transitively, so hiding
  // the harness one level down inside `check:fast` fails exactly as loudly as putting it in `check` itself.
  //
  // THE EDGE PATTERN. One space, inside the alternation, and NO `\s+` after the group: the scripts really are written
  // `npm run build:shared && npm run lint`, so the space is the separator between the verb and the name. The previous
  // shape put a literal space INSIDE the `run` branch and then required `\s+` after the group, which demands TWO
  // spaces after `run`, matches nothing in this manifest, and left the walk with `check_graph=["check"]` — an
  // assertion that passed because it had looked at nothing, and was cited as the guard. (The sibling pattern in F4
  // above is a DIFFERENT and correct shape: `run ` followed directly by the captured name, with no `\s+`.)
  // `npm test` / `npm start <name>` are kept because a script may invoke a workspace test by its bare name; the
  // resulting graph is a superset of the real edges, and a superset can only over-report a harness node, never hide one.
  const f6Walk = (() => {
    const seen = new Set();
    const edges = [];
    const walk = (name) => {
      if (seen.has(name) || rootScripts[name] === undefined) return;
      seen.add(name);
      for (const match of [
        ...String(rootScripts[name]).matchAll(
          /npm (?:run|test|start)\s+([a-z][a-z0-9:]*)/g,
        ),
      ]) {
        edges.push(`${name} -> ${match[1]}`);
        walk(match[1]);
      }
    };

    walk('check');

    return { graph: [...seen].sort(), edges };
  })();
  const f6Graph = f6Walk.graph;
  const f6HarnessInGraph = f6Graph.filter(
    (name) => /harness/.test(name) || /harness/.test(String(rootScripts[name])),
  );
  // THE WALK IS NOT VACUOUS, and the condition carries the proof rather than the shape. A walk that followed ZERO
  // edges would return `["check"]`, find no harness node, and pass — which is exactly the failure this conjunct exists
  // to make unrepeatable: a future edit that breaks the parser (or rewrites a script so the pattern stops matching)
  // would turn this assertion into a silent pass again. So the check demands edges that were actually followed AND a
  // graph that went somewhere real — `check` delegating to `check:fast` is the shape the manifest is known to have, and
  // a graph of one node cannot satisfy it.
  const f6WalkIsReal =
    f6Walk.edges.length > 0 && f6Graph.length > 1 && f6Graph.includes('check:fast');
  check(
    'I31',
    'F6-the-application-gate-never-invokes-the-harness-gate-at-any-depth',
    f6HarnessInGraph.length === 0 &&
      !/harness/.test(String(rootScripts.check)) &&
      f6WalkIsReal,
    `check_graph=${JSON.stringify(f6Graph)} (${f6Graph.length}) harness_in_graph=${JSON.stringify(f6HarnessInGraph)} ` +
      `check_script=${JSON.stringify(rootScripts.check)} edges_followed=${f6Walk.edges.length} ` +
      `walk_is_real=${f6WalkIsReal} edges=${JSON.stringify(f6Walk.edges)} ` +
      'note=walked-transitively-so-a-nested-npm-run-harness-cannot-hide ' +
      'note2=edges_followed>0-and-check:fast-in-the-graph-so-a-parser-that-stops-matching-goes-red-instead-of-silently-passing',
  );
// ---- F7: THE AGENT-SCRATCH CONVENTION IS REAL, IN ALL THREE CONFIGURERS, AND ONLY THE `.gitkeep` IS EXEMPT.
//
// WHY THIS EXISTS. Subagents had been dropping scratch `.md` and test files in the repository root, in `ui/`, and in
// unrelated folders, and `npm run lint` then walked them: ESLint alone was visiting 446 files / 3.24 MB and Prettier
// 898, including the 934 KB `.harness/runtime/harness.mjs`, which is how a single throwaway file became a multi-minute
// stall on a run that has a published budget. The convention that fixes it is a directory plus three ignore entries, and
// a convention held only in prose is a convention that decays — the failure it prevents is a slow gate, which nobody
// notices until a run times out.
//
// WHAT IS ASSERTED, and all four answers are DERIVED BY READING THE THREE CONFIG FILERS rather than by hardcoding a
// path: the directory exists, git ignores its CONTENTS but not its `.gitkeep`, Prettier ignores the directory, and
// ESLint's `ignores` array names it. Nothing here asks git what it thinks — gitignore semantics (negation order,
// anchoring, directory-only patterns) are subtle, and a hand-rolled matcher would be a second implementation of a
// rule git already owns. The gitignore answer is therefore read off the FILE: the entry that matches the directory's
// contents, and the separate entry that re-admits the `.gitkeep`. Both are parsed, so a future edit that deletes the
// negation fails here rather than silently leaving the directory untrackable in a fresh clone.
const SCRATCH_DIR = ".agent-scratch";
const SCRATCH_KEEP = `${SCRATCH_DIR}/.gitkeep`;
const scratchDir = join(REAL_REPO_ROOT, SCRATCH_DIR);
const scratchIsDirectory = dirExists(scratchDir);
const scratchKeepExists = existsSync(join(REAL_REPO_ROOT, SCRATCH_KEEP));
// Non-comment, non-blank lines of an ignore file, negation entries kept because they are rules too.
const ignoreEntriesOf = (relative) =>
  layer0Text(relative)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
const scratchGitignore = ignoreEntriesOf(".gitignore");
const scratchGitignoreContents = scratchGitignore.filter(
  (entry) => entry === `${SCRATCH_DIR}/*` || entry === `${SCRATCH_DIR}/**`,
);
const scratchGitignoreKeep = scratchGitignore.filter(
  (entry) => entry === `!${SCRATCH_KEEP}`,
);
const scratchPrettier = ignoreEntriesOf(".prettierignore").filter(
  (entry) => entry === SCRATCH_DIR || entry === `${SCRATCH_DIR}/`,
);
// The ESLint `ignores` array, read as source text: the same class of claim the file is, rather than an evaluated
// value, because an evaluated value would pass on the very edit being refused.
const scratchEslintSource = readFileSync(
  join(REAL_REPO_ROOT, "eslint.config.js"),
  "utf8",
);
const scratchEslintIgnoresArray =
  /ignores:\s*\[([\s\S]*?)\]/.exec(scratchEslintSource)?.[1] ?? "";
const scratchEslintEntry = [...scratchEslintIgnoresArray.matchAll(/'([^']+)'/g)]
  .map((match) => match[1])
  .filter((entry) => entry === SCRATCH_DIR || entry === `${SCRATCH_DIR}/`);
// The rule has to be WRITTEN DOWN somewhere, not only configured, and in BOTH always-on files: a rule that lives only
// in `AGENTS.md` is a rule some modes never read, because they load the generic rules instead.
const scratchRuleFiles = ["AGENTS.md", ".roo/rules/01-project-conventions.md"];
const scratchRuleMissing = scratchRuleFiles.filter(
  (file) => !layer0Text(file).includes(SCRATCH_DIR),
);
check(
  "I31",
  "the-agent-scratch-directory-exists-AND-is-ignored-by-git-prettier-and-eslint-AND-only-its-gitkeep-is-exempt",
  scratchIsDirectory &&
    scratchKeepExists &&
    scratchGitignoreContents.length > 0 &&
    scratchGitignoreKeep.length > 0 &&
    scratchPrettier.length > 0 &&
    scratchEslintEntry.length > 0 &&
    scratchRuleMissing.length === 0,
  `directory_exists=${scratchIsDirectory} gitkeep_exists=${scratchKeepExists} ` +
    `gitignore_contents_entries=${JSON.stringify(scratchGitignoreContents)} gitignore_keep_entries=${JSON.stringify(scratchGitignoreKeep)} ` +
    `prettierignore_entries=${JSON.stringify(scratchPrettier)} eslint_ignores_entries=${JSON.stringify(scratchEslintEntry)} ` +
    `rule_missing_from=${JSON.stringify(scratchRuleMissing)} scanned=${JSON.stringify([".gitignore", ".prettierignore", "eslint.config.js", ...scratchRuleFiles])} ` +
    "note=the-gitignore-answer-is-read-off-the-file-because-negation-order-and-anchoring-are-gits-rules-not-ones-to-reimplement " +
    "note=the-eslint-answer-is-read-as-source-text-because-an-evaluated-config-passes-on-the-edit-being-refused " +
    "note=the-rule-is-required-in-both-always-on-files-because-a-rule-only-in-AGENTS.md-is-a-rule-some-modes-never-read",
);


  // ---- I33: THE PER-COMMAND HELP, asserted as mechanics.
  //
  // WHAT THIS IS. The harness prose moved out of the always-loaded layer into a specialist one, which removed ~75 % of the
  // context an agent carries — and left the command surface unreachable: `harness <command> --help` was refused as an
  // UNKNOWN FLAG, so an agent asking the tool how it works was treated as making a refused request, and the only help
  // that existed was a 26 kB top-level block. The CLI now teaches the surface per command.
  //
  // SIX THINGS ARE ASSERTED, and the first is the one everything else depends on.
  //   1. `--help` is a MODE OF INVOCATION and is in NO allowlist entry. The refusal machinery exists so
  //      `evaluate --acceptence=pass` cannot be read as a granted capability; an allowlist entry for `help` would make the
  //      same mistake in the other direction — a screen reachable as ordinary flag data. Read as SOURCE TEXT, not by
  //      executing the object: an assertion that imported the constant would pass on a constant that had been edited to
  //      contain 'help', which is precisely the change being refused.
  //   2. Every body is inside its byte budget, and the MEASURED size is printed, so a screen that grows says how much.
  //   3. Every body RENDERS its exit set from the constant: the constant's own rows are looked for in the output, which is
  //      a derivation rather than a restatement of a hand-written list.
  //   4. No body carries the measured evidence or the byte-floor arithmetic. Those belong to the reference layer, read
  //      when a result is being judged; a screen read at the moment of use stops being read above a few kilobytes.
  //   5. No body links to a path that does not exist, and none outside `.harness/`. The rule this replaces named one
  //      directory — the research corpus — because that was the only link a help screen was ever caught carrying. The
  //      rule it is replaced by names the property rather than the instance: a screen is read at the moment of use, and
  //      a link from it is a promise about the filesystem that a caller is entitled to have kept. A DEAD link is the
  //      concrete version of that, and an escape outside `.harness/` is the other: a screen is not the place from which to
  //      route a reader into the wider tree.
  const i33Source = readFileSync(join(RUNTIME_DIR, 'harness.mjs'), 'utf8');
  /** The literal text of one named constant, so the assertion is about the SOURCE and not about an evaluated value. */
  const i33ConstLiteral = (name, opener) => {
    const at = i33Source.indexOf(`const ${name} = ${opener}`);

    if (at < 0) return '';

    return i33Source.slice(at, i33Source.indexOf('\n};', at) + 3);
  };
  const i33AllowlistLiteral = i33ConstLiteral('COMMAND_FLAG_ALLOWLIST', '{');
  const i33BooleanLiteral = i33ConstLiteral('COMMAND_BOOLEAN_FLAGS', '{');
  // The QUOTED entries of a flag table, which is what an entry actually is. A comment that happens to say "help" is not
  // an entry, and a substring search over the whole literal would refuse one.
  const i33QuotedEntries = (literal) => [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const i33AllowlistEntries = [...i33QuotedEntries(i33AllowlistLiteral), ...i33QuotedEntries(i33BooleanLiteral)];
  const i33HelpEntries = i33AllowlistEntries.filter((entry) => entry === 'help' || entry.startsWith('help-'));
  const i33UnknownFlagExit = /const UNKNOWN_FLAG_EXIT = (\d+);/.exec(i33Source)?.[1] ?? 'ABSENT';
  check(
    'I33',
    'help-is-in-NO-allowlist-or-boolean-entry-and-the-unknown-flag-refusal-still-exits-2',
    i33HelpEntries.length === 0 && i33UnknownFlagExit === String(s2.UNKNOWN_FLAG_EXIT) && i33UnknownFlagExit === '2',
    `help_entries=${JSON.stringify(i33HelpEntries)} allowlist_quoted=${i33AllowlistEntries.length} ` +
      `UNKNOWN_FLAG_EXIT(source)=${i33UnknownFlagExit} UNKNOWN_FLAG_EXIT(injected)=${s2.UNKNOWN_FLAG_EXIT} ` +
      'note=read-as-source-text-because-an-evaluated-constant-passes-on-the-edit-being-refused',
  );

  const I33_HELP_COMMANDS = Object.keys(s2.COMMAND_HELP);
  const i33Bodies = new Map(I33_HELP_COMMANDS.map((command) => [command, s2.commandHelpBody(command)]));
  // The budget is a MEASUREMENT and the measured value travels in the detail, because a bound nobody can read is a bound
  // nobody trusts. The per-command figure wins where one is named, the default otherwise.
  const i33BudgetOf = (command) => s2.COMMAND_HELP_BUDGET[command] ?? s2.COMMAND_HELP_BUDGET.default;
  const i33Sizes = I33_HELP_COMMANDS.map((command) => ({
    command,
    bytes: Buffer.byteLength(i33Bodies.get(command) ?? ''),
    budget: i33BudgetOf(command),
  }));
  const i33OverBudget = i33Sizes.filter((row) => row.bytes > row.budget);
  check(
    'I33',
    'every-per-command-help-body-is-inside-its-byte-budget-and-prints-its-measured-size',
    I33_HELP_COMMANDS.length > 0 && i33OverBudget.length === 0 && i33Sizes.every((row) => row.bytes > 0),
    `measured=${JSON.stringify(i33Sizes)} over_budget=${JSON.stringify(i33OverBudget)} ` +
      `rationale=read-at-the-moment-of-use-every-time-and-above-a-few-kilobytes-it-stops-being-read`,
  );

  // The budget's own justifying comment states MEASURED figures — `evaluate` at 3 796, the 204 bytes of slack, and
  // `regress` as the largest screen under `default`. A comment whose entire argument is "this number was measured"
  // is the most load-bearing prose in the file, and it is the prose least likely to be re-measured: `regress` sat at
  // 3 436 in it while the screen measured 3 637, and nothing failed, because a stale number in a comment is invisible
  // to every other check. This is the assertion that makes the class non-recurring: the figures are PARSED OUT OF THE
  // COMMENT AS SOURCE TEXT and compared against `commandHelpBody`, so a drifted figure reddens here rather than
  // misleading the next reader. The detail PRINTS the comment's number beside the measured one, so the failure says
  // which figure moved and by how much.
  //
  // The numbers are written with a thin space in the comment (`3 796`), so the parser accepts either spelling. It reads
  // the figure that FOLLOWS each command name, which is the sentence's own construction, and it derives the slack from
  // the two constants rather than from a literal — a slack asserted against a hand-typed 204 would be a restatement
  // that passes on the arithmetic being wrong.
  const i33CommentBlock = (() => {
    const at = i33Source.indexOf('// WHAT CHANGED. `evaluate` was');

    if (at < 0) return '';

    return i33Source.slice(at, i33Source.indexOf('const COMMAND_HELP_BUDGET', at));
  })();
  const i33CommentNumber = (after) => {
    const at = i33CommentBlock.indexOf(after);

    if (at < 0) return null;

    const match = /([\d][\d\s]*\d|\d)\b/.exec(i33CommentBlock.slice(at + after.length));

    return match === null ? null : Number(match[1].replace(/\s/g, ''));
  };
  const i33EvaluateComment = i33CommentNumber('the screen comes to\n// ');
  const i33RegressComment = i33CommentNumber('largest screen under it is `regress` at ');
  const i33MeasuredOf = (command) => i33Sizes.find((row) => row.command === command)?.bytes ?? null;
  const i33CommentFigures = [
    { figure: 'evaluate_screen_bytes', comment: i33EvaluateComment, measured: i33MeasuredOf('evaluate') },
    { figure: 'regress_screen_bytes', comment: i33RegressComment, measured: i33MeasuredOf('regress') },
  ].map((row) => ({ ...row, agree: row.comment !== null && row.comment === row.measured }));
  // The slack is DERIVED: the `evaluate` budget minus the measured screen, against the figure the comment calls slack.
  const i33SlackComment = i33CommentNumber('the slack is ');
  const i33SlackMeasured = s2.COMMAND_HELP_BUDGET.evaluate - (i33MeasuredOf('evaluate') ?? 0);
  const i33CommentFiguresWrong = i33CommentFigures.filter((row) => !row.agree);
  check(
    'I33',
    'the-byte-sizes-QUOTED-IN-THE-budget-comment-match-a-live-measurement-rather-than-a-remembered-literal',
    i33CommentBlock !== '' &&
      i33CommentFigures.length === 2 &&
      i33CommentFiguresWrong.length === 0 &&
      i33SlackComment !== null &&
      i33SlackComment === i33SlackMeasured,
    `figures=${JSON.stringify(i33CommentFigures)} ` +
      `slack={comment:${i33SlackComment} measured:${i33SlackMeasured} derived_from:COMMAND_HELP_BUDGET.evaluate-minus-the-evaluate-screen} ` +
      'note=read-as-source-text-because-a-stale-number-in-a-comment-is-invisible-to-every-other-check-this-one-is-the-only-place-it-can-show-up',
  );

  // DERIVATION, NOT RESTATEMENT. The evaluate screen is asked for the constant's own rows; regress and census for the
  // names of the constants their exit sites return. A hand-written list here would pass on a screen that disagreed with
  // the code, which is the one thing the whole design of rendering from constants exists to prevent.
  const i33EvaluateBody = i33Bodies.get('evaluate') ?? '';
  const i33EvaluateRows = s2.EVALUATE_EXIT_TABLE.map(([code, meaning, scope]) => ({
    code,
    present: i33EvaluateBody.includes(`  ${code}  ${meaning}`) && i33EvaluateBody.includes(`scope: ${scope}`),
  }));
  const i33RegressNames = [
    s2.REGRESS_EXIT_NO_FINDING,
    s2.REGRESS_EXIT_FINDING,
    s2.REGRESS_EXIT_USAGE,
    s2.REGRESS_EXIT_SIDE_ERROR,
    s2.REGRESS_EXIT_INCONCLUSIVE,
    s2.REGRESS_EXIT_CLEANUP_FAILED,
  ].map((value) => ({ value, name: `REGRESS_EXIT_${value === 0 ? 'NO_FINDING' : value === 1 ? 'FINDING' : value === 2 ? 'USAGE' : value === 4 ? 'SIDE_ERROR' : value === 5 ? 'INCONCLUSIVE' : 'CLEANUP_FAILED'}` }));
  const i33RegressBody = i33Bodies.get('regress') ?? '';
  const i33CensusBody = i33Bodies.get('census') ?? '';
  const i33WorkspaceBody = i33Bodies.get('workspace') ?? '';
  const i33Derivation = [
    ...i33EvaluateRows.map((row) => ({ command: 'evaluate', key: row.code, present: row.present })),
    ...i33RegressNames.map((row) => ({ command: 'regress', key: row.name, present: i33RegressBody.includes(row.name) })),
    ...[0, 1, 2, 4, 5].map((code) => ({
      command: 'census',
      key: `CENSUS_EXIT_${code === 0 ? 'NO_FINDING' : code === 1 ? 'FINDING' : code === 2 ? 'USAGE' : code === 4 ? 'COMMIT_ERROR' : 'UNDETERMINED'}`,
      present: i33CensusBody.includes(`CENSUS_EXIT_${code === 0 ? 'NO_FINDING' : code === 1 ? 'FINDING' : code === 2 ? 'USAGE' : code === 4 ? 'COMMIT_ERROR' : 'UNDETERMINED'}`),
    })),
    ...[s2.WORKSPACE_EXIT_USAGE, s2.WORKSPACE_EXIT_ENVIRONMENT].map((code) => ({
      command: 'workspace',
      key: `WORKSPACE_EXIT_${code === s2.WORKSPACE_EXIT_USAGE ? 'USAGE' : 'ENVIRONMENT'}`,
      present: i33WorkspaceBody.includes(`WORKSPACE_EXIT_${code === s2.WORKSPACE_EXIT_USAGE ? 'USAGE' : 'ENVIRONMENT'}`),
    })),
  ];
  const i33NotRendered = i33Derivation.filter((row) => !row.present);
  check(
    'I33',
    'every-per-command-help-RENDERS-its-exit-set-FROM-THE-CONSTANT-rather-than-restating-a-hand-written-list',
    i33Derivation.length > 0 && i33NotRendered.length === 0,
    `rendered=${i33Derivation.length} not_rendered=${JSON.stringify(i33NotRendered)} ` +
      `evaluate_rows=${JSON.stringify(i33EvaluateRows.map((row) => row.code))}`,
  );

  // The measured evidence and the arithmetic stayed in the reference layer. Every token below was checked against the
  // REAL output before being asserted absent; the two that needed care are called out, because an absence assertion that
  // was never verified is worse than no assertion.
  const I33_EVIDENCE_TOKENS = [
    '40/40',
    '58/59',
    '9/9',
    '81165e6',
    '143 commits',
    '60.1 %',
    '395 trials',
    'skip-suppresses-the-culprit',
    'verdictHeadByteFloor',
    '112',
    '192',
    '218',
  ];
  const i33EvidenceHits = [];
  for (const [command, body] of i33Bodies) {
    for (const token of I33_EVIDENCE_TOKENS) {
      if (body.includes(token)) i33EvidenceHits.push(`${command}:${token}`);
    }
  }
  check(
    'I33',
    'no-per-command-help-carries-the-measured-evidence-or-the-byte-floor-arithmetic',
    i33EvidenceHits.length === 0,
    `tokens_checked=${I33_EVIDENCE_TOKENS.length} hits=${JSON.stringify(i33EvidenceHits)} ` +
      'note=these-belong-to-the-reference-layer-read-when-judging-a-result-not-when-running-a-command',
  );

  // ---- No per-command help screen links to a path that does not exist, or to a path outside `.harness/`. This REPLACES
  // an assertion that named ONE directory — the deleted research corpus — and it is stronger in both directions: the old
  // one refused that directory specifically and would have passed a link to any other path, including one that is dead
  // on disk. This one states the
  // property rather than the instance, so a screen that grows a link to a new place is held by the same rule.
  //
  // WHY THE PROPERTY IS WORTH HAVING. A help screen is read at the moment of use, by a caller who is about to type a
  // command rather than by a reader studying the tool. A path on such a screen is a promise about the filesystem that
  // the caller is entitled to have kept, and a promise that is not kept costs the caller a step they did not budget for.
  // The two failure modes are therefore both refused: a DEAD path, and an escape OUTSIDE `.harness/` — a screen is not
  // the place from which to route a reader into the wider tree, and the reference material it needs is inside.
  //
  // WHAT COUNTS AS A LINK TARGET, and why the token shape is this narrow. A path-shaped token is one that contains a `/`
  // or begins with a `.` and ends in a file extension: `.harness/docs/schemas.md`, `runtime/harness.mjs`. Prose words,
  // flag names, command names, exit codes, version numbers and bare directory names are NOT links, and treating them as
  // such would produce a check that fails on a sentence rather than on a promise. The shape is deliberately conservative
  // in the other direction too: it under-reports rather than over-reports, so a FAIL is always a real path.
  const I33_HELP_LINK_ROOT = ".harness/";
  const I33_LINK_TOKEN =
  /[A-Za-z0-9_.][A-Za-z0-9_.\/-]*\.[A-Za-z][A-Za-z0-9]{0,7}/g;
  /** A token a reader could follow: a path, not a word, a version or a flag. */
  const i33IsPathToken = (token) =>
  (token.includes("/") || token.startsWith(".")) && !token.includes("//");
  // Resolved against the repository root, the way a screen's path reads: a screen is rendered in place and its paths are
  // written repo-root relative. Both bases are tried anyway — the same probe markdown itself uses — and a token resolving
  // through neither is a dead promise.
  const i33HelpLinks = [];
  for (const [command, body] of i33Bodies) {
  for (const match of body.matchAll(I33_LINK_TOKEN)) {
    const target = match[0];
    if (!i33IsPathToken(target)) continue;
    const hit = linkResolvesFrom(".harness/README.md", target);
    i33HelpLinks.push({
      command,
      target,
      resolved: hit.resolved,
      outside_harness: !target.startsWith(I33_HELP_LINK_ROOT),
    });
  }
  }
  // THE NON-VACUITY GUARD, for the reason E1 carries one. A scan that found no path-shaped token at all would report "no
  // bad links" for a reason that has nothing to do with the screens being clean, and would go green the moment its
  // subject changed shape. So the SCAN is required, not just its outcome: at least one command and at least one path
  // token. The command set is derived from `COMMAND_HELP` above and never written out here, so a new screen is covered
  // the day it lands.
  const i33DeadHelpLinks = i33HelpLinks.filter((link) => !link.resolved);
  const i33EscapingHelpLinks = i33HelpLinks.filter(
  (link) => link.outside_harness,
  );
  check(
  "I33",
  "no-per-command-help-links-to-a-path-that-does-not-exist-OR-to-a-path-outside-.harness",
  I33_HELP_COMMANDS.length > 0 &&
    i33HelpLinks.length > 0 &&
    i33DeadHelpLinks.length === 0 &&
    i33EscapingHelpLinks.length === 0,
  `commands=${I33_HELP_COMMANDS.length} (${JSON.stringify(I33_HELP_COMMANDS)}) path_tokens=${i33HelpLinks.length} ` +
    `scanned=${JSON.stringify(i33HelpLinks)} dead=${JSON.stringify(i33DeadHelpLinks)} outside_harness=${JSON.stringify(i33EscapingHelpLinks)} ` +
    "note=replaces-the-one-named-directory-and-is-stricter-because-a-dead-link-to-any-path-now-fails-here-not-only-a-link-to-the-corpus " +
    "note=the-command-set-is-derived-from-COMMAND_HELP-and-tokens-must-be-path-shaped-so-prose-is-not-read-as-a-link " +
    "note=path_tokens>0-is-required-so-this-cannot-pass-by-finding-nothing",
  );

  // The screen is reachable, and it is reachable WITHOUT weakening the refusal. Read against the REAL runtime rather
  // than against `commandHelpBody`, because "it prints" is a claim about the process a caller actually runs.
  const i33Real = I33_HELP_COMMANDS.map((command) => runHarness(REAL_REPO_ROOT, [command, '--help'], join(REAL_REPO_ROOT, '.harness')));
  const i33RealBad = I33_HELP_COMMANDS.filter((command, index) => i33Real[index].status !== 0 || i33Real[index].stderr !== '');
  check(
    'I33',
    'every-per-command-help-is-reachable-as-a-REAL-subprocess-and-exits-0-with-nothing-on-stderr',
    i33RealBad.length === 0,
    `commands=${JSON.stringify(I33_HELP_COMMANDS)} offending=${JSON.stringify(i33RealBad)} ` +
      `statuses=${JSON.stringify(I33_HELP_COMMANDS.map((c, i) => `${c}:${i33Real[i].status}`))}`,
  );

  // ---- FIX B3: a screen may not be a PARTIAL truth. Every flag the command accepts is named on its screen.
  //
  // WHY THIS IS SEPARATE FROM THE BUDGET. The budget says a screen is not too long; it says nothing about whether it is
  // complete, and a screen naming ten of forty flags passes a budget comfortably. The failure is concrete: `evaluate`
  // accepted forty flags, named about ten, and `--workspace=<path>` was among the missing — a flag whose absence does
  // not cause a refusal, it silently measures the working tree instead of the prepared workspace the procedure was
  // about. A partial screen is worse than none, because a reader who trusts it cannot tell an undocumented flag from
  // a refused one.
  //
  // DERIVED FROM THE CONSTANT, per command. The allowlist is read out of the SOURCE TEXT (the same literal machinery
  // that refuses `help`), split per command, and every entry is required to appear in that command's rendered body.
  // Reading the constant is what makes this a derivation: a hand-written list of "the important flags" would pass on a
  // screen that omitted a flag the list never named, which is the defect itself.
  //
  // WHICH COMMANDS ARE COVERED. A command with NO allowlist entry accepts no flags and has nothing to document. A
  // command whose entry is an OBJECT has subcommands, and one flat roster per command would print flags belonging to a
  // subcommand the reader did not ask for; those screens document flags in a usage block that names the subcommand.
  // Both exclusions are REPORTED in the detail, so they are visible rather than being a way to pass on nothing.
  const i33PerCommandFlags = (() => {
    const per = {};
    for (const literal of [i33AllowlistLiteral, i33BooleanLiteral]) {
      const lines = literal.split('\n');
      let current = null;
      for (const line of lines) {
        const arrayHead = /^ {2}([a-z-]+): \[$/.exec(line);
        const objectHead = /^ {2}([a-z-]+): \{$/.exec(line);
        if (arrayHead) {
          current = arrayHead[1];
          per[current] = { flags: [], subcommandShaped: false };
          continue;
        }
        if (objectHead) {
          current = objectHead[1];
          per[current] = { flags: [], subcommandShaped: true };
          continue;
        }
        if (/^ {2}\},?$/.test(line)) {
          current = null;
          continue;
        }
        const token = /^ {4}'([^']+)',$/.exec(line);
        if (token && current && !per[current].subcommandShaped) per[current].flags.push(token[1]);
      }
    }
    for (const entry of Object.values(per)) entry.flags = [...new Set(entry.flags)];
    return per;
  })();
  const i33RosterRows = I33_HELP_COMMANDS.map((command) => {
    const entry = i33PerCommandFlags[command];
    const body = i33Bodies.get(command) ?? '';
    const flags = entry?.flags ?? [];
    // `--gate` must not be satisfied by `--gate-env`: the negative lookahead is what makes this a per-FLAG check
    // rather than a substring check, which would pass on any screen containing a longer flag with the same prefix.
    const missing = flags.filter((flag) => !new RegExp(`--${flag}(?![a-z-])`).test(body));

    return { command, required: flags.length, missing, subcommandShaped: entry?.subcommandShaped ?? false, hasEntry: entry !== undefined };
  });
  const i33RosterApplicable = i33RosterRows.filter((row) => row.hasEntry && !row.subcommandShaped && row.required > 0);
  const i33RosterMissing = i33RosterApplicable.filter((row) => row.missing.length > 0);
  check(
    'I33',
    'every-per-command-screen-names-EVERY-flag-its-own-COMMAND_FLAG_ALLOWLIST-entry-permits',
    i33RosterApplicable.length > 0 && i33RosterMissing.length === 0,
    `applicable=${JSON.stringify(i33RosterApplicable.map((row) => `${row.command}:${row.required}`))} ` +
      `missing=${JSON.stringify(i33RosterMissing.map((row) => `${row.command}:${JSON.stringify(row.missing)}`))} ` +
      `excluded_no_entry=${JSON.stringify(i33RosterRows.filter((row) => !row.hasEntry).map((row) => row.command))} ` +
      `excluded_subcommand_shaped=${JSON.stringify(i33RosterRows.filter((row) => row.subcommandShaped).map((row) => row.command))} ` +
      'derived_from=the-allowlist-literal-read-as-source-text-not-a-hand-written-list-of-important-flags',
  );
  // THE COMPENSATING ASSERTION, and what stops the one above being satisfiable by shrinking the derived set. Coverage
  // passes trivially when the derived flag set is empty, so this requires the largest roster to be substantial, and
  // requires EVERY applicable screen to be inside its budget. Together they say the coverage is real and that the
  // budget raised to carry it is still enforced rather than abandoned.
  const i33LargestRoster = [...i33RosterApplicable].sort((a, b) => b.required - a.required)[0];
  check(
    'I33',
    'the-roster-coverage-is-NOT-vacuous-the-largest-derived-roster-is-substantial-and-every-screen-is-inside-its-budget',
    i33LargestRoster !== undefined &&
      i33LargestRoster.required >= 20 &&
      i33RosterApplicable.every((row) => Buffer.byteLength(i33Bodies.get(row.command) ?? '') <= i33BudgetOf(row.command)),
    `largest=${JSON.stringify(i33LargestRoster)} ` +
      `measured=${JSON.stringify(i33Sizes)} budgets=${JSON.stringify(Object.entries(s2.COMMAND_HELP_BUDGET))} ` +
      'note=evaluate-is-the-screen-the-budget-was-raised-for-and-covering-forty-flags-is-what-the-slack-is-spent-on',
  );

  // ---- FIX B1, WITHOUT A SUBPROCESS: a command with NO per-command screen must not RUN when asked for help.
  //
  // THE DEFECT. `printCommandHelp` returns `null` for a command that has no screen, and `main()` used to read that
  // `null` as "decline, and let the dispatch switch run it anyway". So `self-test --help` ran the entire invariant
  // suite, `list --help` and `taxonomy --help` ran and ignored the flag, and `show --help` consumed `--help` as a
  // task id. A help request was a run request. The runtime now returns the top-level screen instead of falling
  // through, so the switch is never reached.
  //
  // THE SET IS DERIVED FROM SOURCE, NEVER WRITTEN. The screen set and the dispatch set are both read out of
  // `harness.mjs` and the no-screen set is the DIFFERENCE, so a command that ships without a screen is in this
  // check on arrival. A literal list of nine would keep passing after a tenth command landed, which is the same
  // defect wearing a different hat.
  const i33ScreenCommands = (() => {
    const start = i33Source.indexOf('const COMMAND_HELP = {');
    const literal = i33Source.slice(start, i33Source.indexOf('\n};', start) + 3);

    return [...literal.matchAll(/^ {2}([a-z-]+): \(\) => \[/gm)].map((match) => match[1]);
  })();
  const i33DispatchCommands = (() => {
    const start = i33Source.indexOf('  switch (command) {');
    const arms = i33Source.slice(start, i33Source.indexOf('function printHelp()', start));

    return [...arms.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((match) => match[1]);
  })();
  const i33NoScreen = [...new Set(i33DispatchCommands)].filter((command) => !i33ScreenCommands.includes(command));
  // The derivation is cross-checked against the INJECTED constant rather than trusted: the source parse and
  // `commandHelpBody` are independent readings of the same table, and a screen that exists in one and not the other
  // is a parse bug here rather than a silent hole in the set.
  const i33NoScreenTrulyUnscreened = i33NoScreen.every((command) => s2.commandHelpBody(command) === null);
  // And the set is not empty: this check over an empty set would pass without asserting anything, which is why the
  // condition carries the size and the membership rather than only the shape.
  const i33NoScreenIsReal = i33NoScreen.length > 0 && i33NoScreen.includes('self-test');
  // THE INVARIANT, read as source text. The help branch must RETURN on the no-screen path. What is refused is the
  // shape that was there before: a `printCommandHelp` call whose `null` result only skips a `return` and then falls
  // into the switch. The branch is read as a whole, and the check is that it contains no `switch` — the dispatch is
  // downstream of the branch, so its absence inside is what "the switch is never reached" means here.
  const i33HelpBranch = (() => {
    const start = i33Source.indexOf("if (rest.includes('--help') || rest.includes('-h')) {");
    if (start < 0) return '';

    let depth = 0;
    let index = i33Source.indexOf('{', start);

    for (; index < i33Source.length; index += 1) {
      if (i33Source[index] === '{') depth += 1;
      else if (i33Source[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    return i33Source.slice(start, index + 1);
  })();
  const i33HelpBranchNeverDispatches = i33HelpBranch !== '' && /return printTopLevelHelpForHelpToken\(rest\);/.test(i33HelpBranch);
  check(
    'I33',
    'a-command-with-NO-per-command-screen-can-NOT-run-when-asked-for-help-and-the-set-is-derived-not-written',
    i33NoScreenTrulyUnscreened && i33NoScreenIsReal && i33HelpBranchNeverDispatches,
    `derived_no_screen=${JSON.stringify(i33NoScreen)} (${i33NoScreen.length}) screens=${JSON.stringify(i33ScreenCommands)} ` +
      `dispatch=${JSON.stringify(i33DispatchCommands)} all_truly_unscreened=${i33NoScreenTrulyUnscreened} ` +
      `contains_self_test=${i33NoScreen.includes('self-test')} help_branch_returns_top_level=${i33HelpBranchNeverDispatches} ` +
      `branch=${JSON.stringify(i33HelpBranch)}`,
  );

  // ---- I25 (LAST): the documented totals are compared against a MEASURED run, so this check is deliberately the final
  // check recorded — `results.length + 1` is the total it is about to become, and that arithmetic is exact only in the
  // last position. The compatibility total is COMPUTED from that suite's own label table, never from a golden value.
  // +1 on the assertions, because THIS check is not in `results` yet. NO +1 on the invariants: this check belongs to
  // `I25` and `I25` is ALREADY in the set from the checks above it, so a +1 here would demand 38 for a 37-group run —
  // wrong in the direction that looks precise. (The literals in the previous revision of this comment, '32 for a 31-group
  // run', were correct when the run had 31 groups and were left behind by later groups; the arithmetic is unchanged, only
  // the two numbers it is written in.)
  // ---- THE MONOTONICITY FLOOR. This is a FLOOR, not a target and not a fixed value: the measured counts are asserted
  // to be AT OR ABOVE it, and the suite's own history is representable as ordinary moves of this constant — 422 → 486
  // across the suite's life, and a cycle's deliberate deletions, are each one commented edit here rather than a rewrite
  // of the assertion set. What it PROTECTS: a reduction cannot be made silently. Lowering the floor is a diff like any
  // other, and the comment above it is the written justification the reduction then has to carry. What it does NOT
  // catch, stated because the limit belongs next to the mechanism: a deletion made to PRESERVE a documented number by
  // editing the prose instead — that is a reviewer's judgement, not a gate's. Raising the floor after a cycle that
  // added assertions is the encouraged move; it is what makes the next reduction unrepeatable by accident.
  const ASSERTION_FLOOR = { assertions: 491, invariants: 40, compatibility: 224 };

  const expectedAssertions = results.length + 1;
  const expectedInvariants = new Set(results.map((entry) => entry.invariant)).size;
  const selfTestTotals = /\*\*(\d+) self-test assertions across (\d+) invariant groups\*\*/g;
  const agentsSelfTest = selfTestTotals.exec(agentsDoc);
  const readmeSelfTest = /currently \*\*(\d+) assertions\*\* across (\d+) invariant groups/.exec(readmeDoc);
  const agentsCompatibility = /\*\*(\d+) compatibility cases\*\*/.exec(agentsDoc);
  const readmeCompatibility = /currently \*\*(\d+) cases\*\*/.exec(readmeDoc);

  check(
    'I25',
    'the-documented-self-test-and-compatibility-totals-match-a-measured-run-in-BOTH-documents',
    agentsSelfTest !== null &&
      readmeSelfTest !== null &&
      agentsCompatibility !== null &&
      readmeCompatibility !== null &&
      Number(agentsSelfTest[1]) === expectedAssertions &&
      Number(agentsSelfTest[2]) === expectedInvariants &&
      Number(readmeSelfTest[1]) === expectedAssertions &&
      Number(readmeSelfTest[2]) === expectedInvariants &&
      Number(agentsCompatibility[1]) === compatibilityTotal &&
      Number(readmeCompatibility[1]) === compatibilityTotal &&
      // The rule itself, verbatim, in both places: the numbers are read off the run.
      /read the numbers off the run instead of trusting a remembered literal/.test(agentsDoc) &&
      /Both counts are computed, never asserted against a fixed value/.test(readmeDoc),
    `expected assertions=${expectedAssertions} invariants=${expectedInvariants} compatibility=${compatibilityTotal}; ` +
      `AGENTS.md=${JSON.stringify(agentsSelfTest?.slice(1))} compat=${agentsCompatibility?.[1]}; ` +
      `README=${JSON.stringify(readmeSelfTest?.slice(1))} compat=${readmeCompatibility?.[1]}`,
  );

  // The SEPARATE, WEAKER property, enforced here because the totals check above is a consistency check and cannot be a
  // monotonicity check: it compares the documents to the run, so a suite that SHRANK and a document edited to match
  // would both be green together. This conjunct is the one that says a reduction needs a deliberate, commented move of
  // the floor.
  check(
    'I25',
    'the-measured-totals-are-AT-OR-ABOVE-the-recorded-monotonicity-floor-in-every-count',
    expectedAssertions >= ASSERTION_FLOOR.assertions &&
      expectedInvariants >= ASSERTION_FLOOR.invariants &&
      compatibilityTotal >= ASSERTION_FLOOR.compatibility,
    `floor=${JSON.stringify(ASSERTION_FLOOR)} measured=${JSON.stringify({ assertions: expectedAssertions, invariants: expectedInvariants, compatibility: compatibilityTotal })} ` +
      'note=a-reduction-below-the-floor-goes-red-here-and-can-only-be-made-green-by-a-deliberate-commented-move-of-ASSERTION_FLOOR ' +
      'note2=this-cannot-catch-a-deletion-made-to-PRESERVE-a-documented-number-by-editing-the-prose',
  );

  // ---- report
  const failed = results.filter((entry) => !entry.passed);
  const byInvariant = [...new Set(results.map((entry) => entry.invariant))].sort();

  process.stdout.write('\nFinal harness control-plane self-tests, Structural, durable-state, and compatibility behavior (hermetic, no Zoo runtime)\n\n');

  for (const invariant of byInvariant) {
    const entries = results.filter((entry) => entry.invariant === invariant);
    const ok = entries.every((entry) => entry.passed);

    process.stdout.write(
      `  ${ok ? 'PASS' : 'FAIL'}  ${invariant}  (${entries.filter((e) => e.passed).length}/${entries.length})\n`,
    );

    for (const entry of entries.filter((e) => !e.passed)) {
      process.stdout.write(`        x ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}\n`);
    }
  }

  process.stdout.write(
    `\n  assertions: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}\n` +
      `  invariants: ${byInvariant.length}\n` +
      `  result: ${failed.length === 0 ? 'PASS' : 'FAIL'}\n`,
  );

  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = spawnSync(process.execPath, [join(RUNTIME_DIR, 'harness.mjs'), 'self-test'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
