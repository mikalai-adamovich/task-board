/**
 * Durable-state behavior (Stage 1 of the Evaluator state roadmap) — verification state and evidence.
 *
 * Two jobs, both deterministic and free of runtime dependencies so the self-tests can exercise them directly:
 *
 *   1. `classifyLedgerStatus` — the single place that decides a ledger status from a run's evidence. It holds the two
 *      fail-closed invariants of Stage 1:
 *        INVARIANT A  an acceptance verdict may not be `pass` while a required criterion lacks a discriminating
 *                     evaluation (uncovered or errored), and the run must land in a non-success state (`blocked`).
 *        INVARIANT B  a verifier verdict is evidence, never authority: `PASS` cannot promote a run, `FAIL` cannot be
 *                     ignored, and a verdict whose artifact changed is not usable.
 *   2. `compactVerifier` / `deriveBlockers` — turn a verifier report and a coverage object into compact, transcript-free
 *      records for the ledger and the run event stream.
 *
 * Nothing here reads files, spawns processes or knows about the CLI: it is pure state/evidence handling.
 */

/** Verdict vocabulary. `PASS`/`FAIL` are judgements; `BLOCKED` means the verifier could not decide. */
export const VERIFIER_VERDICTS = ['PASS', 'FAIL', 'BLOCKED'];

/** Artifact integrity is a detective observation, never a guarantee. */
export const ARTIFACT_INTEGRITY_STATES = ['UNCHANGED', 'CHANGED', 'UNKNOWN'];

/**
 * Integrity and human-acceptance behavior (INTEGRITY-PROVENANCE, 14B §3 C1/C2): how an integrity observation was produced.
 *   `computed` — a digest over a named scope (C2, measured evidence)
 *   `declared` — supplied by a role/operator without one (C1, recorded operator trust)
 * The default is `declared`, never `computed`: a record may only claim measurement when it says so.
 */
export const ARTIFACT_INTEGRITY_KINDS = ['computed', 'declared'];

/** Where the verifier evidence came from — recorded so a reader can weigh it. */
export const VERIFIER_SOURCES = ['handoff', 'flags', 'none'];

/**
 * Handoff statuses (Structural behavior `handoff.mjs`) carry a role's own vocabulary; the verdict is the Evaluator state field.
 * The mapping is total for the verifier statuses and null for statuses that say nothing about acceptance.
 */
export const HANDOFF_STATUS_TO_VERDICT = {
  SATISFIES: 'PASS',
  DEFECTIVE: 'FAIL',
  UNCERTAIN: 'BLOCKED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAIL',
  WORK_COMPLETE: null,
  VERIFICATION_PENDING: null,
  UNANSWERED: null,
};

/** True when a coverage object reports criteria that no discriminating predicate evaluated. */
export function isCoverageIncomplete(coverage) {
  if (coverage === null || coverage === undefined) {
    return false;
  }

  const uncovered = Array.isArray(coverage.uncovered_criteria) ? coverage.uncovered_criteria.length : 0;
  const errored = Array.isArray(coverage.errored) ? coverage.errored.length : 0;

  return uncovered > 0 || errored > 0;
}

/**
 * True when the ledger still records an artifact-integrity blocker.
 *
 * Recorded clearances are currently ignored by this predicate. A current `UNCHANGED` can normalise the veto for that
 * invocation and append a clearance record, but the persisted blocker remains and blocks a later omission.
 */
export function hasUnresolvedIntegrityBlocker(ledger) {
  return (ledger?.blockers ?? []).some((blocker) => blocker.kind === 'artifact_integrity_changed');
}

/**
 * Integrity and human-acceptance behavior (INTEGRITY-CLEARANCE, 14B §3 rule I4): a recorded integrity block is cleared only by evidence, and the ledger must
 * record WHICH kind of evidence cleared it, so a reader never mistakes recorded operator trust for measurement.
 * Returns the clearance entry to append, or null when there is nothing to clear.
 */
export function integrityClearance({ ledger, verifier, at, runId }) {
  if (!hasUnresolvedIntegrityBlocker(ledger)) {
    return null;
  }

  if (verifier === null || verifier === undefined || verifier.artifact_integrity !== 'UNCHANGED') {
    return null;
  }

  return {
    at,
    run_id: runId,
    cleared_by: ARTIFACT_INTEGRITY_KINDS.includes(verifier.artifact_integrity_kind)
      ? verifier.artifact_integrity_kind
      : 'declared',
    basis: typeof verifier.artifact_integrity_basis === 'string' ? verifier.artifact_integrity_basis : null,
    clears_kind: 'artifact_integrity_changed',
  };
}

/**
 * Decide the ledger status from current-run facts only.
 *
 * The destructured signature is deliberately closed. Persisted ledgers, reports, runs, transitions, state/options
 * objects, and rest/spread parameters cannot cross this boundary. `integrityVeto` is the one normalized projection of
 * durable state: an unresolved incident on the same selected ledger can veto success, but it can never promote.
 *
 * Precedence preserves the existing fail-closed behavior: verifier FAIL and artifact CHANGED remain adverse even when
 * the gate was not run; a failed gate is `failed`; an unresolved veto blocks a would-be success; coverage incompleteness
 * blocks; only current gate pass plus current acceptance pass can reach `verified`.
 */
