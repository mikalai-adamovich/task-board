/**
 * Structural behavior — structured handoff contract.
 *
 * Runtime telemetry (C13) established that the runtime has no structured subagent return: the child's only channel is
 * free text. This module makes the repository-side contract explicit and checkable, so a parent can ask for a
 * shape and the evaluator can reject a transcript dressed up as a handoff.
 *
 * It is a CONSTRAINT on text, not a runtime feature: nothing here prevents a child from returning prose.
 */

export const HANDOFF_ROLES = ['explorer', 'executor', 'verifier'];
export const HANDOFF_STATUSES = [
  'WORK_COMPLETE',
  'VERIFICATION_PENDING',
  'FAILED',
  'BLOCKED',
  'UNANSWERED',
  'SATISFIES',
  'DEFECTIVE',
  'UNCERTAIN',
];

/**
 * Durable-state behavior — verifier evidence fields.
 *
 * A verifier's return must carry a verdict and an artifact-integrity observation, because a bare status word cannot
 * distinguish "the artifact satisfies the specification" from "I could not decide", and because a verdict about an
 * artifact that changed underneath the verifier is not usable evidence. These fields are REQUIRED for the `verifier`
 * role only; executor and explorer handoffs are unchanged (an additive schema change, Evaluator state Stage 1).
 */
export const HANDOFF_VERDICTS = ['PASS', 'FAIL', 'BLOCKED'];
export const ARTIFACT_INTEGRITY = ['UNCHANGED', 'CHANGED', 'UNKNOWN'];

/** Keys that would let a transcript smuggle itself into the parent's context. */
const FORBIDDEN_KEYS = ['transcript', 'messages', 'conversation', 'raw', 'raw_output', 'content', 'reasoning'];

export const HANDOFF_MAX_BYTES = 8192;
const LIST_CAPS = { completed: 10, pending: 10, findings: 10, claims: 10, verification_needed: 10, blockers: 10 };
const FIELD_MAX_CHARS = 400;

/** A valid, empty handoff: a child fills it in rather than repairing placeholders. */
export function handoffTemplate() {
  return {
    task_id: 'TASK_ID',
    role: 'executor',
    run_id: null,
    status: 'WORK_COMPLETE',
    completed: [],
    pending: [],
    findings: [],
    changed_files: [],
    claims: [],
    verification_needed: [],
    blockers: [],
    artifact: null,
    // Durable-state behavior — verifier evidence (required only when role === 'verifier').
    verdict: null,
    criteria_checked: [],
    artifact_integrity: null,
  };
}

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Validate a parsed handoff object. Returns { ok, problems }. */
export function validateHandoff(handoff) {
  const problems = [];

  if (handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return { ok: false, problems: ['handoff must be a JSON object'] };
  }

  for (const key of Object.keys(handoff)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      problems.push(`field "${key}" is forbidden: transcripts do not belong in a handoff`);
    }
    if (!Object.hasOwn(handoffTemplate(), key)) {
      problems.push(`unknown field "${key}" (allowed: ${Object.keys(handoffTemplate()).join(', ')})`);
    }
  }

  if (typeof handoff.task_id !== 'string' || handoff.task_id === '') {
    problems.push('"task_id" is required');
  }

  if (!HANDOFF_ROLES.includes(handoff.role)) {
    problems.push(`"role" must be one of: ${HANDOFF_ROLES.join(', ')}`);
  }

  if (!HANDOFF_STATUSES.includes(handoff.status)) {
    problems.push(`"status" must be one of: ${HANDOFF_STATUSES.join(', ')}`);
  }

  if (handoff.run_id !== undefined && handoff.run_id !== null && typeof handoff.run_id !== 'string') {
    problems.push('"run_id" must be a string or null');
  }

  for (const [field, cap] of Object.entries(LIST_CAPS)) {
    const value = handoff[field];

    if (value === undefined) {
      continue;
    }

    if (!isStringList(value)) {
      problems.push(`"${field}" must be a list of strings`);
      continue;
    }

    if (value.length > cap) {
      problems.push(`"${field}" has ${value.length} entries (max ${cap}) — summarise instead of listing everything`);
    }

    for (const item of value) {
      if (item.length > FIELD_MAX_CHARS) {
        problems.push(`"${field}" contains an entry of ${item.length} chars (max ${FIELD_MAX_CHARS})`);
      }
    }
  }

  if (!isStringList(handoff.changed_files ?? [])) {
    problems.push('"changed_files" must be a list of strings');
  }

  if (handoff.artifact !== undefined && handoff.artifact !== null && typeof handoff.artifact !== 'string') {
    problems.push('"artifact" must be a path string or null');
  }

  // Durable-state behavior — verifier evidence. Required for the verifier role; validated for any role that supplies it.
  if (handoff.verdict !== undefined && handoff.verdict !== null && !HANDOFF_VERDICTS.includes(handoff.verdict)) {
    problems.push(`"verdict" must be one of: ${HANDOFF_VERDICTS.join(', ')}`);
  }

  if (
    handoff.artifact_integrity !== undefined &&
    handoff.artifact_integrity !== null &&
    !ARTIFACT_INTEGRITY.includes(handoff.artifact_integrity)
  ) {
    problems.push(`"artifact_integrity" must be one of: ${ARTIFACT_INTEGRITY.join(', ')}`);
  }

  if (handoff.criteria_checked !== undefined && !isStringList(handoff.criteria_checked)) {
    problems.push('"criteria_checked" must be a list of strings');
  }

  if (handoff.role === 'verifier') {
    if (!HANDOFF_VERDICTS.includes(handoff.verdict)) {
      problems.push('a verifier handoff must carry "verdict" (PASS | FAIL | BLOCKED)');
    }

    if (!ARTIFACT_INTEGRITY.includes(handoff.artifact_integrity)) {
      problems.push('a verifier handoff must carry "artifact_integrity" (UNCHANGED | CHANGED | UNKNOWN)');
    }
  }

  // A verifier verdict must carry evidence; a work report must not pretend to be a verdict.
  if (['SATISFIES', 'DEFECTIVE', 'UNCERTAIN'].includes(handoff.status) && handoff.role !== 'verifier') {
    problems.push(`status "${handoff.status}" is only valid for role "verifier"`);
  }

  if (handoff.role === 'verifier' && handoff.status === 'DEFECTIVE' && (handoff.findings ?? []).length === 0) {
    problems.push('a DEFECTIVE verdict must include at least one finding');
  }

  return { ok: problems.length === 0, problems };
}

/** Validate a serialised handoff (enforces the size cap before parsing). */
export function validateHandoffText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');

  if (bytes > HANDOFF_MAX_BYTES) {
    return { ok: false, problems: [`handoff is ${bytes} bytes (max ${HANDOFF_MAX_BYTES})`] };
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`handoff is not valid JSON: ${error.message}`] };
  }

  return validateHandoff(parsed);
}