export function classifyLedgerStatus({ gateResult, acceptance, acceptanceCoverage, verifier, integrityVeto }) {
  if (verifier !== null && verifier.verdict === 'FAIL') {
    return 'failed';
  }

  if (verifier !== null && verifier.artifact_integrity === 'CHANGED') {
    return 'blocked';
  }

  if (gateResult === 'incompatible') {
    return 'blocked';
  }

  if (
    gateResult === 'not_run' &&
    !(verifier !== null && (verifier.verdict === 'FAIL' || verifier.artifact_integrity === 'CHANGED'))
  ) {
    throw new Error('terminal classification requires a current gate result or adverse current verifier evidence');
  }

  if (gateResult === 'fail') {
    return 'failed';
  }

  if (integrityVeto === 'unresolved') {
    return 'blocked';
  }

  if (integrityVeto !== 'none' && integrityVeto !== 'cleared_by_current_unchanged') {
    throw new Error(`invalid normalized integrity veto: ${integrityVeto}`);
  }

  if (acceptance === 'fail') {
    return 'failed';
  }

  if (isCoverageIncomplete(acceptanceCoverage)) {
    return 'blocked';
  }

  if (acceptance === 'pass') {
    return 'verified';
  }

  return 'verification_pending';
}

/**
 * Compact verifier evidence for durable state. Transcripts are structurally impossible here: only named, bounded
 * fields are copied, list lengths are capped and every string is truncated. `artifact_integrity` is preserved exactly,
 * including `UNKNOWN` — a missing observation is never upgraded to a clean one.
 */
export function compactVerifier({
  verdict,
  findings = [],
  criteriaChecked = [],
  evidence = [],
  artifactIntegrity = 'UNKNOWN',
  artifactIntegrityBasis = null,
  artifactIntegrityKind = null,
  source = 'flags',
  at = new Date().toISOString(),
  runId = null,
} = {}) {
  const strings = (list, cap) =>
    (Array.isArray(list) ? list : [])
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .slice(0, cap)
      .map((entry) => entry.slice(0, 400));
  const findingList = (Array.isArray(findings) ? findings : []).slice(0, 10).map((finding) => {
    if (typeof finding === 'string') {
      return { text: finding.slice(0, 400) };
    }

    return {
      requirement: typeof finding?.requirement === 'string' ? finding.requirement.slice(0, 200) : null,
      mechanism: typeof finding?.mechanism === 'string' ? finding.mechanism.slice(0, 200) : null,
      evidence: typeof finding?.evidence === 'string' ? finding.evidence.slice(0, 200) : null,
    };
  });

  return {
    at,
    run_id: runId,
    source: VERIFIER_SOURCES.includes(source) ? source : 'flags',
    verdict: VERIFIER_VERDICTS.includes(verdict) ? verdict : 'BLOCKED',
    artifact_integrity: ARTIFACT_INTEGRITY_STATES.includes(artifactIntegrity) ? artifactIntegrity : 'UNKNOWN',
    // Integrity and human-acceptance behavior (INTEGRITY-PROVENANCE): provenance of the integrity observation. `kind` never defaults to `computed`, and the basis
    // is one bounded line describing who/how — so recorded operator trust can never be read as measurement.
    artifact_integrity_basis:
      typeof artifactIntegrityBasis === 'string' && artifactIntegrityBasis.trim() !== ''
        ? artifactIntegrityBasis.slice(0, 400)
        : null,
    artifact_integrity_kind: ARTIFACT_INTEGRITY_KINDS.includes(artifactIntegrityKind)
      ? artifactIntegrityKind
      : 'declared',
    criteria_checked: strings(criteriaChecked, 20),
    findings: findingList,
    evidence: strings(evidence, 10),
    authority: 'advisory: the evaluator owns terminal state; FAIL forces failed, PASS cannot promote',
  };
}

/**
 * Blockers for a non-success status that the evaluator decided. Each entry names the cause, so `blocked` always carries
 * a concrete reason a human can act on. Only evaluator-decided causes are listed here; a gate incompatibility is already
 * recorded on `ledger.gate.compatibility` and `failures[]`.
 */
export function deriveBlockers({ status, acceptanceCoverage = null, verifier = null, at, runId }) {
  if (status !== 'blocked') {
    return [];
  }

  const blockers = [];

  if (verifier !== null && verifier.artifact_integrity === 'CHANGED') {
    blockers.push({
      at,
      kind: 'artifact_integrity_changed',
      source: 'evaluator',
      text: 'the verifier reported artifact_integrity=CHANGED: the artifact it judged is not the artifact that was produced, so its verdict is not usable',
      run_id: runId,
    });
  }

  if (isCoverageIncomplete(acceptanceCoverage)) {
    blockers.push({
      at,
      kind: 'acceptance_coverage_incomplete',
      source: 'evaluator',
      text: `no discriminating predicate evaluated acceptance criterion/criteria ${[
        ...(acceptanceCoverage.uncovered_criteria ?? []),
      ].join(
        ', ',
      )}${(acceptanceCoverage.errored ?? []).length > 0 ? `, and ${(acceptanceCoverage.errored ?? []).length} predicate(s) could not decide` : ''}: a human must judge them before this task can be verified`,
      run_id: runId,
    });
  }

  return blockers;
}
